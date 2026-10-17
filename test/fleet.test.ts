import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HEALTH_GUARD,
  DEFAULT_SLOT_CEILING,
  loadFleetConfig,
  saveFleetConfig,
  fleetConfigPath,
  upsertNode,
  setNodeReserveMode,
  collectLocalPulse,
  defaultLocalPulseSource,
  pulseIntervalMs,
  shouldPollNow,
  PULSE_INTERVAL_ACTIVE_MS,
  PULSE_INTERVAL_IDLE_MS,
  type FleetState,
} from "../src/fleet.ts";

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-connector-fleet-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("fleet registry persistence (<paseoHome>/connector/fleet.json)", () => {
  it("loads a default config with a single local Node entry when fleet.json is missing", () => {
    const home = makeTempHome();
    const config = loadFleetConfig(home);

    assert.equal(config.localNodeId, config.nodes[0].id);
    assert.equal(config.nodes.length, 1);

    const local = config.nodes[0];
    assert.equal(local.transport, "local");
    assert.equal(local.posture, "mobile");
    assert.equal(local.slotCeiling, DEFAULT_SLOT_CEILING);
    assert.equal(local.reserveMode, false);
    assert.deepEqual(local.healthGuard, DEFAULT_HEALTH_GUARD);
    assert.ok(local.id.length > 0);
    assert.ok(local.name.length > 0);

    // Loading alone must not create the file on disk.
    assert.equal(existsSync(fleetConfigPath(home)), false);
  });

  it("saves fleet.json under <paseoHome>/connector/ (creating the directory) and roundtrips", () => {
    const home = makeTempHome();
    const config = loadFleetConfig(home);
    saveFleetConfig(home, config);

    const path = fleetConfigPath(home);
    assert.equal(existsSync(path), true);

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(onDisk, config);

    const reloaded = loadFleetConfig(home);
    assert.deepEqual(reloaded, config);
  });

  it("refuses to silently reset a corrupted registry, throwing with the file path", () => {
    const home = makeTempHome();
    mkdirSync(join(home, "connector"), { recursive: true });
    writeFileSync(fleetConfigPath(home), "{ not json", "utf8");

    assert.throws(() => loadFleetConfig(home), (error: Error) => {
      assert.match(error.message, /fleet\.json/);
      return true;
    });
  });
});

describe("Node registration (upsertNode)", () => {
  it("registers a peer Node with defaults filled in and persists it alongside the local Node", () => {
    const home = makeTempHome();
    const config = upsertNode(home, {
      id: "mac-studio",
      name: "Mac Studio",
      posture: "stationary",
      sshTarget: "ssh://andrew@100.101.102.103?daemonPort=6767",
    });

    assert.equal(config.nodes.length, 2);
    const peer = config.nodes.find((node) => node.id === "mac-studio");
    assert.ok(peer);
    assert.equal(peer.transport, "ssh");
    assert.equal(peer.posture, "stationary");
    assert.equal(peer.slotCeiling, DEFAULT_SLOT_CEILING);
    assert.equal(peer.reserveMode, false);
    assert.deepEqual(peer.healthGuard, DEFAULT_HEALTH_GUARD);

    // Persisted: a fresh load sees both the default local Node and the peer.
    const reloaded = loadFleetConfig(home);
    assert.deepEqual(reloaded, config);
    assert.ok(reloaded.nodes.some((node) => node.transport === "local"));
  });

  it("updates an existing Node in place (same id) without duplicating it", () => {
    const home = makeTempHome();
    upsertNode(home, {
      id: "win-wsl",
      name: "Windows WSL2",
      posture: "stationary",
      slotCeiling: 4,
    });
    const updated = upsertNode(home, {
      id: "win-wsl",
      name: "Windows WSL2 (lab)",
      posture: "stationary",
      slotCeiling: 6,
      reserveMode: true,
    });

    assert.equal(updated.nodes.filter((node) => node.id === "win-wsl").length, 1);
    const peer = updated.nodes.find((node) => node.id === "win-wsl");
    assert.ok(peer);
    assert.equal(peer.name, "Windows WSL2 (lab)");
    assert.equal(peer.slotCeiling, 6);
    assert.equal(peer.reserveMode, true);
  });

  it("rejects invalid Node input instead of persisting garbage", () => {
    const home = makeTempHome();
    assert.throws(() => upsertNode(home, { id: "", name: "x", posture: "mobile" }), /id/);
    assert.throws(
      () => upsertNode(home, { id: "a" as never, name: "x", posture: "laptop" as never }),
      /posture/,
    );
    assert.throws(
      () =>
        upsertNode(home, {
          id: "a",
          name: "x",
          posture: "mobile",
          slotCeiling: 0,
        }),
      /slotCeiling/,
    );
    // Nothing was persisted by the rejected calls.
    assert.equal(loadFleetConfig(home).nodes.length, 1);
  });
});

describe("Reserve mode (setNodeReserveMode)", () => {
  it("toggles Reserve mode on a Node and persists the change", () => {
    const home = makeTempHome();
    const config = loadFleetConfig(home);
    const nodeId = config.localNodeId;

    const reserved = setNodeReserveMode(home, nodeId, true);
    assert.equal(reserved.nodes.find((node) => node.id === nodeId)?.reserveMode, true);
    assert.equal(loadFleetConfig(home).nodes.find((node) => node.id === nodeId)?.reserveMode, true);

    const released = setNodeReserveMode(home, nodeId, false);
    assert.equal(released.nodes.find((node) => node.id === nodeId)?.reserveMode, false);
    assert.equal(loadFleetConfig(home).nodes.find((node) => node.id === nodeId)?.reserveMode, false);
  });

  it("throws for an unknown Node id", () => {
    const home = makeTempHome();
    assert.throws(() => setNodeReserveMode(home, "ghost", true), /ghost/);
  });
});

describe("Fleet pulse digest (collectLocalPulse)", () => {
  it("collects a sub-kilobyte pulse digest from an injected source with a deterministic clock", async () => {
    const collectedAt = new Date("2026-10-17T10:00:00.000Z");
    const pulse = await collectLocalPulse({
      nodeId: "mac",
      now: () => collectedAt,
      source: async () => ({
        cpuPercent: 23.5,
        freeMemMb: 8192,
        activeAgents: 3,
        activeBurnRuns: 1,
        meterSummary: { totalTokens: 120000, totalUsd: 1.25 },
        freePoolUpdatedAt: "2026-10-17T09:59:00.000Z",
        runsUpdatedAt: "2026-10-17T09:58:00.000Z",
      }),
    });

    assert.deepEqual(pulse, {
      nodeId: "mac",
      online: true,
      cpuPercent: 23.5,
      freeMemMb: 8192,
      activeAgents: 3,
      activeBurnRuns: 1,
      meterSummary: { totalTokens: 120000, totalUsd: 1.25 },
      freePoolUpdatedAt: "2026-10-17T09:59:00.000Z",
      runsUpdatedAt: "2026-10-17T09:58:00.000Z",
      collectedAt: "2026-10-17T10:00:00.000Z",
    });

    // The whole digest must stay sub-kilobyte on the wire (ADR 0001 §3).
    const digestBytes = Buffer.byteLength(JSON.stringify(pulse), "utf8");
    assert.ok(digestBytes < 1024, `digest was ${digestBytes} bytes`);
  });

  it("collects real local metrics with the default source (cpu in range, mem positive)", async () => {
    const pulse = await collectLocalPulse({ nodeId: "mac", source: defaultLocalPulseSource() });
    assert.equal(pulse.online, true);
    assert.ok(pulse.cpuPercent >= 0 && pulse.cpuPercent <= 100, `cpu ${pulse.cpuPercent}`);
    assert.ok(pulse.freeMemMb > 0, `freeMemMb ${pulse.freeMemMb}`);
    assert.equal(pulse.activeAgents, 0);
    assert.equal(pulse.activeBurnRuns, 0);
    assert.equal(pulse.meterSummary, null);
    assert.ok(!Number.isNaN(Date.parse(pulse.collectedAt)));
  });
});

describe("adaptive pulse cadence", () => {
  it("uses 60s background and 5s active-surface intervals", () => {
    assert.equal(PULSE_INTERVAL_IDLE_MS, 60_000);
    assert.equal(PULSE_INTERVAL_ACTIVE_MS, 5_000);
    assert.equal(pulseIntervalMs(false), 60_000);
    assert.equal(pulseIntervalMs(true), 5_000);
  });

  it("polls immediately without prior state, then respects the idle/active windows", () => {
    const t0 = Date.parse("2026-10-17T10:00:00.000Z");
    assert.equal(shouldPollNow(null, { activeSurface: false, nowMs: t0 }), true);

    const state = {
      version: 1,
      localNodeId: "mac",
      updatedAt: new Date(t0).toISOString(),
      nodes: [],
    } as FleetState;

    // Idle window (60s): too soon until the full minute elapses.
    assert.equal(shouldPollNow(state, { activeSurface: false, nowMs: t0 + 59_999 }), false);
    assert.equal(shouldPollNow(state, { activeSurface: false, nowMs: t0 + 60_000 }), true);

    // Active Fleet surface window (5s).
    assert.equal(shouldPollNow(state, { activeSurface: true, nowMs: t0 + 4_999 }), false);
    assert.equal(shouldPollNow(state, { activeSurface: true, nowMs: t0 + 5_000 }), true);
  });
});
