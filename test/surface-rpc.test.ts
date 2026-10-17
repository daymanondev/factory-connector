/**
 * The `Fleet surface`'s RPC handlers (spec.md "Testing Decisions") against a
 * temp injected paseo home: every network/SSH/git seam is stubbed, so nothing
 * here ever touches the real `~/.paseo-factory`, `~/.paseo`, or the network.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HEALTH_GUARD,
  pollFleetPulse,
  saveFleetConfig,
  type FleetNode,
  type FleetNodeState,
  type FleetPulse,
  type FleetState,
  type LocalPulseSource,
  type PulseTransport,
} from "../src/fleet.ts";
import { createSurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import type { SurfaceDeps, SurfaceHandlers } from "../plugin/server/surface-rpc.ts";
import { FleetViewSchema } from "../plugin/shared/view.ts";

/** Frozen clock — pulse cadence assertions are exact, never wall-clock flaky. */
const NOW = new Date("2026-10-17T10:00:00.000Z");
const fixedNow = () => NOW;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `factory-connector-${prefix}-`));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeTempHome(prefix: string): string {
  return makeTempDir(`${prefix}-home`);
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

/** Persists a registry whose local `Node` is the `laptop` (mobile initiator). */
function seedRegistry(home: string, nodes: FleetNode[]): void {
  saveFleetConfig(home, {
    version: 1,
    localNodeId: "laptop",
    nodes: [fleetNode({ id: "laptop", name: "Laptop", posture: "mobile", transport: "local" }), ...nodes],
  });
}

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
