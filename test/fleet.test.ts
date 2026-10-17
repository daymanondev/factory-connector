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
  pollFleetPulse,
  loadFleetState,
  fleetStatePath,
  selectEligibleNodes,
  parseSshTarget,
  createSshPulseTransport,
  parseTailscalePeers,
  discoverTailscalePeers,
  type FleetState,
  type FleetNodeState,
  type FleetPulse,
  type PulseTransport,
  type CommandRunner,
} from "../src/fleet.ts";

function makePulse(overrides: Partial<FleetPulse> & { nodeId: string }): FleetPulse {
  return {
    online: true,
    cpuPercent: 10,
    freeMemMb: 4096,
    activeAgents: 0,
    activeBurnRuns: 0,
    meterSummary: null,
    freePoolUpdatedAt: null,
    runsUpdatedAt: null,
    collectedAt: "2026-10-17T10:00:00.000Z",
    ...overrides,
  };
}

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

  it("rejects a non-finite Health guard instead of persisting a guard that silently excludes the Node", () => {
    const home = makeTempHome();
    // NaN / Infinity maxCpuPercent: every comparison against it fails, which
    // would permanently bar the Node from scheduling with no error surfaced.
    assert.throws(
      () =>
        upsertNode(home, {
          id: "nan-cpu",
          name: "NaN CPU",
          posture: "mobile",
          healthGuard: { maxCpuPercent: Number.NaN, minFreeMemMb: 2048 },
        }),
      /maxCpuPercent/,
    );
    assert.throws(
      () =>
        upsertNode(home, {
          id: "inf-cpu",
          name: "Inf CPU",
          posture: "mobile",
          healthGuard: { maxCpuPercent: Number.POSITIVE_INFINITY, minFreeMemMb: 2048 },
        }),
      /maxCpuPercent/,
    );
    assert.throws(
      () =>
        upsertNode(home, {
          id: "out-of-range",
          name: "Out of range",
          posture: "mobile",
          healthGuard: { maxCpuPercent: 0, minFreeMemMb: 2048 },
        }),
      /maxCpuPercent/,
    );
    assert.throws(
      () =>
        upsertNode(home, {
          id: "nan-mem",
          name: "NaN mem",
          posture: "mobile",
          healthGuard: { maxCpuPercent: 85, minFreeMemMb: Number.NaN },
        }),
      /minFreeMemMb/,
    );
    assert.throws(
      () =>
        upsertNode(home, {
          id: "neg-mem",
          name: "Negative mem",
          posture: "mobile",
          healthGuard: { maxCpuPercent: 85, minFreeMemMb: -1 },
        }),
      /minFreeMemMb/,
    );
    // A partial guard object is refused too (missing field is not a number).
    assert.throws(
      () =>
        upsertNode(home, {
          id: "partial",
          name: "Partial",
          posture: "mobile",
          healthGuard: { maxCpuPercent: 85 } as never,
        }),
      /minFreeMemMb/,
    );
    // Nothing was persisted by the rejected calls.
    assert.equal(loadFleetConfig(home).nodes.length, 1);
    // A sane guard still registers.
    upsertNode(home, {
      id: "sane",
      name: "Sane",
      posture: "mobile",
      healthGuard: { maxCpuPercent: 50, minFreeMemMb: 0 },
    });
    assert.equal(loadFleetConfig(home).nodes.length, 2);
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

describe("Fleet pulse polling (pollFleetPulse → fleet-state.json)", () => {
  function seededHome(): string {
    const home = makeTempHome();
    upsertNode(home, {
      id: "mac-studio",
      name: "Mac Studio",
      posture: "stationary",
      sshTarget: "ssh://andrew@100.101.102.103?daemonPort=6767",
    });
    upsertNode(home, {
      id: "win-wsl",
      name: "Windows WSL2",
      posture: "stationary",
      slotCeiling: 4,
      healthGuard: { maxCpuPercent: 50, minFreeMemMb: 8192 },
    });
    return home;
  }

  const localSource = async () => ({
    cpuPercent: 30,
    freeMemMb: 6144,
    activeAgents: 2,
  });

  it("polls local + peer Nodes through the transport and writes the merged snapshot", async () => {
    const home = seededHome();
    const config = loadFleetConfig(home);
    const polled: string[] = [];
    const transport: PulseTransport = {
      fetchPulse: async (node) => {
        polled.push(node.id);
        return makePulse({ nodeId: node.id, cpuPercent: 20 });
      },
    };

    const updatedAt = new Date("2026-10-17T10:00:00.000Z");
    const state = await pollFleetPulse({
      paseoHome: home,
      transport,
      localSource,
      now: () => updatedAt,
    });

    assert.deepEqual(polled, ["mac-studio", "win-wsl"]);
    assert.equal(state.localNodeId, config.localNodeId);
    assert.equal(state.updatedAt, updatedAt.toISOString());
    assert.equal(state.nodes.length, 3);

    const local = state.nodes.find((node) => node.nodeId === config.localNodeId);
    assert.ok(local);
    assert.equal(local.online, true);
    assert.equal(local.cpuPercent, 30);
    assert.equal(local.activeAgents, 2);

    const studio = state.nodes.find((node) => node.nodeId === "mac-studio");
    assert.ok(studio);
    assert.equal(studio.name, "Mac Studio");
    assert.equal(studio.posture, "stationary");
    assert.equal(studio.slotCeiling, DEFAULT_SLOT_CEILING);
    assert.equal(studio.reserveMode, false);
    assert.deepEqual(studio.healthGuard, DEFAULT_HEALTH_GUARD);
    assert.equal(studio.slotsInUse, 0);

    const wsl = state.nodes.find((node) => node.nodeId === "win-wsl");
    assert.ok(wsl);
    assert.equal(wsl.slotCeiling, 4);
    assert.deepEqual(wsl.healthGuard, { maxCpuPercent: 50, minFreeMemMb: 8192 });

    // The snapshot is on disk for the Connector bridge and deep-equals what
    // loadFleetState reads back.
    const onDisk = JSON.parse(readFileSync(fleetStatePath(home), "utf8"));
    assert.deepEqual(onDisk, state);
    assert.deepEqual(loadFleetState(home), state);
  });

  it("marks a peer offline with lastError when its transport fetch fails, without failing the poll", async () => {
    const home = seededHome();
    const transport: PulseTransport = {
      fetchPulse: async (node) => {
        if (node.id === "win-wsl") throw new Error("ssh: connect timeout");
        return makePulse({ nodeId: node.id });
      },
    };

    const state = await pollFleetPulse({ paseoHome: home, transport, localSource });

    const wsl = state.nodes.find((node) => node.nodeId === "win-wsl");
    assert.ok(wsl);
    assert.equal(wsl.online, false);
    assert.match(wsl.lastError ?? "", /ssh: connect timeout/);

    const studio = state.nodes.find((node) => node.nodeId === "mac-studio");
    assert.ok(studio);
    assert.equal(studio.online, true);
    assert.equal(studio.lastError, null);

    // Snapshot still written with the offline node recorded.
    assert.equal(existsSync(fleetStatePath(home)), true);
  });

  it("carries over slotsInUse from the previous snapshot so dispatch accounting survives repolls", async () => {
    const home = seededHome();
    const transport: PulseTransport = {
      fetchPulse: async (node) => makePulse({ nodeId: node.id }),
    };

    const first = await pollFleetPulse({ paseoHome: home, transport, localSource });
    const studio = first.nodes.find((node) => node.nodeId === "mac-studio");
    assert.ok(studio);
    studio.slotsInUse = 2; // as dispatch (ticket 03) would record in flight units

    writeFileSync(fleetStatePath(home), JSON.stringify(first, null, 2), "utf8");

    const second = await pollFleetPulse({ paseoHome: home, transport, localSource });
    const studioAgain = second.nodes.find((node) => node.nodeId === "mac-studio");
    assert.ok(studioAgain);
    assert.equal(studioAgain.slotsInUse, 2);
    const wslAgain = second.nodes.find((node) => node.nodeId === "win-wsl");
    assert.ok(wslAgain);
    assert.equal(wslAgain.slotsInUse, 0);
  });

  it("loadFleetState returns null when no snapshot exists yet", () => {
    const home = makeTempHome();
    assert.equal(loadFleetState(home), null);
  });
});

describe("candidate selection (selectEligibleNodes)", () => {
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

  function fleetOf(nodes: FleetNodeState[]): FleetState {
    return { version: 1, localNodeId: "laptop", updatedAt: "2026-10-17T10:00:00.000Z", nodes };
  }

  it("drops offline, Reserve mode, Health guard violating, and slot-saturated Nodes", () => {
    const state = fleetOf([
      nodeState({ nodeId: "healthy" }),
      nodeState({ nodeId: "offline", online: false }),
      nodeState({ nodeId: "reserved", reserveMode: true }),
      nodeState({ nodeId: "hot-cpu", cpuPercent: 99, healthGuard: { maxCpuPercent: 85, minFreeMemMb: 2048 } }),
      nodeState({ nodeId: "low-mem", freeMemMb: 512 }),
      nodeState({ nodeId: "saturated", slotsInUse: 2, slotCeiling: 2 }),
    ]);

    const eligible = selectEligibleNodes(state, { purpose: "burst" });
    assert.deepEqual(
      eligible.map((entry) => entry.node.nodeId),
      ["healthy"],
    );
    assert.equal(eligible[0].freeSlots, 2);
  });

  it("ranks stationary before mobile, then most free slots, then lower CPU, then more free RAM", () => {
    const state = fleetOf([
      nodeState({ nodeId: "mobile-idle", posture: "mobile", cpuPercent: 5, freeMemMb: 16384 }),
      nodeState({ nodeId: "studio-busy", posture: "stationary", cpuPercent: 80, slotsInUse: 1, slotCeiling: 4 }),
      nodeState({ nodeId: "studio-hot", posture: "stationary", cpuPercent: 40, slotCeiling: 4 }),
      nodeState({ nodeId: "studio-cool", posture: "stationary", cpuPercent: 40, slotCeiling: 4, freeMemMb: 16384 }),
    ]);

    const eligible = selectEligibleNodes(state, { purpose: "handoff" });
    // studio-cool vs studio-hot tie on posture/free slots/cpu → more free RAM wins;
    // studio-busy ranks below both on free slots despite being more idle on CPU.
    assert.deepEqual(
      eligible.map((entry) => entry.node.nodeId),
      ["studio-cool", "studio-hot", "studio-busy", "mobile-idle"],
    );
  });

  it("honours requireStationary (auto-stationary Handoff) and excludeNodeIds (the initiator)", () => {
    const state = fleetOf([
      nodeState({ nodeId: "laptop", posture: "mobile" }),
      nodeState({ nodeId: "studio-a", posture: "stationary" }),
      nodeState({ nodeId: "studio-b", posture: "stationary", slotsInUse: 1, slotCeiling: 2 }),
    ]);

    const eligible = selectEligibleNodes(state, {
      purpose: "handoff",
      requireStationary: true,
      excludeNodeIds: ["studio-a"],
    });
    assert.deepEqual(
      eligible.map((entry) => entry.node.nodeId),
      ["studio-b"],
    );
    assert.equal(eligible[0].freeSlots, 1);
  });

  it("treats Health guard boundaries as inclusive (at-threshold still eligible)", () => {
    const state = fleetOf([
      nodeState({
        nodeId: "at-edge",
        cpuPercent: 85,
        freeMemMb: 2048,
        healthGuard: { maxCpuPercent: 85, minFreeMemMb: 2048 },
      }),
    ]);
    const eligible = selectEligibleNodes(state, { purpose: "burst" });
    assert.equal(eligible.length, 1);
  });
});

describe("SSH pulse transport (createSshPulseTransport)", () => {
  it("parses ssh:// targets into user, host, and daemonPort", () => {
    assert.deepEqual(parseSshTarget("ssh://andrew@100.101.102.103?daemonPort=6767"), {
      user: "andrew",
      host: "100.101.102.103",
      daemonPort: 6767,
    });
    assert.deepEqual(parseSshTarget("ssh://100.101.102.103"), {
      user: undefined,
      host: "100.101.102.103",
      daemonPort: undefined,
    });
    assert.throws(() => parseSshTarget("http://not-ssh.example"), /ssh/);
  });

  it("fetches the peer's own digest from its fleet-state.json over BatchMode SSH via the injected runner", async () => {
    const peerState = {
      version: 1,
      localNodeId: "mac-studio",
      updatedAt: "2026-10-17T10:00:00.000Z",
      nodes: [
        makePulse({ nodeId: "mac-studio", cpuPercent: 42, freeMemMb: 1024, activeBurnRuns: 2 }),
        makePulse({ nodeId: "other", cpuPercent: 1 }),
      ].map((pulse) => ({
        ...pulse,
        name: pulse.nodeId,
        posture: "stationary",
        slotCeiling: 2,
        reserveMode: false,
        healthGuard: { maxCpuPercent: 85, minFreeMemMb: 2048 },
        slotsInUse: 0,
        lastError: null,
      })),
    };

    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      run: async (command, args) => {
        calls.push({ command, args });
        return { stdout: JSON.stringify(peerState), stderr: "" };
      },
    };

    const transport = createSshPulseTransport({ runner });
    const pulse = await transport.fetchPulse({
      id: "mac-studio",
      name: "Mac Studio",
      posture: "stationary",
      transport: "ssh",
      sshTarget: "ssh://andrew@100.101.102.103?daemonPort=6767",
      remotePaseoHome: "/home/andrew/.paseo-factory",
      slotCeiling: 2,
      reserveMode: false,
      healthGuard: { maxCpuPercent: 85, minFreeMemMb: 2048 },
    });

    assert.equal(pulse.nodeId, "mac-studio");
    assert.equal(pulse.cpuPercent, 42);
    assert.equal(pulse.activeBurnRuns, 2);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "ssh");
    const args = calls[0].args;
    assert.ok(args.includes("BatchMode=yes"));
    assert.ok(args.includes("ConnectTimeout=5"));
    assert.ok(args.includes("andrew@100.101.102.103"));
    const remote = args[args.length - 1];
    assert.equal(remote, "cat /home/andrew/.paseo-factory/connector/fleet-state.json");
  });

  it("propagates runner failures so pollFleetPulse records the Node offline", async () => {
    const runner: CommandRunner = {
      run: async () => {
        throw new Error("ssh: connect to host refused");
      },
    };
    const transport = createSshPulseTransport({ runner });
    await assert.rejects(
      () =>
        transport.fetchPulse({
          id: "mac-studio",
          name: "Mac Studio",
          posture: "stationary",
          transport: "ssh",
          sshTarget: "ssh://100.101.102.103",
          slotCeiling: 2,
          reserveMode: false,
          healthGuard: { maxCpuPercent: 85, minFreeMemMb: 2048 },
        }),
      /refused/,
    );
  });
});

describe("Tailscale peer discovery", () => {
  const tailscaleStatusJson = JSON.stringify({
    Peer: {
      "nodekey:aaaa": {
        DNSName: "mac-studio.tailnet.ts.net.",
        HostName: "Mac-Studio",
        TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
        Online: true,
        OS: "macOS",
      },
      "nodekey:bbbb": {
        DNSName: "win-wsl.tailnet.ts.net.",
        HostName: "DESKTOP-WIN",
        TailscaleIPs: ["100.101.102.104"],
        Online: false,
        OS: "linux",
      },
    },
  });

  it("parses `tailscale status --json` output into peer descriptors", () => {
    const peers = parseTailscalePeers(tailscaleStatusJson);
    assert.equal(peers.length, 2);

    const studio = peers.find((peer) => peer.tailscaleIp === "100.101.102.103");
    assert.ok(studio);
    assert.equal(studio.name, "Mac-Studio");
    assert.equal(studio.dnsName, "mac-studio.tailnet.ts.net");
    assert.equal(studio.online, true);
    assert.equal(studio.os, "macOS");

    const win = peers.find((peer) => peer.tailscaleIp === "100.101.102.104");
    assert.ok(win);
    assert.equal(win.online, false);
  });

  it("discovers peers through the injected CommandRunner (no real binary, no network)", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      run: async (command, args) => {
        calls.push({ command, args });
        return { stdout: tailscaleStatusJson, stderr: "" };
      },
    };

    const peers = await discoverTailscalePeers(runner);
    assert.deepEqual(calls, [{ command: "tailscale", args: ["status", "--json"] }]);
    assert.equal(peers.length, 2);
  });
});
