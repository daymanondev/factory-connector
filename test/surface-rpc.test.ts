/**
 * The `Fleet surface`'s RPC handlers (spec.md "Testing Decisions") against a
 * temp injected paseo home: every network/SSH/git seam is stubbed, so nothing
 * here ever touches the real `~/.paseo-factory`, `~/.paseo`, or the network.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
