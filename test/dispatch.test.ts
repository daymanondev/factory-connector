import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  createCommitBundle,
  stageFleetRefFromBundle,
  landFleetRef,
} from "../src/git-sync.ts";
import type { FleetState, FleetNodeState } from "../src/fleet.ts";
import {
  receiveHandoff,
  loadHandoff,
  handoffRecordPath,
  type DetachedSpawn,
  type HandoffRecord,
} from "../src/dispatch.ts";

const execFileAsync = promisify(execFile);

/** Runs real `git` against a fixture checkout (tests may drive git directly). */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.toString();
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `factory-connector-${prefix}-`));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeTempHome(prefix: string): string {
  return makeTempDir(`${prefix}-home`);
}

async function initRepo(dir: string, branch = "main"): Promise<string> {
  await execFileAsync("git", ["init", "-q", "-b", branch, dir]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "connector@test.example"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "Connector Test"]);
  return dir;
}

async function commitAll(repo: string, message: string): Promise<string> {
  await execFileAsync("git", ["-C", repo, "add", "-A"]);
  await execFileAsync("git", ["-C", repo, "commit", "-qm", message]);
  return (await git(repo, "rev-parse", "HEAD")).trim();
}

/**
 * Initiating `Project` fixture: a base commit, a `.worktreeinclude`-listed
 * untracked `.env`, and one commit on top (the `<base>..HEAD` handoff range).
 */
async function makeProjectWithInclude(): Promise<{
  repo: string;
  base: string;
  head: string;
}> {
  const repo = await initRepo(join(makeTempDir("dispatch-project"), "proj"));
  writeFileSync(join(repo, "playbook.txt"), "v1\n", "utf8");
  const base = await commitAll(repo, "base");
  writeFileSync(join(repo, "playbook.txt"), "v2\n", "utf8");
  writeFileSync(join(repo, ".gitignore"), ".env\n", "utf8");
  writeFileSync(join(repo, ".worktreeinclude"), ".env\n", "utf8");
  writeFileSync(join(repo, ".env"), "TOKEN=hush\n", "utf8");
  const head = await commitAll(repo, "head");
  return { repo, base, head };
}

/** Stub `DetachedSpawn` that records every spawn without running anything. */
function recordingSpawn(): { spawns: Array<{ cwd: string; command: string; logPath: string }>; spawn: DetachedSpawn } {
  const spawns: Array<{ cwd: string; command: string; logPath: string }> = [];
  return {
    spawns,
    spawn: {
      async spawn(options) {
        spawns.push(options);
        return { pid: "31337" };
      },
    },
  };
}

describe("receiveHandoff (target Node side)", () => {
  it("provisions the mirror from the inbox bundle, extracts includes, spawns the detached run, and records the inbound job", async () => {
    const { repo, base, head } = await makeProjectWithInclude();
    const stagingDir = join(makeTempDir("dispatch-inbox-initiator"), "ho-9");
    const bundle = await createCommitBundle({
      repoPath: repo,
      base,
      outPath: join(stagingDir, "commit.bundle"),
    });
    assert.ok(bundle.includeTarPath, "fixture must carry a .worktreeinclude payload");

    // Inbox on the target Node: exactly what dispatchHandoff's transport delivers.
    const targetHome = makeTempHome("dispatch-target");
    const inboxDir = join(targetHome, "connector", "inbox", "ho-9");
    mkdirSync(inboxDir, { recursive: true });
    copyFileSync(bundle.bundlePath, join(inboxDir, basename(bundle.bundlePath)));
    copyFileSync(bundle.includeTarPath, join(inboxDir, basename(bundle.includeTarPath)));
    const manifest: HandoffRecord = {
      version: 1,
      handoffId: "ho-9",
      direction: "outbound",
      sourceNodeId: "laptop",
      targetNodeId: "studio-a",
      runOrTaskId: "run-42",
      kind: "burn-run",
      status: "dispatched",
      brief: { command: "npx burn run --playbook probe", playbook: "probe", prompt: null },
      canonicalSlug: "my-proj",
      bundle: {
        fileName: basename(bundle.bundlePath),
        includeTarFileName: basename(bundle.includeTarPath),
        baseCommit: bundle.baseCommit,
        headCommit: bundle.headCommit,
        branch: bundle.branch,
      },
      expectedFleetRef: "refs/fleet/studio-a/run-42",
      mirrorPath: null,
      pid: null,
      logPath: null,
      dispatchedAt: "2026-10-17T10:00:00.000Z",
      startedAt: null,
      updatedAt: "2026-10-17T10:00:00.000Z",
      error: null,
    };
    const manifestPath = join(inboxDir, "handoff.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const { spawns, spawn } = recordingSpawn();
    const startedAt = new Date("2026-10-17T10:00:05.000Z");
    const record = await receiveHandoff({
      paseoHome: targetHome,
      manifestPath,
      spawn,
      now: () => startedAt,
    });

    // The mirror repo was provisioned from the bundle at the expected commit.
    const mirrorPath = join(targetHome, "connector", "repos", "my-proj");
    assert.equal(record.direction, "inbound");
    assert.equal(record.status, "running");
    assert.equal(record.mirrorPath, mirrorPath);
    assert.equal(record.pid, "31337");
    assert.equal(record.logPath, join(targetHome, "connector", "handoffs", "ho-9.log"));
    assert.equal(record.startedAt, startedAt.toISOString());
    assert.equal((await git(mirrorPath, "rev-parse", "HEAD")).trim(), head);
    // `.worktreeinclude` payload extracted over the mirror (OS-native checkout keeps env/secrets).
    assert.equal(readFileSync(join(mirrorPath, ".env"), "utf8"), "TOKEN=hush\n");

    // The detached run was spawned inside the mirror with the brief's command.
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].cwd, mirrorPath);
    assert.equal(spawns[0].command, "npx burn run --playbook probe");
    assert.equal(spawns[0].logPath, join(targetHome, "connector", "handoffs", "ho-9.log"));

    // The inbound record is on disk for the target's own reconciliation.
    assert.deepEqual(loadHandoff(targetHome, "ho-9"), record);
    assert.equal(existsSync(handoffRecordPath(targetHome, "ho-9")), true);
  });

  it("refuses a manifest that is missing or not JSON, naming the path", async () => {
    const targetHome = makeTempHome("dispatch-target");
    const inboxDir = join(targetHome, "connector", "inbox", "ho-bad");
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(join(inboxDir, "handoff.json"), "{ not json", "utf8");

    await assert.rejects(
      () => receiveHandoff({ paseoHome: targetHome, manifestPath: join(inboxDir, "handoff.json") }),
      /handoff\.json/,
    );
    await assert.rejects(
      () => receiveHandoff({ paseoHome: targetHome, manifestPath: join(inboxDir, "missing.json") }),
      /missing\.json/,
    );
  });
});
