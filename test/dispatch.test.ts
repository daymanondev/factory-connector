import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  createCommitBundle,
  stageFleetRefFromBundle,
  landFleetRef,
} from "../src/git-sync.ts";
import {
  loadFleetState,
  fleetStatePath,
  type FleetState,
  type FleetNodeState,
} from "../src/fleet.ts";
import {
  receiveHandoff,
  dispatchHandoff,
  executeBurst,
  ensureConnectorBridge,
  coreCliCandidates,
  loadHandoff,
  handoffRecordPath,
  handoffStagingDir,
  type HandoffRecord,
  type GitBundleTransport,
  type RemoteCommandRunner,
} from "../src/dispatch.ts";
import {
  commitAll,
  fleetNode,
  fleetStateOf,
  git,
  initRepo,
  makeTempDir,
  makeTempHome,
  nodeState,
  recordingSpawn,
  seedRegistry,
  simulatedTargetNode,
} from "./helpers.ts";

const execFileAsync = promisify(execFile);

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

    // The initiator probed the target's Mirror before packaging (no mirror
    // yet), then asked the remote side to receive via the peer's own bridge
    // binary — two remote commands, probe first.
    assert.equal(commands.length, 2);
    assert.equal(commands[0].nodeId, "studio-a");
    assert.ok(commands[0].command.includes("rev-parse HEAD"), commands[0].command);
    const receive = commands[1];
    assert.equal(receive.nodeId, "studio-a");
    assert.ok(
      receive.command.includes(
        "~/.paseo-factory/connector/bin/connector-dispatch receive-handoff --manifest",
      ),
      `unexpected remote command: ${receive.command}`,
    );
    assert.ok(receive.command.includes("~/.paseo-factory/connector/inbox/ho-1/handoff.json"));

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
    const receives = commands.filter((entry) => entry.command.includes("receive-handoff"));
    assert.equal(receives.length, 1);
    assert.equal(receives[0].nodeId, "studio-a");
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
    const receives = commands.filter((entry) => entry.command.includes("receive-handoff"));
    assert.equal(receives.length, 1);
    assert.equal(receives[0].nodeId, "studio-b");
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

  it("re-handoff to a peer with an existing Mirror ships a compact thin bundle (two-tier payloads)", async () => {
    const { repo, base, head } = await makeProjectWithInclude();
    const { initiatorHome, state } = seededFleet();
    const targetHome = makeTempHome("dispatch-target");
    const { spawn } = recordingSpawn();
    const { transport, remoteRunner, commands } = simulatedTargetNode(targetHome, spawn);
    const common = {
      paseoHome: initiatorHome,
      projectPath: repo,
      base,
      canonicalSlug: "my-proj",
      brief,
      state,
      targetNodeId: "studio-a",
      bundleTransport: transport,
      remoteRunner,
      now: () => dispatchedAt,
    } as const;

    // First transfer: the peer holds no Mirror for the slug yet, so the probe
    // answers nothing and the bundle carries the full history (no prerequisites).
    const first = await dispatchHandoff({ ...common, handoffId: "ho-full" });
    const firstHeader = readFileSync(
      join(handoffStagingDir(initiatorHome, "ho-full"), "commit.bundle"),
      "latin1",
    ).slice(0, 2048);
    assert.ok(!/^-/m.test(firstHeader), "first payload is self-contained");
    assert.equal(first.bundle.baseCommit, base);

    // The initiator advances one commit and hands the same project off again.
    writeFileSync(join(repo, "playbook.txt"), "v3\n", "utf8");
    const newHead = await commitAll(repo, "advance");

    const second = await dispatchHandoff({ ...common, handoffId: "ho-thin" });
    // The peer's existing Mirror HEAD became the bundle's prerequisite…
    const thinHeader = readFileSync(
      join(handoffStagingDir(initiatorHome, "ho-thin"), "commit.bundle"),
      "latin1",
    ).slice(0, 2048);
    assert.ok(thinHeader.includes(`-${head}`), "mirror HEAD recorded as prerequisite");
    assert.equal(second.bundle.baseCommit, head);
    assert.equal(second.bundle.headCommit, newHead);
    // …the probe rode the remote seam before packaging…
    assert.ok(commands.some((entry) => entry.command.includes("rev-parse HEAD")));
    // …and the target's Mirror fast-forwarded to the advanced commit.
    const mirrorPath = join(targetHome, "connector", "repos", "my-proj");
    assert.equal((await git(mirrorPath, "rev-parse", "HEAD")).trim(), newHead);
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
      nodeState({ nodeId: "hot", name: "Hot Box", posture: "stationary", activeBurnRuns: 2, slotCeiling: 2 }),
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

  it("preserves pre-existing handoff-recorded slotsInUse on eligible Nodes (baseline + in-flight)", async () => {
    const initiatorHome = makeTempHome("burst-baseline");
    seedRegistry(initiatorHome, [
      fleetNode({ id: "studio-a", name: "Studio A", posture: "stationary", slotCeiling: 3 }),
    ]);
    // studio-a already hosts a handed-off run (1 of 3 slots) before the burst;
    // the laptop is saturated, so the burst can only land on studio-a.
    const state = fleetStateOf([
      nodeState({ nodeId: "laptop", name: "Laptop", posture: "mobile", slotCeiling: 2, slotsInUse: 2 }),
      nodeState({ nodeId: "studio-a", name: "Studio A", posture: "stationary", slotCeiling: 3, slotsInUse: 1 }),
    ]);
    const { runner, recording } = recordingPeers(initiatorHome, () => ({ ok: true, delayMs: 25 }));

    const report = await executeBurst({
      paseoHome: initiatorHome,
      state,
      units: [{ id: "probe-1", command: "scout --model a" }],
      remoteRunner: runner,
      now: () => burstStartedAt,
    });

    assert.equal(report.ok, true);
    assert.equal(report.results[0].nodeId, "studio-a");
    // While the unit ran, the snapshot showed the handoff's slot plus the burst's.
    assert.equal(Math.max(...recording.get("studio-a")!.observedSlots), 2);
    // Once the burst settled, the handed-off run's slot is still accounted —
    // the burst must release only what it took, never the baseline occupancy.
    const settled = loadFleetState(initiatorHome);
    assert.ok(settled);
    assert.equal(settled.nodes.find((node) => node.nodeId === "studio-a")?.slotsInUse, 1);
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

describe("ensureConnectorBridge (Connector bridge contract)", () => {
  it("writes fleet-state.json and generates an executable connector-dispatch wrapper", async () => {
    const home = makeTempHome("bridge");
    const state = fleetStateOf([
      nodeState({ nodeId: "laptop", name: "Laptop", posture: "mobile" }),
      nodeState({ nodeId: "studio-a", name: "Studio A" }),
    ]);

    const coreCliPath = join(makeTempDir("bridge-cli"), "dispatch-cli.ts");
    writeFileSync(coreCliPath, "// stand-in for the mirrored core CLI\n", "utf8");

    const bridge = await ensureConnectorBridge({ paseoHome: home, state, coreCliPath });

    // fleet-state.json carries the snapshot for burn-lab / paseo-factory to read.
    assert.equal(bridge.statePath, fleetStatePath(home));
    assert.deepEqual(JSON.parse(readFileSync(fleetStatePath(home), "utf8")), state);

    // The wrapper is executable and execs node against the core CLI with the home.
    const wrapperPath = bridge.dispatchPath;
    assert.ok(wrapperPath !== undefined, "an explicit coreCliPath must produce a wrapper");
    assert.equal(wrapperPath, join(home, "connector", "bin", "connector-dispatch"));
    const script = readFileSync(wrapperPath, "utf8");
    assert.ok(script.startsWith("#!/bin/sh\n"), script);
    assert.ok(script.includes(`exec node "${coreCliPath}"`), script);
    assert.ok(script.includes(`--home "${home}"`), script);
    assert.ok((statSync(wrapperPath).mode & 0o111) !== 0, "wrapper must be executable");
  });

  it("polls through the injected transport when no snapshot is supplied", async () => {
    const home = makeTempHome("bridge-poll");
    seedRegistry(home, [fleetNode({ id: "studio-a", name: "Studio A" })]);

    const bridge = await ensureConnectorBridge({
      paseoHome: home,
      transport: {
        async fetchPulse(node) {
          return {
            nodeId: node.id,
            online: true,
            cpuPercent: 42,
            freeMemMb: 8192,
            activeAgents: 1,
            activeBurnRuns: 0,
            meterSummary: null,
            freePoolUpdatedAt: null,
            runsUpdatedAt: null,
            collectedAt: "2026-10-17T12:00:00.000Z",
          };
        },
      },
      localSource: async () => ({ cpuPercent: 7, freeMemMb: 4096 }),
    });

    const written = JSON.parse(readFileSync(fleetStatePath(home), "utf8"));
    assert.equal(bridge.state.updatedAt, written.updatedAt);
    assert.equal(written.nodes.find((node: FleetNodeState) => node.nodeId === "studio-a")?.cpuPercent, 42);
  });

  it("the generated wrapper really dispatches: snapshot runs offline against a local-only fleet", async () => {
    const home = makeTempHome("bridge-live");
    // No registry seeded: a fresh home defaults to a single local Node, so the
    // snapshot poll never touches SSH.

    const bridge = await ensureConnectorBridge({ paseoHome: home });

    const dispatchPath = bridge.dispatchPath;
    assert.ok(dispatchPath !== undefined, "a resolvable CLI entry must produce a wrapper");
    const { stdout, stderr } = await execFileAsync(dispatchPath, ["snapshot"], {
      timeout: 60_000,
    });
    assert.equal(stderr, "");
    const snapshot = JSON.parse(stdout) as FleetState;
    assert.equal(snapshot.localNodeId, snapshot.nodes[0].nodeId);
    assert.equal(snapshot.nodes[0].online, true);
    assert.equal(snapshot.nodes[0].slotsInUse, 0);
    assert.ok(typeof snapshot.nodes[0].cpuPercent === "number");
  });

  it("resolves the CLI entry from the daemon's install records when the module cannot see its own directory", () => {
    const home = makeTempHome("bridge-candidates");

    // No install records at all: no candidates, the caller degrades visibly.
    assert.deepEqual(coreCliCandidates(home), []);

    // A directory install recorded in config.json is the first candidate.
    const dirSource = makeTempDir("bridge-candidates-dir");
    const dirCli = join(dirSource, "server", "core", "dispatch-cli.ts");
    mkdirSync(dirname(dirCli), { recursive: true });
    writeFileSync(dirCli, "// stand-in\n", "utf8");
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: { "factory-connector": { source: "directory", path: dirSource, enabled: true } },
      }),
      "utf8",
    );
    assert.deepEqual(coreCliCandidates(home), [dirCli]);

    // A git install's staged checkouts are found too, newest first.
    const staged = (name: string, ageMs: number): string => {
      const cli = join(home, "plugins", "factory-connector", name, "checkout", "plugin", "server", "core", "dispatch-cli.ts");
      mkdirSync(dirname(cli), { recursive: true });
      writeFileSync(cli, "// stand-in\n", "utf8");
      const atime = new Date(Date.now() - ageMs);
      utimesSync(cli, atime, atime);
      return cli;
    };
    const older = staged("11111111-1111-1111-1111-111111111111", 60_000);
    const newer = staged("22222222-2222-2222-2222-222222222222", 1_000);
    assert.deepEqual(coreCliCandidates(home), [dirCli, newer, older]);
  });

  it("skips the dispatch wrapper instead of crashing when no CLI entry resolves (coreCliPath: null)", async () => {
    const home = makeTempHome("bridge-skip");
    const state = fleetStateOf([nodeState({ nodeId: "laptop", name: "Laptop", posture: "mobile" })]);

    const bridge = await ensureConnectorBridge({ paseoHome: home, state, coreCliPath: null });

    // The snapshot is still published for sibling repos to read.
    assert.deepEqual(JSON.parse(readFileSync(fleetStatePath(home), "utf8")), state);
    assert.equal(bridge.dispatchPath, undefined);
    assert.equal(existsSync(join(home, "connector", "bin", "connector-dispatch")), false);
  });
});
