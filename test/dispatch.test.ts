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
import {
  DEFAULT_HEALTH_GUARD,
  saveFleetConfig,
  loadFleetState,
  fleetStatePath,
  type FleetState,
  type FleetNode,
  type FleetNodeState,
} from "../src/fleet.ts";
import {
  receiveHandoff,
  dispatchHandoff,
  executeBurst,
  loadHandoff,
  handoffRecordPath,
  type DetachedSpawn,
  type HandoffRecord,
  type GitBundleTransport,
  type RemoteCommandRunner,
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

function fleetNode(overrides: Partial<FleetNode> & { id: string }): FleetNode {
  return {
    name: overrides.id,
    posture: "stationary",
    transport: "ssh",
    sshTarget: `ssh://andrew@100.101.102.${100 + overrides.id.length}?daemonPort=6767`,
    remotePaseoHome: "~/.paseo-factory",
    slotCeiling: 2,
    reserveMode: false,
    healthGuard: { ...DEFAULT_HEALTH_GUARD },
    ...overrides,
  };
}

function nodeState(overrides: Partial<FleetNodeState> & { nodeId: string }): FleetNodeState {
  return {
    online: true,
    cpuPercent: 10,
    freeMemMb: 8192,
    activeAgents: 0,
    activeBurnRuns: 0,
    meterSummary: null,
    freePoolUpdatedAt: null,
    runsUpdatedAt: null,
    collectedAt: "2026-10-17T10:00:00.000Z",
    name: overrides.nodeId,
    posture: "stationary",
    slotCeiling: 2,
    reserveMode: false,
    healthGuard: { ...DEFAULT_HEALTH_GUARD },
    slotsInUse: 0,
    lastError: null,
    ...overrides,
  };
}

function fleetStateOf(nodes: FleetNodeState[], localNodeId = "laptop"): FleetState {
  return { version: 1, localNodeId, updatedAt: "2026-10-17T10:00:00.000Z", nodes };
}

/** Persists a registry whose local `Node` is the `laptop` (mobile initiator). */
function seedRegistry(home: string, nodes: FleetNode[]): void {
  saveFleetConfig(home, {
    version: 1,
    localNodeId: "laptop",
    nodes: [fleetNode({ id: "laptop", name: "Laptop", posture: "mobile", transport: "local" }), ...nodes],
  });
}

/**
 * Simulated target `Node`: the `GitBundleTransport` really copies files into a
 * temp target home's inbox, and the `RemoteCommandRunner` really executes the
 * composed `connector-dispatch receive-handoff` command against that home —
 * exactly what the production bridge on the peer would do, minus SSH.
 */
function simulatedTargetNode(targetHome: string, spawn: DetachedSpawn): {
  transport: GitBundleTransport;
  remoteRunner: RemoteCommandRunner;
  commands: Array<{ nodeId: string; command: string }>;
} {
  const commands: Array<{ nodeId: string; command: string }> = [];
  const toTargetPath = (remote: string): string => remote.replace(/^~\/?/, `${targetHome}/`);
  return {
    commands,
    transport: {
      async copyToNode(_node, localPath, remoteDir) {
        const dir = toTargetPath(remoteDir);
        mkdirSync(dir, { recursive: true });
        const destination = join(dir, basename(localPath));
        copyFileSync(localPath, destination);
        return `${remoteDir}/${basename(localPath)}`;
      },
    },
    remoteRunner: {
      async run(node, command) {
        commands.push({ nodeId: node.id, command });
        const match = /--manifest '([^']+)'/.exec(command);
        if (!match) throw new Error(`unexpected remote command: ${command}`);
        const record = await receiveHandoff({
          paseoHome: targetHome,
          manifestPath: toTargetPath(match[1]),
          spawn,
        });
        return { stdout: `${record.pid}\n`, stderr: "" };
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

describe("dispatchHandoff (initiating Node side)", () => {
  const dispatchedAt = new Date("2026-10-17T10:00:02.000Z");
  const brief = {
    kind: "burn-run" as const,
    runOrTaskId: "run-42",
    command: "npx burn run --playbook probe",
    playbook: "probe",
    prompt: "compare three models",
  };

  /** Registry + snapshot: laptop (local, mobile) + two stationary peers + one mobile peer. */
  function seededFleet(): {
    initiatorHome: string;
    state: FleetState;
  } {
    const initiatorHome = makeTempHome("dispatch-initiator");
    seedRegistry(initiatorHome, [
      fleetNode({ id: "studio-a", name: "Studio A", posture: "stationary" }),
      fleetNode({ id: "studio-b", name: "Studio B", posture: "stationary", slotCeiling: 1 }),
      fleetNode({ id: "peer-laptop", name: "Peer Laptop", posture: "mobile" }),
    ]);
    const state = fleetStateOf([
      nodeState({ nodeId: "laptop", name: "Laptop", posture: "mobile", slotsInUse: 0 }),
      nodeState({ nodeId: "studio-a", name: "Studio A", posture: "stationary", slotsInUse: 1, slotCeiling: 2 }),
      nodeState({ nodeId: "studio-b", name: "Studio B", posture: "stationary", slotCeiling: 1 }),
      nodeState({ nodeId: "peer-laptop", name: "Peer Laptop", posture: "mobile" }),
    ]);
    return { initiatorHome, state };
  }

  it("packages the bundle, transfers it to the stationary Host node, and records a dispatch that survives disconnect", async () => {
    const { repo, base, head } = await makeProjectWithInclude();
    const { initiatorHome, state } = seededFleet();
    const targetHome = makeTempHome("dispatch-target");
    const { spawns, spawn } = recordingSpawn();
    const { transport, remoteRunner, commands } = simulatedTargetNode(targetHome, spawn);

    const record = await dispatchHandoff({
      paseoHome: initiatorHome,
      projectPath: repo,
      base,
      canonicalSlug: "my-proj",
      brief,
      state,
      targetNodeId: "auto-stationary",
      handoffId: "ho-1",
      bundleTransport: transport,
      remoteRunner,
      now: () => dispatchedAt,
    });

    // Outbound record: ownership transferred, Fleet ref named for later reconciliation.
    assert.equal(record.direction, "outbound");
    assert.equal(record.status, "dispatched");
    assert.equal(record.targetNodeId, "studio-a");
    assert.equal(record.sourceNodeId, "laptop");
    assert.equal(record.expectedFleetRef, "refs/fleet/studio-a/run-42");
    assert.equal(record.pid, "31337");
    assert.equal(record.bundle.headCommit, head);
    assert.equal(record.bundle.baseCommit, base);
    assert.deepEqual(loadHandoff(initiatorHome, "ho-1"), record);

    // The remote side was asked to receive via the peer's own bridge binary.
    assert.equal(commands.length, 1);
    assert.equal(commands[0].nodeId, "studio-a");
    assert.ok(
      commands[0].command.includes(
        "~/.paseo-factory/connector/bin/connector-dispatch receive-handoff --manifest",
      ),
      `unexpected remote command: ${commands[0].command}`,
    );
    assert.ok(commands[0].command.includes("~/.paseo-factory/connector/inbox/ho-1/handoff.json"));

    // Target side is fully self-sufficient (initiator may disconnect now).
    const mirrorPath = join(targetHome, "connector", "repos", "my-proj");
    assert.equal((await git(mirrorPath, "rev-parse", "HEAD")).trim(), head);
    assert.equal(readFileSync(join(mirrorPath, ".env"), "utf8"), "TOKEN=hush\n");
    const inbound = loadHandoff(targetHome, "ho-1");
    assert.ok(inbound);
    assert.equal(inbound.direction, "inbound");
    assert.equal(inbound.status, "running");
    assert.equal(inbound.mirrorPath, mirrorPath);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].command, brief.command);

    // Slot accounting: the dispatched run occupies one target slot in the snapshot.
    const snapshot = loadFleetState(initiatorHome);
    assert.ok(snapshot);
    assert.equal(snapshot.nodes.find((node) => node.nodeId === "studio-a")?.slotsInUse, 2);
    assert.equal(snapshot.nodes.find((node) => node.nodeId === "studio-b")?.slotsInUse, 0);
  });

  it("auto-stationary prefers the stationary Node with the most free slots over an idle mobile peer", async () => {
    const { repo, base } = await makeProjectWithInclude();
    const { initiatorHome, state } = seededFleet();
    const { spawn } = recordingSpawn();
    const { transport, remoteRunner, commands } = simulatedTargetNode(makeTempHome("dispatch-target"), spawn);

    await dispatchHandoff({
      paseoHome: initiatorHome,
      projectPath: repo,
      base,
      canonicalSlug: "my-proj",
      brief,
      state,
      bundleTransport: transport,
      remoteRunner,
    });

    // studio-a has 1 free slot, studio-b 1 free slot, peer-laptop 2 but mobile:
    // stationary wins; among the stationary pair selectEligibleNodes breaks the
    // free-slot tie by lower CPU then id order (both cpu 10 → studio-a first).
    assert.equal(commands.length, 1);
    assert.equal(commands[0].nodeId, "studio-a");
  });

  it("honours an explicit targetNodeId", async () => {
    const { repo, base } = await makeProjectWithInclude();
    const { initiatorHome, state } = seededFleet();
    const { spawn } = recordingSpawn();
    const { transport, remoteRunner, commands } = simulatedTargetNode(makeTempHome("dispatch-target"), spawn);

    const record = await dispatchHandoff({
      paseoHome: initiatorHome,
      projectPath: repo,
      base,
      canonicalSlug: "my-proj",
      brief,
      state,
      targetNodeId: "studio-b",
      bundleTransport: transport,
      remoteRunner,
    });

    assert.equal(record.targetNodeId, "studio-b");
    assert.equal(commands[0].nodeId, "studio-b");
    assert.equal(record.expectedFleetRef, "refs/fleet/studio-b/run-42");
  });

  it("refuses an explicit target that is offline or in Reserve mode, without recording a handoff", async () => {
    const { repo, base } = await makeProjectWithInclude();
    const { initiatorHome, state } = seededFleet();
    state.nodes = state.nodes.map((node) =>
      node.nodeId === "studio-b" ? { ...node, online: false } : node,
    );
    const { spawn } = recordingSpawn();
    const { transport, remoteRunner } = simulatedTargetNode(makeTempHome("dispatch-target"), spawn);

    await assert.rejects(
      () =>
        dispatchHandoff({
          paseoHome: initiatorHome,
          projectPath: repo,
          base,
          canonicalSlug: "my-proj",
          brief,
          state,
          targetNodeId: "studio-b",
          bundleTransport: transport,
          remoteRunner,
        }),
      /studio-b.*offline|offline.*studio-b/s,
    );

    const reserved = fleetStateOf([
      nodeState({ nodeId: "laptop", posture: "mobile" }),
      nodeState({ nodeId: "studio-a", reserveMode: true }),
    ]);
    await assert.rejects(
      () =>
        dispatchHandoff({
          paseoHome: initiatorHome,
          projectPath: repo,
          base,
          canonicalSlug: "my-proj",
          brief,
          state: reserved,
          targetNodeId: "studio-a",
          bundleTransport: transport,
          remoteRunner,
        }),
      /Reserve mode/,
    );

    assert.equal(loadHandoff(initiatorHome, "ho-anything"), null);
  });

  it("refuses when no stationary Node is eligible and no record or bundle is left behind", async () => {
    const { repo, base } = await makeProjectWithInclude();
    const { initiatorHome } = seededFleet();
    const state = fleetStateOf([
      nodeState({ nodeId: "laptop", posture: "mobile" }),
      nodeState({ nodeId: "peer-laptop", posture: "mobile" }),
      nodeState({ nodeId: "studio-a", posture: "stationary", reserveMode: true }),
    ]);
    const { spawn } = recordingSpawn();
    const { transport, remoteRunner } = simulatedTargetNode(makeTempHome("dispatch-target"), spawn);

    await assert.rejects(
      () =>
        dispatchHandoff({
          paseoHome: initiatorHome,
          projectPath: repo,
          base,
          canonicalSlug: "my-proj",
          brief,
          state,
          bundleTransport: transport,
          remoteRunner,
        }),
      /no eligible stationary/i,
    );
    // Selection happens before packaging: nothing was staged.
    assert.equal(existsSync(join(initiatorHome, "connector", "handoffs")), false);
  });

  it("records a failed handoff when the peer cannot receive, and rethrows", async () => {
    const { repo, base } = await makeProjectWithInclude();
    const { initiatorHome, state } = seededFleet();
    const remoteRunner: RemoteCommandRunner = {
      async run() {
        throw new Error("ssh: connection reset by peer");
      },
    };
    const transport: GitBundleTransport = {
      async copyToNode(_node, localPath, remoteDir) {
        return `${remoteDir}/${basename(localPath)}`;
      },
    };

    await assert.rejects(
      () =>
        dispatchHandoff({
          paseoHome: initiatorHome,
          projectPath: repo,
          base,
          canonicalSlug: "my-proj",
          brief,
          state,
          handoffId: "ho-fail",
          bundleTransport: transport,
          remoteRunner,
        }),
      /connection reset/,
    );

    const failed = loadHandoff(initiatorHome, "ho-fail");
    assert.ok(failed);
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /connection reset/);
  });

  it("survives initiator disconnect: the target completes autonomously and the recorded Fleet ref reconciles on reconnect", async () => {
    const { repo, base, head } = await makeProjectWithInclude();
    const { initiatorHome, state } = seededFleet();
    const targetHome = makeTempHome("dispatch-target");
    const { spawn } = recordingSpawn();
    const { transport, remoteRunner } = simulatedTargetNode(targetHome, spawn);

    const record = await dispatchHandoff({
      paseoHome: initiatorHome,
      projectPath: repo,
      base,
      canonicalSlug: "my-proj",
      brief,
      state,
      handoffId: "ho-live",
      bundleTransport: transport,
      remoteRunner,
      now: () => dispatchedAt,
    });

    // The initiator disconnects: its staging artifacts are gone. The target's
    // mirror, inbound record, and detached run live entirely under its own home.
    rmSync(join(initiatorHome, "connector", "handoffs", "ho-live"), { recursive: true, force: true });
    const mirrorPath = join(targetHome, "connector", "repos", "my-proj");
    assert.equal((await git(mirrorPath, "rev-parse", "HEAD")).trim(), head);
    assert.ok(loadHandoff(targetHome, "ho-live"));

    // The target runs the job to completion: a new commit lands on its mirror.
    writeFileSync(join(mirrorPath, "playbook.txt"), "done\n", "utf8");
    const completedHead = await commitAll(mirrorPath, "handoff completion");
    assert.notEqual(completedHead, head);

    // The initiator reconnects: the outbound record it kept names the exact
    // `Fleet ref` the completion stages under — no shared state required.
    const reconciled = loadHandoff(initiatorHome, "ho-live");
    assert.ok(reconciled);
    assert.equal(reconciled.expectedFleetRef, "refs/fleet/studio-a/run-42");

    const completionBundle = join(makeTempDir("dispatch-completion"), "done.bundle");
    await createCommitBundle({ repoPath: mirrorPath, base: head, outPath: completionBundle });
    const staged = await stageFleetRefFromBundle({
      repoPath: repo,
      bundlePath: completionBundle,
      nodeId: reconciled.targetNodeId,
      runOrTaskId: reconciled.runOrTaskId,
    });
    assert.equal(staged.ref, reconciled.expectedFleetRef);

    const landed = await landFleetRef({
      repoPath: repo,
      nodeId: reconciled.targetNodeId,
      runOrTaskId: reconciled.runOrTaskId,
      mode: "checkout",
    });
    assert.equal(landed.branch, "fleet/studio-a/run-42");
    assert.equal((await git(repo, "rev-parse", "HEAD")).trim(), completedHead);
    assert.equal(readFileSync(join(repo, "playbook.txt"), "utf8"), "done\n");
  });
});

describe("executeBurst (cooperative parallel execution)", () => {
  const burstStartedAt = new Date("2026-10-17T11:00:00.000Z");

  /** Registry + snapshot: laptop (local) + two stationary peers + ineligible peers. */
  function seededBurstFleet(): { initiatorHome: string; state: FleetState } {
    const initiatorHome = makeTempHome("burst-initiator");
    seedRegistry(initiatorHome, [
      fleetNode({ id: "studio-a", name: "Studio A", posture: "stationary", slotCeiling: 2 }),
      fleetNode({ id: "studio-b", name: "Studio B", posture: "stationary", slotCeiling: 1 }),
      fleetNode({ id: "reserved", name: "Reserved Box", posture: "stationary" }),
      fleetNode({ id: "hot", name: "Hot Box", posture: "stationary" }),
    ]);
    const state = fleetStateOf([
      nodeState({ nodeId: "laptop", name: "Laptop", posture: "mobile", slotCeiling: 2, slotsInUse: 2 }),
      nodeState({ nodeId: "studio-a", name: "Studio A", posture: "stationary", slotCeiling: 2 }),
      nodeState({ nodeId: "studio-b", name: "Studio B", posture: "stationary", slotCeiling: 1 }),
      nodeState({ nodeId: "reserved", name: "Reserved Box", posture: "stationary", reserveMode: true }),
      nodeState({ nodeId: "hot", name: "Hot Box", posture: "stationary", cpuPercent: 99 }),
    ]);
    return { initiatorHome, state };
  }

  interface NodeRecording {
    attempts: number;
    maxConcurrent: number;
    observedSlots: number[];
    commands: string[];
  }

  /**
   * Deterministic peer stub: records concurrency and the `slotsInUse` it
   * observes in `fleet-state.json` at attempt start; `behaviour(nodeId)`
   * decides success (after `delayMs`) or a thrown disconnect.
   */
  function recordingPeers(
    initiatorHome: string,
    behaviour: (nodeId: string, attempt: number) => { ok: true; delayMs: number } | { ok: false; error: string; delayMs: number },
    delayMs = 25,
  ): { runner: RemoteCommandRunner; recording: Map<string, NodeRecording> } {
    const recording = new Map<string, NodeRecording>();
    const inFlight = new Map<string, number>();
    const track = (nodeId: string): NodeRecording => {
      let entry = recording.get(nodeId);
      if (!entry) {
        entry = { attempts: 0, maxConcurrent: 0, observedSlots: [], commands: [] };
        recording.set(nodeId, entry);
      }
      return entry;
    };
    return {
      recording,
      runner: {
        async run(node, command) {
          const entry = track(node.id);
          const state = loadFleetState(initiatorHome);
          entry.observedSlots.push(
            state?.nodes.find((candidate) => candidate.nodeId === node.id)?.slotsInUse ?? -1,
          );
          entry.attempts += 1;
          entry.commands.push(command);
          const running = (inFlight.get(node.id) ?? 0) + 1;
          inFlight.set(node.id, running);
          entry.maxConcurrent = Math.max(entry.maxConcurrent, running);
          const outcome = behaviour(node.id, entry.attempts);
          await new Promise((resolve) => setTimeout(resolve, outcome.delayMs || delayMs));
          inFlight.set(node.id, (inFlight.get(node.id) ?? 0) - 1);
          if (!outcome.ok) throw new Error(outcome.error);
          return { stdout: `done:${node.id}:${entry.attempts}`, stderr: "" };
        },
      },
    };
  }

  it("distributes units across eligible Nodes respecting Slot ceilings, Health guard, and Reserve mode", async () => {
    const { initiatorHome, state } = seededBurstFleet();
    const { runner, recording } = recordingPeers(initiatorHome, () => ({ ok: true, delayMs: 25 }));

    const report = await executeBurst({
      paseoHome: initiatorHome,
      state,
      units: [
        { id: "probe-1", command: "scout --model a" },
        { id: "probe-2", command: "scout --model b" },
        { id: "probe-3", command: "scout --model c" },
      ],
      remoteRunner: runner,
      now: () => burstStartedAt,
    });

    assert.equal(report.ok, true);
    assert.equal(report.results.length, 3);
    for (const result of report.results) {
      assert.equal(result.ok, true, `unit ${result.unitId} should have succeeded`);
      assert.equal(result.attempts.length, 1);
      assert.ok(result.nodeId === "studio-a" || result.nodeId === "studio-b");
      assert.equal(result.attempts[0].ok, true);
      assert.ok(result.attempts[0].stdout.startsWith("done:"));
      assert.ok(Date.parse(result.attempts[0].startedAt) <= Date.parse(result.attempts[0].endedAt));
    }
    // Capacity-respecting assignment: studio-a (2 free slots) took two units,
    // studio-b (1 free slot) took one; ineligible Nodes took none.
    const assignedTo = (nodeId: string): number =>
      report.results.filter((result) => result.nodeId === nodeId).length;
    assert.equal(assignedTo("studio-a"), 2);
    assert.equal(assignedTo("studio-b"), 1);
    assert.equal(recording.get("reserved"), undefined);
    assert.equal(recording.get("hot"), undefined);
    assert.equal(recording.get("laptop"), undefined);
    // Never more in flight on a Node than its Slot ceiling.
    assert.ok(recording.get("studio-a")!.maxConcurrent <= 2);
    assert.ok(recording.get("studio-b")!.maxConcurrent <= 1);

    // In-flight accounting: peers observed their assigned slots while running,
    // and everything the burst took is released once it settles (the saturated
    // laptop keeps its pre-existing occupancy — the burst never owned it).
    assert.equal(Math.max(...recording.get("studio-a")!.observedSlots), 2);
    assert.equal(Math.max(...recording.get("studio-b")!.observedSlots), 1);
    const settled = loadFleetState(initiatorHome);
    assert.ok(settled);
    for (const node of settled.nodes) {
      if (node.nodeId === "laptop") {
        assert.equal(node.slotsInUse, 2);
        continue;
      }
      assert.equal(node.slotsInUse, 0, `node ${node.nodeId} should have released its slots`);
    }
  });

  it("runs units for the local Node through the local runner, not the remote seam", async () => {
    const initiatorHome = makeTempHome("burst-local");
    seedRegistry(initiatorHome, [
      fleetNode({ id: "studio-a", name: "Studio A", posture: "stationary", slotCeiling: 1 }),
    ]);
    const state = fleetStateOf([
      nodeState({ nodeId: "laptop", name: "Laptop", posture: "mobile", slotCeiling: 3 }),
      nodeState({ nodeId: "studio-a", name: "Studio A", posture: "stationary", slotCeiling: 1 }),
    ]);

    const localCalls: Array<{ command: string; args: string[] }> = [];
    const report = await executeBurst({
      paseoHome: initiatorHome,
      state,
      units: [{ id: "probe-1", command: "echo local" }],
      localRunner: {
        run: async (command, args) => {
          localCalls.push({ command, args });
          return { stdout: "local-ok", stderr: "" };
        },
      },
      remoteRunner: {
        async run() {
          throw new Error("remote seam must not be used for the local Node");
        },
      },
    });

    assert.equal(report.ok, true);
    assert.equal(report.results[0].nodeId, "laptop");
    assert.equal(report.results[0].attempts[0].stdout, "local-ok");
    assert.deepEqual(localCalls, [{ command: "sh", args: ["-c", "echo local"] }]);
  });

  it("refuses to burst when no Node is eligible", async () => {
    const initiatorHome = makeTempHome("burst-empty");
    seedRegistry(initiatorHome, [fleetNode({ id: "studio-a", name: "Studio A" })]);
    const state = fleetStateOf([
      nodeState({ nodeId: "laptop", posture: "mobile", reserveMode: true }),
      nodeState({ nodeId: "studio-a", reserveMode: true }),
    ]);
    await assert.rejects(
      () =>
        executeBurst({
          paseoHome: initiatorHome,
          state,
          units: [{ id: "probe-1", command: "echo hi" }],
        }),
      /no eligible/i,
    );
  });

  it("rejects units with duplicate or empty ids instead of dispatching garbage", async () => {
    const { initiatorHome, state } = seededBurstFleet();
    await assert.rejects(
      () =>
        executeBurst({
          paseoHome: initiatorHome,
          state,
          units: [
            { id: "probe-1", command: "echo a" },
            { id: "probe-1", command: "echo b" },
          ],
        }),
      /probe-1/,
    );
    await assert.rejects(
      () =>
        executeBurst({
          paseoHome: initiatorHome,
          state,
          units: [{ id: "", command: "echo a" }],
        }),
      /non-empty id/,
    );
  });
});

describe("executeBurst failover (peer drops mid-attempt)", () => {
  const burstStartedAt = new Date("2026-10-17T11:00:00.000Z");

  function seededFailoverFleet(): { initiatorHome: string; state: FleetState } {
    const initiatorHome = makeTempHome("burst-failover");
    seedRegistry(initiatorHome, [
      fleetNode({ id: "dropper", name: "Dropper", posture: "stationary", slotCeiling: 2 }),
      fleetNode({ id: "survivor", name: "Survivor", posture: "stationary", slotCeiling: 1 }),
    ]);
    const state = fleetStateOf([
      nodeState({ nodeId: "laptop", name: "Laptop", posture: "mobile", slotCeiling: 2, slotsInUse: 2 }),
      nodeState({ nodeId: "dropper", name: "Dropper", posture: "stationary", slotCeiling: 2 }),
      nodeState({ nodeId: "survivor", name: "Survivor", posture: "stationary", slotCeiling: 1 }),
    ]);
    return { initiatorHome, state };
  }

  it("retries units on a surviving Node when a peer times out mid-attempt", async () => {
    const { initiatorHome, state } = seededFailoverFleet();
    const dropperCalls: string[] = [];
    const survivorCommands: string[] = [];

    const report = await executeBurst({
      paseoHome: initiatorHome,
      state,
      units: [
        { id: "probe-1", command: "scout --model a" },
        { id: "probe-2", command: "scout --model b" },
      ],
      // The dropper accepts both units (most free slots) then hangs — the
      // laptop closed its lid mid-attempt. The survivor is slower to schedule
      // (1 slot) but alive.
      remoteRunner: {
        async run(node, command) {
          if (node.id === "dropper") {
            dropperCalls.push(command);
            return await new Promise<{ stdout: string; stderr: string }>(() => {});
          }
          survivorCommands.push(command);
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { stdout: "ok", stderr: "" };
        },
      },
      attemptTimeoutMs: 80,
      now: () => burstStartedAt,
    });

    assert.equal(report.ok, true, JSON.stringify(report.results));
    // Both units were dispatched to the dropper before it went silent.
    assert.equal(dropperCalls.length, 2);
    assert.equal(survivorCommands.length, 2);

    for (const result of report.results) {
      assert.equal(result.ok, true);
      assert.equal(result.nodeId, "survivor");
      assert.equal(result.attempts.length, 2);
      const [dropped, retried] = result.attempts;
      assert.equal(dropped.nodeId, "dropper");
      assert.equal(dropped.ok, false);
      assert.match(dropped.error ?? "", /timed out/);
      assert.equal(retried.nodeId, "survivor");
      assert.equal(retried.ok, true);
      assert.equal(retried.stdout, "ok");
    }

    // The dropped peer's slots were released for the whole Fleet to see.
    const settled = loadFleetState(initiatorHome);
    assert.ok(settled);
    assert.equal(settled.nodes.find((node) => node.nodeId === "dropper")?.slotsInUse, 0);
    assert.equal(settled.nodes.find((node) => node.nodeId === "survivor")?.slotsInUse, 0);
  });

  it("fails a unit only after every eligible Node has failed it, recording each attempt", async () => {
    const { initiatorHome, state } = seededFailoverFleet();
    const attemptLog: string[] = [];

    const report = await executeBurst({
      paseoHome: initiatorHome,
      state,
      units: [{ id: "probe-1", command: "scout --model a" }],
      remoteRunner: {
        async run(node, command) {
          attemptLog.push(`${node.id}:${command}`);
          throw new Error("ssh: connection reset by peer");
        },
      },
      attemptTimeoutMs: 500,
      now: () => burstStartedAt,
    });

    assert.equal(report.ok, false);
    const result = report.results[0];
    assert.equal(result.ok, false);
    assert.equal(result.nodeId, null);
    assert.equal(result.attempts.length, 2);
    assert.deepEqual(result.attempts.map((attempt) => attempt.nodeId).sort(), ["dropper", "survivor"]);
    for (const attempt of result.attempts) {
      assert.equal(attempt.ok, false);
      assert.match(attempt.error ?? "", /connection reset/);
    }
    assert.equal(attemptLog.length, 2);

    const settled = loadFleetState(initiatorHome);
    assert.ok(settled);
    assert.equal(settled.nodes.find((node) => node.nodeId === "dropper")?.slotsInUse, 0);
  });
});
