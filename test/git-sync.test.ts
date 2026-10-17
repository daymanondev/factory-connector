import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createCommitBundle,
  ensureMirrorRepoFromBundle,
  mirrorRepoPath,
  fleetRef,
  fleetRefBranch,
  stageFleetRefFromBundle,
  landFleetRef,
  reconcileGossipSync,
  createSshGossipTransport,
  freePoolArtifactPath,
  burnRunsDirPath,
  type GossipArtifactTransport,
  type GossipPeerDigest,
} from "../src/git-sync.ts";
import type { FleetNode, FleetPulse } from "../src/fleet.ts";

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

/** Initiating repo: base commit, then two commits on top (the base..HEAD range). */
async function makeInitiatorWithRange(): Promise<{
  repo: string;
  base: string;
  head: string;
}> {
  const repo = await initRepo(join(makeTempDir("git-sync-initiator"), "proj"));
  writeFileSync(join(repo, "file.txt"), "one\n", "utf8");
  await commitAll(repo, "one");
  const base = (await git(repo, "rev-parse", "HEAD")).trim();
  writeFileSync(join(repo, "file.txt"), "two\n", "utf8");
  await commitAll(repo, "two");
  writeFileSync(join(repo, "file.txt"), "three\n", "utf8");
  const head = await commitAll(repo, "three");
  return { repo, base, head };
}

describe("createCommitBundle (base..HEAD + .worktreeinclude packaging)", () => {
  it("packages the base..HEAD range into a bundle that provisions a fresh clone", async () => {
    const { repo, base, head } = await makeInitiatorWithRange();
    const outDir = makeTempDir("git-sync-bundle");
    const bundlePath = join(outDir, "commit.bundle");

    const result = await createCommitBundle({ repoPath: repo, base, outPath: bundlePath });

    assert.equal(result.baseCommit, base);
    assert.equal(result.headCommit, head);
    assert.equal(result.branch, "main");
    assert.equal(existsSync(bundlePath), true);
    assert.equal(result.includeTarPath, null);

    // Self-contained: a fresh clone from the bundle lands on the branch with
    // the full range present (git refuses thin bundles here otherwise).
    const cloneDir = join(outDir, "clone");
    await execFileAsync("git", ["clone", "-q", bundlePath, cloneDir]);
    assert.equal((await git(cloneDir, "rev-parse", "HEAD")).trim(), head);
    assert.equal((await git(cloneDir, "rev-parse", "--abbrev-ref", "HEAD")).trim(), "main");
    assert.equal((await git(cloneDir, "rev-list", "--count", "HEAD")).trim(), "3");
    assert.equal(readFileSync(join(cloneDir, "file.txt"), "utf8"), "three\n");
  });

  it("packages .worktreeinclude-listed untracked files into a sibling tar", async () => {
    const { repo, base } = await makeInitiatorWithRange();
    writeFileSync(join(repo, ".gitignore"), ".env\nsecrets/\n", "utf8");
    writeFileSync(join(repo, ".worktreeinclude"), ".env\nsecrets/*\n", "utf8");
    writeFileSync(join(repo, ".env"), "TOKEN=hush\n", "utf8");
    mkdirSync(join(repo, "secrets"));
    writeFileSync(join(repo, "secrets", "stage.pem"), "-----KEY-----\n", "utf8");
    await commitAll(repo, "track the include list");

    const outDir = makeTempDir("git-sync-bundle");
    const bundlePath = join(outDir, "commit.bundle");
    const result = await createCommitBundle({ repoPath: repo, base, outPath: bundlePath });

    assert.ok(result.includeTarPath, "include tar should exist");
    assert.equal(existsSync(result.includeTarPath), true);

    const extractDir = join(outDir, "include-extracted");
    mkdirSync(extractDir);
    await execFileAsync("tar", ["-xzf", result.includeTarPath, "-C", extractDir]);
    assert.equal(readFileSync(join(extractDir, ".env"), "utf8"), "TOKEN=hush\n");
    assert.equal(readFileSync(join(extractDir, "secrets", "stage.pem"), "utf8"), "-----KEY-----\n");
  });

  it("rejects a base that is not an ancestor of HEAD", async () => {
    const { repo, base } = await makeInitiatorWithRange();
    // Diverge: a sibling commit not on HEAD's history.
    await execFileAsync("git", ["-C", repo, "checkout", "-q", "-b", "side", base]);
    writeFileSync(join(repo, "file.txt"), "side\n", "utf8");
    const sideHead = await commitAll(repo, "side");
    await execFileAsync("git", ["-C", repo, "checkout", "-q", "main"]);

    const outDir = makeTempDir("git-sync-bundle");
    await assert.rejects(
      () => createCommitBundle({ repoPath: repo, base: sideHead, outPath: join(outDir, "x.bundle") }),
      /ancestor/,
    );
  });
});

describe("ensureMirrorRepoFromBundle (<paseoHome>/connector/repos/<canonical-slug>)", () => {
  async function bundledInitiator(): Promise<{
    home: string;
    repo: string;
    base: string;
    bundlePath: string;
    includeTarPath: string | null;
    head: string;
  }> {
    const { repo, base } = await makeInitiatorWithRange();
    writeFileSync(join(repo, ".gitignore"), ".env\n", "utf8");
    writeFileSync(join(repo, ".worktreeinclude"), ".env\n", "utf8");
    writeFileSync(join(repo, ".env"), "TOKEN=hush\n", "utf8");
    const head = await commitAll(repo, "track the include list");
    const outDir = makeTempDir("git-sync-bundle");
    const bundlePath = join(outDir, "commit.bundle");
    const result = await createCommitBundle({ repoPath: repo, base, outPath: bundlePath });
    return {
      home: makeTempDir("git-sync-home"),
      repo,
      base,
      bundlePath,
      includeTarPath: result.includeTarPath,
      head,
    };
  }

  it("provisions a fresh Mirror repo from the bundle and restores include files", async () => {
    const ctx = await bundledInitiator();

    const result = await ensureMirrorRepoFromBundle({
      paseoHome: ctx.home,
      canonicalSlug: "demo-app",
      bundlePath: ctx.bundlePath,
      includeTarPath: ctx.includeTarPath,
    });

    const expectedPath = join(ctx.home, "connector", "repos", "demo-app");
    assert.equal(result.mirrorPath, expectedPath);
    assert.equal(result.created, true);
    assert.equal((await git(expectedPath, "rev-parse", "HEAD")).trim(), ctx.head);
    assert.equal(result.headCommit, ctx.head);
    assert.equal(result.branch, "main");
    // The operator never cloned anything: files are checked out, include files restored.
    assert.equal(readFileSync(join(expectedPath, "file.txt"), "utf8"), "three\n");
    assert.equal(readFileSync(join(expectedPath, ".env"), "utf8"), "TOKEN=hush\n");
    // No stale remote pointing at the (temp) bundle the mirror was cloned from.
    assert.equal((await git(expectedPath, "remote")).trim(), "");
  });

  it("fast-forward-updates an existing Mirror repo from a newer bundle without re-cloning", async () => {
    const ctx = await bundledInitiator();

    const first = await ensureMirrorRepoFromBundle({
      paseoHome: ctx.home,
      canonicalSlug: "demo-app",
      bundlePath: ctx.bundlePath,
      includeTarPath: ctx.includeTarPath,
    });
    assert.equal(first.created, true);

    // Initiator advances one more commit inside the base..HEAD range.
    writeFileSync(join(ctx.repo, "file.txt"), "four\n", "utf8");
    const newHead = await commitAll(ctx.repo, "four");
    const outDir2 = makeTempDir("git-sync-bundle2");
    const bundle2 = join(outDir2, "update.bundle");
    await createCommitBundle({ repoPath: ctx.repo, base: ctx.base, outPath: bundle2 });

    const second = await ensureMirrorRepoFromBundle({
      paseoHome: ctx.home,
      canonicalSlug: "demo-app",
      bundlePath: bundle2,
    });

    assert.equal(second.created, false);
    assert.equal(second.mirrorPath, first.mirrorPath);
    assert.equal(second.headCommit, newHead);
    assert.equal(readFileSync(join(second.mirrorPath, "file.txt"), "utf8"), "four\n");
  });

  it("rejects canonical slugs that could escape the repos/ directory", async () => {
    const ctx = await bundledInitiator();
    for (const slug of ["../escape", "a/b", "", ".hidden-start"]) {
      await assert.rejects(
        () =>
          ensureMirrorRepoFromBundle({
            paseoHome: ctx.home,
            canonicalSlug: slug,
            bundlePath: ctx.bundlePath,
          }),
        /slug/,
      );
    }
    assert.equal(existsSync(join(ctx.home, "connector", "repos", "..")), false);
  });

  it("mirrorRepoPath nests under <paseoHome>/connector/repos/", () => {
    const home = makeTempDir("git-sync-home");
    assert.equal(
      mirrorRepoPath(home, "demo-app"),
      join(home, "connector", "repos", "demo-app"),
    );
  });
});

describe("stageFleetRefFromBundle (refs/fleet/<nodeId>/<runOrTaskId>)", () => {
  /**
   * The handoff round-trip in miniature: an initiator repo checked out at
   * `base` with a dirty working tree and staged index, plus a peer's thin
   * completion bundle carrying only the `base..HEAD` range the peer produced.
   */
  async function initiatorAwaitingPeerWork(): Promise<{
    repo: string;
    base: string;
    peerHead: string;
    bundlePath: string;
  }> {
    const { repo, base } = await makeInitiatorWithRange();
    // Roll the initiator back to base and dirty it, as an active workspace would be.
    await execFileAsync("git", ["-C", repo, "reset", "-q", "--hard", base]);
    writeFileSync(join(repo, "notes.md"), "operator's uncommitted notes\n", "utf8");
    writeFileSync(join(repo, "staged.txt"), "staged but uncommitted\n", "utf8");
    await execFileAsync("git", ["-C", repo, "add", "staged.txt"]);

    // The peer: starts from base, completes the run's commits.
    const peerDir = join(makeTempDir("git-sync-peer"), "peer");
    await execFileAsync("git", ["clone", "-q", repo, peerDir]);
    await execFileAsync("git", ["-C", peerDir, "reset", "-q", "--hard", base]);
    writeFileSync(join(peerDir, "file.txt"), "peer result\n", "utf8");
    writeFileSync(join(peerDir, "result.md"), "# peer report\n", "utf8");
    const peerHead = await commitAll(peerDir, "peer completed the run");

    // A thin base..HEAD completion bundle — exactly what a peer sends back.
    const bundlePath = join(makeTempDir("git-sync-peer-bundle"), "attempt.bundle");
    await execFileAsync("git", [
      "-C",
      peerDir,
      "bundle",
      "create",
      bundlePath,
      `${base}..HEAD`,
    ]);
    return { repo, base, peerHead, bundlePath };
  }

  it("stages the peer's completed commits under refs/fleet/<nodeId>/<runId> with the working tree and index untouched", async () => {
    const ctx = await initiatorAwaitingPeerWork();
    const statusBefore = (await git(ctx.repo, "status", "--porcelain")).trim();
    const headBefore = (await git(ctx.repo, "rev-parse", "HEAD")).trim();
    const branchBefore = (await git(ctx.repo, "rev-parse", "--abbrev-ref", "HEAD")).trim();

    const staged = await stageFleetRefFromBundle({
      repoPath: ctx.repo,
      bundlePath: ctx.bundlePath,
      nodeId: "mac-studio",
      runOrTaskId: "run-42",
    });

    assert.equal(staged.ref, "refs/fleet/mac-studio/run-42");
    assert.equal(staged.commit, ctx.peerHead);
    assert.equal((await git(ctx.repo, "rev-parse", "refs/fleet/mac-studio/run-42")).trim(), ctx.peerHead);

    // The operator's active workspace is exactly as it was.
    assert.equal((await git(ctx.repo, "status", "--porcelain")).trim(), statusBefore);
    assert.equal((await git(ctx.repo, "rev-parse", "HEAD")).trim(), headBefore);
    assert.equal((await git(ctx.repo, "rev-parse", "--abbrev-ref", "HEAD")).trim(), branchBefore);
    assert.equal(readFileSync(join(ctx.repo, "notes.md"), "utf8"), "operator's uncommitted notes\n");
    assert.equal(readFileSync(join(ctx.repo, "staged.txt"), "utf8"), "staged but uncommitted\n");
    // The staged commits' content is reachable without any checkout.
    assert.equal((await git(ctx.repo, "show", `${ctx.peerHead}:file.txt`)).trim(), "peer result");
  });

  it("re-staging the same ref overwrites it with the peer's newer completion", async () => {
    const ctx = await initiatorAwaitingPeerWork();
    await stageFleetRefFromBundle({
      repoPath: ctx.repo,
      bundlePath: ctx.bundlePath,
      nodeId: "mac-studio",
      runOrTaskId: "run-42",
    });

    // The peer produces a follow-up commit and re-bundles.
    const peerDir = join(makeTempDir("git-sync-peer2"), "peer");
    await execFileAsync("git", ["clone", "-q", ctx.repo, peerDir]);
    await execFileAsync("git", ["-C", peerDir, "fetch", "-q", ctx.bundlePath, "HEAD"]);
    await execFileAsync("git", ["-C", peerDir, "reset", "-q", "--hard", "FETCH_HEAD"]);
    writeFileSync(join(peerDir, "file.txt"), "peer result v2\n", "utf8");
    const newerHead = await commitAll(peerDir, "peer follow-up");
    const bundle2 = join(makeTempDir("git-sync-peer-bundle2"), "attempt2.bundle");
    await execFileAsync("git", ["-C", peerDir, "bundle", "create", bundle2, `${ctx.base}..HEAD`]);

    const restaged = await stageFleetRefFromBundle({
      repoPath: ctx.repo,
      bundlePath: bundle2,
      nodeId: "mac-studio",
      runOrTaskId: "run-42",
    });
    assert.equal(restaged.commit, newerHead);
    assert.equal(
      (await git(ctx.repo, "rev-parse", "refs/fleet/mac-studio/run-42")).trim(),
      newerHead,
    );
  });

  it("rejects node ids and run ids that are not usable inside a git ref", async () => {
    const ctx = await initiatorAwaitingPeerWork();
    for (const bad of [
      { nodeId: "has space", runOrTaskId: "run-42" },
      { nodeId: "mac-studio", runOrTaskId: "a..b" },
      { nodeId: ".leads-with-dot", runOrTaskId: "run-42" },
      { nodeId: "mac-studio", runOrTaskId: "" },
    ]) {
      await assert.rejects(
        () =>
          stageFleetRefFromBundle({
            repoPath: ctx.repo,
            bundlePath: ctx.bundlePath,
            nodeId: bad.nodeId,
            runOrTaskId: bad.runOrTaskId,
          }),
        /ref/,
      );
    }
  });

  it("fleetRef/fleetRefBuild helpers spell the ref and branch namespaces", () => {
    assert.equal(fleetRef("mac-studio", "run-42"), "refs/fleet/mac-studio/run-42");
    assert.equal(fleetRefBranch("mac-studio", "run-42"), "fleet/mac-studio/run-42");
  });
});

describe("landFleetRef (explicit operator Land)", () => {
  /** Initiator at base, clean tree, with the peer's completion already staged. */
  async function stagedFleetRefFixture(): Promise<{
    repo: string;
    base: string;
    peerHead: string;
  }> {
    const { repo, base, peerHead, bundlePath } = await (async () => {
      const root = makeTempDir("git-sync-land");
      const repo = await initRepo(join(root, "proj"));
      writeFileSync(join(repo, "file.txt"), "one\n", "utf8");
      await commitAll(repo, "one");
      const base = (await git(repo, "rev-parse", "HEAD")).trim();

      const peerDir = join(root, "peer");
      await execFileAsync("git", ["clone", "-q", repo, peerDir]);
      writeFileSync(join(peerDir, "file.txt"), "peer result\n", "utf8");
      const peerHead = await commitAll(peerDir, "peer completed the run");

      const bundlePath = join(root, "attempt.bundle");
      await execFileAsync("git", ["-C", peerDir, "bundle", "create", bundlePath, `${base}..HEAD`]);
      return { repo, base, peerHead, bundlePath };
    })();

    await stageFleetRefFromBundle({ repoPath: repo, bundlePath, nodeId: "mac-studio", runOrTaskId: "run-42" });
    return { repo, base, peerHead };
  }

  it("checkout mode materializes and switches to the fleet/<nodeId>/<runId> branch at the ref", async () => {
    const { repo, peerHead } = await stagedFleetRefFixture();

    const landed = await landFleetRef({
      repoPath: repo,
      nodeId: "mac-studio",
      runOrTaskId: "run-42",
      mode: "checkout",
    });

    assert.equal(landed.branch, "fleet/mac-studio/run-42");
    assert.equal(landed.commit, peerHead);
    assert.equal(landed.mode, "checkout");
    assert.equal((await git(repo, "branch", "--show-current")).trim(), "fleet/mac-studio/run-42");
    assert.equal((await git(repo, "rev-parse", "HEAD")).trim(), peerHead);
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "peer result\n");
    // The staged ref itself survives landing.
    assert.equal((await git(repo, "rev-parse", "refs/fleet/mac-studio/run-42")).trim(), peerHead);
  });

  it("merge mode fast-forwards the current branch when it is behind the ref", async () => {
    const { repo, peerHead } = await stagedFleetRefFixture();

    const landed = await landFleetRef({
      repoPath: repo,
      nodeId: "mac-studio",
      runOrTaskId: "run-42",
      mode: "merge",
    });

    assert.equal(landed.mode, "merge");
    assert.equal(landed.commit, peerHead);
    assert.equal((await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).trim(), "main");
    assert.equal((await git(repo, "rev-parse", "HEAD")).trim(), peerHead);
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "peer result\n");
  });

  it("merge mode merges (not fast-forwards) when local history diverged from the ref", async () => {
    const { repo, peerHead } = await stagedFleetRefFixture();
    // Local work continues on main while the peer ran remotely.
    writeFileSync(join(repo, "local.txt"), "local work\n", "utf8");
    await commitAll(repo, "local work");

    const landed = await landFleetRef({
      repoPath: repo,
      nodeId: "mac-studio",
      runOrTaskId: "run-42",
      mode: "merge",
    });

    assert.equal((await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).trim(), "main");
    // A merge commit exists with both parents; landed.commit is the resulting HEAD.
    const head = (await git(repo, "rev-parse", "HEAD")).trim();
    assert.equal(landed.commit, head);
    const parents = (await git(repo, "rev-list", "--parents", "-n", "1", "HEAD")).trim().split(" ");
    assert.equal(parents.length, 3);
    assert.ok(parents.includes(peerHead), "peer head is a merge parent");
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "peer result\n");
    assert.equal(readFileSync(join(repo, "local.txt"), "utf8"), "local work\n");
  });

  it("defaults to checkout mode and refuses to land a ref that was never staged", async () => {
    const { repo } = await stagedFleetRefFixture();
    const landed = await landFleetRef({ repoPath: repo, nodeId: "mac-studio", runOrTaskId: "run-42" });
    assert.equal(landed.mode, "checkout");

    await assert.rejects(
      () => landFleetRef({ repoPath: repo, nodeId: "win-wsl", runOrTaskId: "run-99" }),
      /refs\/fleet\/win-wsl\/run-99/,
    );
  });
});

describe("reconcileGossipSync (last-write-wins Gossip sync)", () => {
  const T0 = "2026-10-17T09:00:00.000Z";
  const T1 = "2026-10-17T10:00:00.000Z";
  const T2 = "2026-10-17T11:00:00.000Z";

  function peerNode(id: string): FleetNode {
    return {
      id,
      name: id,
      posture: "stationary",
      transport: "ssh",
      sshTarget: `ssh://andrew@100.101.102.103`,
      remotePaseoHome: "/home/andrew/.paseo-factory",
      slotCeiling: 2,
      reserveMode: false,
      healthGuard: { maxCpuPercent: 85, minFreeMemMb: 2048 },
    };
  }

  function pulseOf(nodeId: string, stamps: { freePool?: string | null; runs?: string | null }): FleetPulse {
    return {
      nodeId,
      online: true,
      cpuPercent: 10,
      freeMemMb: 8192,
      activeAgents: 0,
      activeBurnRuns: 0,
      meterSummary: null,
      freePoolUpdatedAt: stamps.freePool ?? null,
      runsUpdatedAt: stamps.runs ?? null,
      collectedAt: T2,
    };
  }

  /** Local home holding a free-pool at T1 and one completed run at T1. */
  function gossipHome(): string {
    const home = makeTempDir("git-sync-gossip");
    mkdirSync(join(home, "burn-lab", "runs"), { recursive: true });
    writeFileSync(
      freePoolArtifactPath(home),
      JSON.stringify({ updatedAt: T1, models: [{ id: "local-model" }] }),
      "utf8",
    );
    writeFileSync(
      join(burnRunsDirPath(home), "run-local.json"),
      JSON.stringify({ id: "run-local", updatedAt: T1, status: "completed" }),
      "utf8",
    );
    return home;
  }

  /** In-memory peer: path → content; records every read for assertions. */
  function makeTransport(files: Record<string, string>, runListing: string[]): {
    transport: GossipArtifactTransport;
    reads: string[];
    listed: string[];
  } {
    const reads: string[] = [];
    const listed: string[] = [];
    const transport: GossipArtifactTransport = {
      readFile: async (_node, relativePath) => {
        reads.push(relativePath);
        return files[relativePath] ?? null;
      },
      listFiles: async (_node, relativeDir) => {
        listed.push(relativeDir);
        return runListing;
      },
    };
    return { transport, reads, listed };
  }

  it("pulls a peer's newer free-pool.json (LWW) and leaves older/stale peers alone", async () => {
    const home = gossipHome();
    const newerPool = JSON.stringify({ updatedAt: T2, models: [{ id: "peer-model" }] });
    const { transport, reads } = makeTransport(
      { "burn-lab/free-pool.json": newerPool },
      [],
    );

    const report = await reconcileGossipSync({
      paseoHome: home,
      peers: [
        { node: peerNode("newer-peer"), pulse: pulseOf("newer-peer", { freePool: T2 }) },
        { node: peerNode("older-peer"), pulse: pulseOf("older-peer", { freePool: T0 }) },
        { node: peerNode("no-stamp-peer"), pulse: pulseOf("no-stamp-peer", {}) },
      ],
      transport,
    });

    assert.equal(reads.length, 1);
    assert.equal(reads[0], "burn-lab/free-pool.json");
    assert.deepEqual(report.freePool, [{ nodeId: "newer-peer", updatedAt: T2 }]);
    const pulled = JSON.parse(readFileSync(freePoolArtifactPath(home), "utf8"));
    assert.equal(pulled.updatedAt, T2);
    assert.deepEqual(pulled.models, [{ id: "peer-model" }]);
  });

  it("pulls newer completed BurnRunRecords and their report.md when the peer's runsUpdatedAt is newer", async () => {
    const home = gossipHome();
    const peerRecord = JSON.stringify({
      id: "run-42",
      updatedAt: T2,
      status: "completed",
      winningModel: "peer-model",
    });
    const staleLocalCopy = JSON.stringify({ id: "run-local", updatedAt: T0, status: "completed" });
    const { transport, reads } = makeTransport(
      {
        "burn-lab/runs/run-42.json": peerRecord,
        "burn-lab/runs/run-local.json": staleLocalCopy,
        "burn-lab/runs/run-42/report.md": "# Peer report\n",
      },
      ["run-42.json", "run-local.json"],
    );

    const report = await reconcileGossipSync({
      paseoHome: home,
      peers: [{ node: peerNode("mac-studio"), pulse: pulseOf("mac-studio", { runs: T2 }) }],
      transport,
    });

    // Only the genuinely newer record and its report are pulled; the peer's
    // older copy of run-local is left alone.
    assert.deepEqual(reads, [
      "burn-lab/runs/run-42.json",
      "burn-lab/runs/run-42/report.md",
      "burn-lab/runs/run-local.json",
    ]);
    assert.deepEqual(report.runs, [{ nodeId: "mac-studio", runId: "run-42", updatedAt: T2 }]);

    const local42 = JSON.parse(readFileSync(join(burnRunsDirPath(home), "run-42.json"), "utf8"));
    assert.equal(local42.winningModel, "peer-model");
    assert.equal(
      readFileSync(join(burnRunsDirPath(home), "run-42", "report.md"), "utf8"),
      "# Peer report\n",
    );
    const localOwn = JSON.parse(readFileSync(join(burnRunsDirPath(home), "run-local.json"), "utf8"));
    assert.equal(localOwn.updatedAt, T1);
  });

  it("pulls run records into a home that has no runs yet (bootstrap)", async () => {
    const home = makeTempDir("git-sync-gossip-empty");
    const peerRecord = JSON.stringify({ id: "run-7", updatedAt: T1, status: "completed" });
    const { transport } = makeTransport(
      { "burn-lab/runs/run-7.json": peerRecord },
      ["run-7.json"],
    );

    const report = await reconcileGossipSync({
      paseoHome: home,
      peers: [{ node: peerNode("win-wsl"), pulse: pulseOf("win-wsl", { runs: T1 }) }],
      transport,
    });

    assert.deepEqual(report.runs, [{ nodeId: "win-wsl", runId: "run-7", updatedAt: T1 }]);
    assert.ok(existsSync(join(burnRunsDirPath(home), "run-7.json")));
  });

  it("touches no artifacts when no peer digest advertises newer stamps", async () => {
    const home = gossipHome();
    const { transport, reads, listed } = makeTransport({}, []);

    const report = await reconcileGossipSync({
      paseoHome: home,
      peers: [
        { node: peerNode("even-peer"), pulse: pulseOf("even-peer", { freePool: T1, runs: T1 }) },
      ],
      transport,
    });

    assert.deepEqual(report.freePool, []);
    assert.deepEqual(report.runs, []);
    assert.deepEqual(reads, []);
    assert.deepEqual(listed, []);
    const pool = JSON.parse(readFileSync(freePoolArtifactPath(home), "utf8"));
    assert.equal(pool.updatedAt, T1);
  });
});

describe("SSH gossip transport (createSshGossipTransport)", () => {
  function gossipNode(): FleetNode {
    return {
      id: "mac-studio",
      name: "Mac Studio",
      posture: "stationary",
      transport: "ssh",
      sshTarget: "ssh://andrew@100.101.102.103",
      remotePaseoHome: "/home/andrew/.paseo-factory",
      slotCeiling: 2,
      reserveMode: false,
      healthGuard: { maxCpuPercent: 85, minFreeMemMb: 2048 },
    };
  }

  it("reads peer artifacts over BatchMode SSH via the injected runner", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = {
      run: async (command: string, args: string[]) => {
        calls.push({ command, args });
        return { stdout: "file bytes\n", stderr: "" };
      },
    };
    const transport = createSshGossipTransport({ runner });

    const content = await transport.readFile(gossipNode(), "burn-lab/free-pool.json");
    assert.equal(content, "file bytes\n");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "ssh");
    const args = calls[0].args;
    assert.ok(args.includes("BatchMode=yes"));
    assert.ok(args.includes("ConnectTimeout=5"));
    assert.ok(args.includes("andrew@100.101.102.103"));
    assert.equal(args[args.length - 1], "cat /home/andrew/.paseo-factory/burn-lab/free-pool.json");
  });

  it("returns null for a missing peer file and [] for an unreadable directory instead of failing gossip", async () => {
    const runner = {
      run: async (command: string, args: string[]) => {
        if (args[args.length - 1].startsWith("ls")) {
          throw new Error("ssh: connection lost");
        }
        return { stdout: "", stderr: "" };
      },
    };
    const transport = createSshGossipTransport({ runner });

    // `cat` of a missing file exits non-zero on the peer → readFile maps to null.
    const missing = await transport.readFile(gossipNode(), "burn-lab/runs/ghost.json");
    assert.equal(missing, null);

    const listing = await transport.listFiles(gossipNode(), "burn-lab/runs");
    assert.deepEqual(listing, []);
  });

  it("lists a peer directory's files from `ls -1` output", async () => {
    const runner = {
      run: async () => ({ stdout: "run-42.json\nrun-local.json\n", stderr: "" }),
    };
    const transport = createSshGossipTransport({ runner });
    const files = await transport.listFiles(gossipNode(), "burn-lab/runs");
    assert.deepEqual(files, ["run-42.json", "run-local.json"]);
  });
});
