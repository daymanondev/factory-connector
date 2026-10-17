/**
 * The `Fleet surface`'s RPC handlers (spec.md "Testing Decisions") against a
 * temp injected paseo home: every network/SSH/git seam is stubbed, so nothing
 * here ever touches the real `~/.paseo-factory`, `~/.paseo`, or the network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  pollFleetPulse,
  type FleetPulse,
  type FleetState,
  type LocalPulseSource,
  type PulseTransport,
} from "../src/fleet.ts";
import { createCommitBundle, stageFleetRefFromBundle, type GossipArtifactTransport } from "../src/git-sync.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SurfaceDeps, SurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import { FleetViewSchema } from "../plugin/shared/view.ts";
import {
  fleetNode,
  git,
  initRepo,
  commitAll,
  makeTempDir,
  makeTempHome,
  recordingSpawn,
  seedRegistry,
  simulatedTargetNode,
} from "./helpers.ts";

const execFileAsync = promisify(execFile);

/** Frozen clock — pulse cadence assertions are exact, never wall-clock flaky. */
const NOW = new Date("2026-10-17T10:00:00.000Z");
const fixedNow = () => NOW;

function pulseOf(nodeId: string, overrides: Partial<FleetPulse> = {}): FleetPulse {
  return {
    nodeId,
    online: true,
    cpuPercent: 10,
    freeMemMb: 8192,
    activeAgents: 0,
    activeBurnRuns: 0,
    meterSummary: null,
    freePoolUpdatedAt: null,
    runsUpdatedAt: null,
    collectedAt: NOW.toISOString(),
    ...overrides,
  };
}

/** Stub `PulseTransport` with per-node facts and a call ledger. */
function stubTransport(facts: Record<string, Partial<FleetPulse>> = {}): {
  calls: string[];
  transport: PulseTransport;
} {
  const calls: string[] = [];
  return {
    calls,
    transport: {
      async fetchPulse(node) {
        calls.push(node.id);
        const fact = facts[node.id];
        if (!fact) throw new Error(`stub: Node ${node.id} is unreachable`);
        return pulseOf(node.id, fact);
      },
    },
  };
}

/** Stub local pulse source — no real `os.cpus()` sampling in tests. */
const stubLocalSource: LocalPulseSource = async () => ({
  cpuPercent: 5,
  freeMemMb: 4096,
});

function makeHandlers(home: string, overrides: Partial<SurfaceDeps> = {}): SurfaceHandlers {
  return createSurfaceHandlers({
    paseoHome: home,
    localSource: stubLocalSource,
    now: fixedNow,
    ...overrides,
  });
}

/** Primes `fleet-state.json` exactly as a real poll would (snapshot never polls). */
async function primeState(
  home: string,
  transport: PulseTransport,
): Promise<FleetState> {
  return pollFleetPulse({
    paseoHome: home,
    transport,
    localSource: stubLocalSource,
    now: fixedNow,
  });
}

// ---- real-git fixtures (Handoff / Land ride real temporary repositories) ----------------

/** Initiating `Project` fixture: a base commit plus one commit on top (the handoff range). */
async function makeProject(): Promise<{ repo: string; base: string; head: string }> {
  const repo = await initRepo(join(makeTempDir("surface-project"), "proj"));
  writeFileSync(join(repo, "playbook.txt"), "v1\n", "utf8");
  const base = await commitAll(repo, "base");
  writeFileSync(join(repo, "playbook.txt"), "v2\n", "utf8");
  const head = await commitAll(repo, "head");
  return { repo, base, head };
}

describe("connector.snapshot", () => {
  it("folds the registry, the pulse snapshot, and the handoff records into one view", async () => {
    const home = makeTempHome("snapshot");
    seedRegistry(home, [fleetNode({ id: "studio-a", name: "Studio A" })]);
    await primeState(home, stubTransport({ "studio-a": { cpuPercent: 42, freeMemMb: 6144 } }).transport);
    const handlers = makeHandlers(home);

    const reply = await handlers.snapshot({});
    let view: ReturnType<typeof FleetViewSchema.parse>;

    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    // The view the handler folds must satisfy the wire contract both halves share.
    view = FleetViewSchema.parse(reply.view);
    assert.equal(view.localNodeId, "laptop");
    assert.equal(view.version, 1);
    assert.equal(view.nodes.length, 2);

    const local = view.nodes.find((node) => node.id === "laptop");
    assert.ok(local, "the local Node is in the view");
    assert.equal(local.local, true);
    assert.equal(local.online, true);
    assert.equal(local.posture, "mobile");

    const studio = view.nodes.find((node) => node.id === "studio-a");
    assert.ok(studio, "the peer Node is in the view");
    assert.equal(studio.local, false);
    assert.equal(studio.online, true);
    assert.equal(studio.cpuPercent, 42);
    assert.equal(studio.freeMemMb, 6144);
    assert.equal(studio.posture, "stationary");
    assert.equal(studio.slotCeiling, 2);
    assert.deepEqual(view.handoffs, []);
  });

  it("renders never-polled Nodes offline without inventing pulse facts", async () => {
    const home = makeTempHome("snapshot-cold");
    seedRegistry(home, [fleetNode({ id: "studio-a" })]);
    const handlers = makeHandlers(home);

    const reply = await handlers.snapshot({});

    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    const studio = reply.view.nodes.find((node) => node.id === "studio-a");
    assert.ok(studio);
    assert.equal(studio.online, false);
    assert.equal(studio.cpuPercent, 0);
    assert.equal(studio.collectedAt, null);
    assert.equal(studio.lastError, null);
  });

  it("carries each Node's remotePaseoHome so the editor never silently resets it", async () => {
    const home = makeTempHome("snapshot-remote-home");
    seedRegistry(home, [fleetNode({ id: "studio-a", remotePaseoHome: "/srv/paseo-factory" })]);
    const handlers = makeHandlers(home);

    const reply = await handlers.snapshot({});

    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    // The wire contract carries the registry's remote home for every Node.
    const parsed = FleetViewSchema.parse(reply.view);
    const studio = parsed.nodes.find((node) => node.id === "studio-a");
    assert.ok(studio);
    assert.equal(studio.remotePaseoHome, "/srv/paseo-factory");
    const local = parsed.nodes.find((node) => node.id === "laptop");
    assert.ok(local);
    assert.equal(local.remotePaseoHome, "~/.paseo-factory");
  });
});

describe("connector.node.upsert", () => {
  it("registers a new Node with defaults and returns the refreshed view", async () => {
    const home = makeTempHome("upsert");
    seedRegistry(home, []);
    const handlers = makeHandlers(home);

    const reply = await handlers.nodeUpsert({
      id: "wsl-box",
      name: "WSL Box",
      posture: "stationary",
      sshTarget: "ssh://andrew@100.101.102.200?daemonPort=6767",
    });

    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    const registered = reply.view.nodes.find((node) => node.id === "wsl-box");
    assert.ok(registered);
    assert.equal(registered.posture, "stationary");
    assert.equal(registered.transport, "ssh");
    assert.equal(registered.sshTarget, "ssh://andrew@100.101.102.200?daemonPort=6767");
    assert.equal(registered.slotCeiling, 2, "unspecified slotCeiling falls back to the default");
    assert.equal(registered.reserveMode, false);
    assert.deepEqual(registered.healthGuard, { maxCpuPercent: 85, minFreeMemMb: 2048 });
    // The registration persisted — a fresh fold sees it too.
    const again = await handlers.snapshot({});
    assert.ok(again.ok && again.view.nodes.some((node) => node.id === "wsl-box"));
  });

  it("updates an existing Node, keeping the full editor payload authoritative", async () => {
    const home = makeTempHome("upsert-update");
    seedRegistry(home, [fleetNode({ id: "studio-a", slotCeiling: 4 })]);
    const handlers = makeHandlers(home);

    const reply = await handlers.nodeUpsert({
      id: "studio-a",
      name: "Studio A",
      posture: "stationary",
      slotCeiling: 6,
      reserveMode: true,
      healthGuard: { maxCpuPercent: 70, minFreeMemMb: 4096 },
    });

    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    const updated = reply.view.nodes.find((node) => node.id === "studio-a");
    assert.ok(updated);
    assert.equal(updated.slotCeiling, 6);
    assert.equal(updated.reserveMode, true);
    assert.deepEqual(updated.healthGuard, { maxCpuPercent: 70, minFreeMemMb: 4096 });
  });

  it("refuses an invalid posture as data, never a thrown exception", async () => {
    const home = makeTempHome("upsert-invalid");
    seedRegistry(home, []);
    const handlers = makeHandlers(home);

    const reply = await handlers.nodeUpsert({
      id: "bad",
      name: "Bad",
      // @ts-expect-error — the wire contract must refuse what the schema forbids.
      posture: "laptopish",
    });

    assert.equal(reply.ok, false);
    if (reply.ok) return;
    assert.equal(reply.code, "invalid-node");
    assert.match(reply.error, /posture/);
  });
});

describe("connector.node.reserve", () => {
  it("toggles Reserve mode on a Node and reports it in the view", async () => {
    const home = makeTempHome("reserve");
    seedRegistry(home, [fleetNode({ id: "studio-a" })]);
    const handlers = makeHandlers(home);

    const off = await handlers.nodeReserve({ nodeId: "studio-a", reserveMode: true });
    assert.equal(off.ok, true);
    assert.ok(off.ok && off.view.nodes.find((node) => node.id === "studio-a")?.reserveMode === true);

    const on = await handlers.nodeReserve({ nodeId: "studio-a", reserveMode: false });
    assert.equal(on.ok, true);
    assert.ok(on.ok && on.view.nodes.find((node) => node.id === "studio-a")?.reserveMode === false);
  });

  it("refuses to toggle a Node the Fleet does not know", async () => {
    const home = makeTempHome("reserve-unknown");
    seedRegistry(home, []);
    const handlers = makeHandlers(home);

    const reply = await handlers.nodeReserve({ nodeId: "ghost", reserveMode: true });

    assert.equal(reply.ok, false);
    if (reply.ok) return;
    assert.equal(reply.code, "unknown-node");
    assert.match(reply.error, /ghost/);
  });
});

describe("connector.node.remove", () => {
  it("removes a peer Node from the registry and the rendered view", async () => {
    const home = makeTempHome("remove");
    seedRegistry(home, [fleetNode({ id: "studio-a" }), fleetNode({ id: "studio-b" })]);
    const handlers = makeHandlers(home);

    const reply = await handlers.nodeRemove({ nodeId: "studio-a" });

    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    assert.ok(!reply.view.nodes.some((node) => node.id === "studio-a"));
    assert.ok(reply.view.nodes.some((node) => node.id === "studio-b"));
    assert.ok(reply.view.nodes.some((node) => node.id === "laptop"));
    // The removal persisted.
    const again = await handlers.snapshot({});
    assert.ok(again.ok && !again.view.nodes.some((node) => node.id === "studio-a"));
  });

  it("refuses to remove the local Node — the registry would orphan itself", async () => {
    const home = makeTempHome("remove-local");
    seedRegistry(home, [fleetNode({ id: "studio-a" })]);
    const handlers = makeHandlers(home);

    const reply = await handlers.nodeRemove({ nodeId: "laptop" });

    assert.equal(reply.ok, false);
    if (reply.ok) return;
    assert.equal(reply.code, "local-node");
    assert.match(reply.error, /local/);
    // Nothing was removed.
    const after = await handlers.snapshot({});
    assert.ok(after.ok && after.view.nodes.length === 2);
  });

  it("refuses to remove a Node the Fleet does not know", async () => {
    const home = makeTempHome("remove-unknown");
    seedRegistry(home, []);
    const handlers = makeHandlers(home);

    const reply = await handlers.nodeRemove({ nodeId: "ghost" });

    assert.equal(reply.ok, false);
    if (reply.ok) return;
    assert.equal(reply.code, "unknown-node");
  });
});

describe("connector.pulse", () => {
  it("polls every Node on the first call and reports unreachable peers offline with the reason", async () => {
    const home = makeTempHome("pulse-first");
    seedRegistry(home, [fleetNode({ id: "studio-a" }), fleetNode({ id: "studio-b" })]);
    const { calls, transport } = stubTransport({ "studio-a": { cpuPercent: 30, freeMemMb: 2048 } });
    const handlers = makeHandlers(home, { transport });

    const reply = await handlers.pulse({ activeSurface: true });

    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    assert.deepEqual(calls.sort(), ["studio-a", "studio-b"], "every peer is polled exactly once");
    const studioA = reply.view.nodes.find((node) => node.id === "studio-a");
    assert.ok(studioA);
    assert.equal(studioA.online, true);
    assert.equal(studioA.cpuPercent, 30);
    const studioB = reply.view.nodes.find((node) => node.id === "studio-b");
    assert.ok(studioB);
    assert.equal(studioB.online, false);
    assert.match(studioB.lastError ?? "", /unreachable/);
    // The pulse published the snapshot the Connector bridge consumes.
    assert.ok(existsSync(join(home, "connector", "fleet-state.json")));
  });

  it("gates repeat polls on the adaptive cadence — 5s while the surface is open, 60s idle", async () => {
    const home = makeTempHome("pulse-cadence");
    seedRegistry(home, [fleetNode({ id: "studio-a" })]);
    const { calls, transport } = stubTransport({ "studio-a": {} });
    let clock = new Date("2026-10-17T10:00:00.000Z");
    const handlers = makeHandlers(home, { transport, now: () => clock });
    const polled = () => calls.filter((id) => id === "studio-a").length;

    await handlers.pulse({ activeSurface: false }); // first call always polls
    assert.equal(polled(), 1);

    clock = new Date("2026-10-17T10:00:30.000Z"); // +30s: still inside the 60s idle window
    await handlers.pulse({ activeSurface: false });
    assert.equal(polled(), 1, "idle gate holds for 60s");

    await handlers.pulse({ activeSurface: true }); // +30s: past the 5s active window
    assert.equal(polled(), 2, "an open surface tightens the cadence to 5s");

    await handlers.pulse({ activeSurface: false }); // 0s since the last poll
    assert.equal(polled(), 2, "the idle gate re-applies the moment the surface closes");

    clock = new Date("2026-10-17T10:01:31.000Z"); // +61s since the last poll
    await handlers.pulse({ activeSurface: false });
    assert.equal(polled(), 3, "the idle cadence polls again after 60s");
  });
});

describe("connector.handoff", () => {
  it("transfers run ownership to the auto-selected stationary Node through the injected seams", async () => {
    const home = makeTempHome("handoff");
    seedRegistry(home, [fleetNode({ id: "studio-a", name: "Studio A" })]);
    await primeState(home, stubTransport({ "studio-a": {} }).transport);
    const { repo, base } = await makeProject();
    const targetHome = makeTempHome("handoff-target");
    const spawn = recordingSpawn();
    const { transport: bundleTransport, remoteRunner } = simulatedTargetNode(targetHome, spawn.spawn);
    const handlers = makeHandlers(home, { bundleTransport, remoteRunner });

    const reply = await handlers.handoff({
      projectPath: repo,
      base,
      canonicalSlug: "my-proj",
      kind: "burn-run",
      runOrTaskId: "run-42",
      command: "npx burn run --playbook probe",
      playbook: "probe",
      prompt: "find the best model",
    });

    assert.equal(reply.ok, true, reply.ok ? "" : reply.error);
    if (!reply.ok) return;
    assert.equal(reply.handoff.direction, "outbound");
    assert.equal(reply.handoff.targetNodeId, "studio-a");
    assert.equal(reply.handoff.runOrTaskId, "run-42");
    assert.equal(reply.handoff.expectedFleetRef, "refs/fleet/studio-a/run-42");
    assert.equal(reply.handoff.status, "dispatched");
    assert.match(reply.handoff.playbook ?? "", /probe/);

    // The target Node really received it: mirror provisioned, run spawned, inbound record written.
    assert.ok(existsSync(join(targetHome, "connector", "repos", "my-proj", ".git")));
    assert.equal(spawn.spawns.length, 1);
    assert.match(spawn.spawns[0].command, /burn run --playbook probe/);
    const inbound = JSON.parse(
      readFileSync(join(targetHome, "connector", "handoffs", `${reply.handoff.handoffId}.json`), "utf8"),
    ) as { direction: string; status: string };
    assert.equal(inbound.direction, "inbound");
    assert.equal(inbound.status, "running");

    // The outbound record lands in the Synced Fleet Runs list, and the target's slot is taken.
    const snap = await handlers.snapshot({});
    assert.ok(snap.ok);
    if (!snap.ok) return;
    assert.equal(snap.view.handoffs.length, 1);
    assert.equal(snap.view.handoffs[0].handoffId, reply.handoff.handoffId);
    const target = snap.view.nodes.find((node) => node.id === "studio-a");
    assert.ok(target);
    assert.equal(target.slotsInUse, 1);
  });

  it("refuses as data when no stationary Node is eligible", async () => {
    const home = makeTempHome("handoff-none");
    seedRegistry(home, [fleetNode({ id: "studio-a" })]);
    // No pulse yet and no transport: the only peer is unreachable → auto-stationary finds nobody.
    const handlers = makeHandlers(home, { transport: stubTransport({}).transport });
    const { repo, base } = await makeProject();

    const reply = await handlers.handoff({
      projectPath: repo,
      base,
      canonicalSlug: "my-proj",
      kind: "burn-run",
      runOrTaskId: "run-43",
      command: "npx burn run",
    });

    assert.equal(reply.ok, false);
    if (reply.ok) return;
    assert.equal(reply.code, "handoff-failed");
    assert.match(reply.error, /no eligible stationary Node/);
  });
});

describe("connector.burst", () => {
  it("distributes work units across eligible Nodes through the injected runners and releases slots", async () => {
    const home = makeTempHome("burst");
    seedRegistry(home, [fleetNode({ id: "studio-a" })]);
    await primeState(home, stubTransport({ "studio-a": {} }).transport);
    const localRuns: Array<{ command: string; args: string[] }> = [];
    const remoteRuns: Array<{ nodeId: string; command: string }> = [];
    const handlers = makeHandlers(home, {
      localRunner: {
        async run(command, args) {
          localRuns.push({ command, args });
          return { stdout: `local:${args.join(" ")}`, stderr: "" };
        },
      },
      remoteRunner: {
        async run(node, command) {
          remoteRuns.push({ nodeId: node.id, command });
          return { stdout: `remote:${node.id}`, stderr: "" };
        },
      },
    });

    const reply = await handlers.burst({
      units: [
        { id: "probe-1", command: "echo one" },
        { id: "probe-2", command: "echo two" },
      ],
    });

    assert.equal(reply.ok, true, reply.ok ? "" : reply.error);
    if (!reply.ok) return;
    assert.equal(reply.report.ok, true);
    assert.equal(reply.report.results.length, 2);
    for (const result of reply.report.results) {
      assert.equal(result.ok, true);
      assert.equal(result.attempts.length, 1, "a healthy unit runs exactly once");
      assert.ok(result.nodeId);
    }
    assert.equal(localRuns.length + remoteRuns.length, 2, "every unit ran on exactly one Node");
    // In-flight slot accounting settled back to zero on every Node.
    const state = JSON.parse(
      readFileSync(join(home, "connector", "fleet-state.json"), "utf8"),
    ) as FleetState;
    assert.ok(state.nodes.every((node) => node.slotsInUse === 0));
  });

  it("refuses as data when no Node is eligible", async () => {
    const home = makeTempHome("burst-none");
    seedRegistry(home, [fleetNode({ id: "studio-a", reserveMode: true })]);
    // No pulse: the local Node is the only entry and it defaults eligible, so
    // reserve it too — the Fleet then has nowhere to schedule.
    const handlers = makeHandlers(home, {});
    await handlers.nodeReserve({ nodeId: "laptop", reserveMode: true });

    const reply = await handlers.burst({ units: [{ id: "probe-1", command: "echo one" }] });

    assert.equal(reply.ok, false);
    if (reply.ok) return;
    assert.equal(reply.code, "burst-failed");
    assert.match(reply.error, /no eligible online Node/);
  });
});

describe("connector.gossip.sync", () => {
  it("pulls strictly newer peer artifacts last-write-wins through the injected transports", async () => {
    const home = makeTempHome("gossip");
    seedRegistry(home, [fleetNode({ id: "studio-a" })]);
    const pulseTransport = stubTransport({
      "studio-a": {
        freePoolUpdatedAt: "2026-10-17T11:00:00.000Z",
        runsUpdatedAt: "2026-10-17T11:00:00.000Z",
      },
    }).transport;
    const gossipFiles = new Map<string, string>([
      ["burn-lab/free-pool.json", '{"updatedAt":"2026-10-17T11:00:00.000Z","best":"glm"}\n'],
      ["burn-lab/runs/run-9.json", '{"id":"run-9","updatedAt":"2026-10-17T11:00:00.000Z"}\n'],
      ["burn-lab/runs/run-9/report.md", "# run-9 report\n"],
    ]);
    const gossipReads: string[] = [];
    const gossipTransport: GossipArtifactTransport = {
      async readFile(node, relativePath) {
        gossipReads.push(`${node.id}:${relativePath}`);
        return gossipFiles.get(relativePath) ?? null;
      },
      async listFiles(node, relativeDir) {
        gossipReads.push(`${node.id}:list:${relativeDir}`);
        return relativeDir === "burn-lab/runs" ? ["run-9.json"] : [];
      },
    };
    const handlers = makeHandlers(home, { transport: pulseTransport, gossipTransport });

    const reply = await handlers.gossipSync({});

    assert.equal(reply.ok, true, reply.ok ? "" : reply.error);
    if (!reply.ok) return;
    assert.deepEqual(reply.report.freePool, [{ nodeId: "studio-a", updatedAt: "2026-10-17T11:00:00.000Z" }]);
    assert.deepEqual(reply.report.runs, [{ nodeId: "studio-a", runId: "run-9", updatedAt: "2026-10-17T11:00:00.000Z" }]);
    assert.equal(
      readFileSync(join(home, "burn-lab", "free-pool.json"), "utf8"),
      gossipFiles.get("burn-lab/free-pool.json"),
    );
    assert.ok(existsSync(join(home, "burn-lab", "runs", "run-9", "report.md")));

    // LWW settles: a second pass against the same stamps pulls nothing new.
    const again = await handlers.gossipSync({});
    assert.ok(again.ok);
    if (!again.ok) return;
    assert.deepEqual(again.report, { freePool: [], runs: [] });
  });
});

describe("connector.ref.land", () => {
  it("applies a staged Fleet ref via checkout through the surface", async () => {
    const home = makeTempHome("land");
    seedRegistry(home, []);
    // The initiating repo plus a peer's completion bundle staged under refs/fleet.
    const repo = await initRepo(join(makeTempDir("land-repo"), "proj"));
    writeFileSync(join(repo, "file.txt"), "base\n", "utf8");
    const base = await commitAll(repo, "base");
    const peer = join(makeTempDir("land-peer"), "proj");
    await execFileAsync("git", ["clone", "-q", repo, peer]);
    writeFileSync(join(peer, "file.txt"), "peer-wins\n", "utf8");
    await execFileAsync("git", ["-C", peer, "commit", "-aqm", "peer completion"]);
    const bundle = await createCommitBundle({
      repoPath: peer,
      base,
      outPath: join(makeTempDir("land-bundle"), "completion.bundle"),
    });
    await stageFleetRefFromBundle({
      repoPath: repo,
      bundlePath: bundle.bundlePath,
      nodeId: "studio-a",
      runOrTaskId: "run-42",
    });
    const handlers = makeHandlers(home);

    const reply = await handlers.refLand({
      repoPath: repo,
      nodeId: "studio-a",
      runOrTaskId: "run-42",
      mode: "checkout",
    });

    assert.equal(reply.ok, true, reply.ok ? "" : reply.error);
    if (!reply.ok) return;
    assert.equal(reply.landed.branch, "fleet/studio-a/run-42");
    assert.equal(reply.landed.mode, "checkout");
    assert.match(reply.landed.commit, /^[0-9a-f]{40}$/);
    assert.equal((await git(repo, "rev-parse", "HEAD")).trim(), reply.landed.commit);
  });

  it("refuses as data when the Fleet ref is not staged in the repository", async () => {
    const home = makeTempHome("land-missing");
    seedRegistry(home, []);
    const repo = await initRepo(join(makeTempDir("land-missing-repo"), "proj"));
    writeFileSync(join(repo, "file.txt"), "base\n", "utf8");
    await commitAll(repo, "base");
    const handlers = makeHandlers(home);

    const reply = await handlers.refLand({
      repoPath: repo,
      nodeId: "studio-a",
      runOrTaskId: "run-404",
    });

    assert.equal(reply.ok, false);
    if (reply.ok) return;
    assert.equal(reply.code, "land-failed");
    assert.match(reply.error, /not staged/);
  });
});

describe("connector.log.read", () => {
  /** Writes an inbound `Handoff` record whose run executed on this Node. */
  function seedHandoffRecord(
    home: string,
    record: { handoffId: string; runOrTaskId: string; logPath: string | null },
  ): void {
    mkdirSync(join(home, "connector", "handoffs"), { recursive: true });
    writeFileSync(
      join(home, "connector", "handoffs", `${record.handoffId}.json`),
      JSON.stringify(
        {
          version: 1,
          handoffId: record.handoffId,
          direction: "inbound",
          sourceNodeId: "laptop",
          targetNodeId: "studio-a",
          runOrTaskId: record.runOrTaskId,
          kind: "burn-run",
          status: "running",
          brief: { command: "npx burn run", playbook: null, prompt: null },
          canonicalSlug: "my-proj",
          bundle: {
            fileName: "commit.bundle",
            includeTarFileName: null,
            baseCommit: "0".repeat(40),
            headCommit: "1".repeat(40),
            branch: "main",
          },
          expectedFleetRef: `refs/fleet/studio-a/${record.runOrTaskId}`,
          mirrorPath: null,
          pid: "31337",
          logPath: record.logPath,
          dispatchedAt: NOW.toISOString(),
          startedAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
          error: null,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  it("serves the handoff log tail and the gossip-synced report, capped digest-first", async () => {
    const home = makeTempHome("log-read");
    // An inbound record whose detached run wrote a log well past the cap…
    const logPath = join(home, "connector", "handoffs", "ho-9.log");
    const lines = Array.from({ length: 7000 }, (_, i) => `line-${String(i).padStart(4, "0")}`);
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
    seedHandoffRecord(home, { handoffId: "ho-9", runOrTaskId: "run-42", logPath });
    // …plus a gossip-synced report.md under the run's id, and an outbound
    // record on the initiator side whose logPath is null.
    const reportPath = join(home, "burn-lab", "runs", "run-42", "report.md");
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, "# run-42 report\n", "utf8");
    seedHandoffRecord(home, { handoffId: "ho-out", runOrTaskId: "run-43", logPath: null });
    const handlers = makeHandlers(home);

    const reply = await handlers.logRead({ handoffId: "ho-9" });

    assert.equal(reply.ok, true, reply.ok ? "" : reply.error);
    if (!reply.ok) return;
    assert.equal(reply.log.logPath, logPath);
    assert.ok(reply.log.logTail !== null, "the log tail is served");
    assert.ok(reply.log.logTail.includes("line-6999"), "the tail reaches the log's end");
    assert.ok(!reply.log.logTail.includes("line-0000"), "the head was truncated away");
    assert.ok(
      Buffer.byteLength(reply.log.logTail, "utf8") <= 64 * 1024 + 200,
      "digest-first cap holds",
    );
    assert.equal(reply.log.report, "# run-42 report\n");
    assert.equal(reply.log.reportPath, reportPath);

    // An outbound record with no local log still answers (report-only view).
    const outbound = await handlers.logRead({ handoffId: "ho-out" });
    assert.equal(outbound.ok, true);
    if (!outbound.ok) return;
    assert.equal(outbound.log.logPath, null);
    assert.equal(outbound.log.logTail, null);
  });

  it("refuses as data for a handoff this Node has no record of", async () => {
    const home = makeTempHome("log-read-unknown");
    seedRegistry(home, []);
    const handlers = makeHandlers(home);

    const reply = await handlers.logRead({ handoffId: "ho-404" });

    assert.equal(reply.ok, false);
    if (reply.ok) return;
    assert.equal(reply.code, "unknown-handoff");
    assert.match(reply.error, /ho-404/);
  });
});

describe("connector.tailscale.discover", () => {
  it("parses the tailnet the injected runner reports for the Node editor", async () => {
    const home = makeTempHome("discover");
    seedRegistry(home, []);
    const statusJson = JSON.stringify({
      Peer: {
        "key-1": { HostName: "studio-a", DNSName: "studio-a.tail-net.ts.net.", TailscaleIPs: ["100.101.102.103"], Online: true, OS: "macOS" },
        "key-2": { HostName: "wsl-box", DNSName: "wsl-box.tail-net.ts.net.", TailscaleIPs: ["100.101.102.104"], Online: false, OS: "linux" },
      },
    });
    const handlers = makeHandlers(home, {
      discoveryRunner: {
        async run() {
          return { stdout: statusJson, stderr: "" };
        },
      },
    });

    const reply = await handlers.tailscaleDiscover({});

    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    assert.deepEqual(reply.peers, [
      { id: "studio-a", name: "studio-a", dnsName: "studio-a.tail-net.ts.net", tailscaleIp: "100.101.102.103", online: true, os: "macOS" },
      { id: "wsl-box", name: "wsl-box", dnsName: "wsl-box.tail-net.ts.net", tailscaleIp: "100.101.102.104", online: false, os: "linux" },
    ]);
  });

  it("refuses as data when the tailscale CLI is unavailable", async () => {
    const home = makeTempHome("discover-fail");
    seedRegistry(home, []);
    const handlers = makeHandlers(home, {
      discoveryRunner: {
        async run() {
          throw new Error("tailscale: command not found");
        },
      },
    });

    const reply = await handlers.tailscaleDiscover({});

    assert.equal(reply.ok, false);
    if (reply.ok) return;
    assert.equal(reply.code, "discovery-failed");
    assert.match(reply.error, /tailscale/);
  });
});
