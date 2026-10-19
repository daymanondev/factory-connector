/**
 * Fleet registry, `Health guard`, and low-bandwidth `Fleet pulse` core.
 *
 * Owns the persistent peer `Fleet` registry (`<paseoHome>/connector/fleet.json`)
 * and the live `Fleet pulse` snapshot (`<paseoHome>/connector/fleet-state.json`)
 * that backs the `Fleet surface` UI and the `Connector bridge`.
 *
 * Pure Node module (mirrored verbatim into `plugin/server/core/` by
 * `npm run sync:plugin-core`). Every network/SSH seam is injectable so tests
 * run fully offline against temp directories.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

/** Physical availability classification of a `Node`. */
export type NodePosture = "stationary" | "mobile";

/** How a `Node` is reached from this machine: directly (local) or over Tailscale SSH. */
export type NodeTransport = "local" | "ssh";

/** CPU/RAM thresholds above which a `Node` refuses new delegated work. */
export interface HealthGuard {
  maxCpuPercent: number;
  minFreeMemMb: number;
}

/** One machine registered in the `Fleet` registry. */
export interface FleetNode {
  id: string;
  name: string;
  posture: NodePosture;
  transport: NodeTransport;
  /** `ssh://user@100.x.y.z?daemonPort=6767` style Tailscale target (SSH nodes only). */
  sshTarget?: string;
  /** Daemon endpoint advertised by the `Node` (SSH nodes only). */
  paseoEndpoint?: string;
  /**
   * `<paseoHome>` on the remote `Node` used to locate its `connector/` state
   * over SSH. Defaults to `~/.paseo-factory` (the trial home per AGENTS.md).
   */
  remotePaseoHome?: string;
  slotCeiling: number;
  reserveMode: boolean;
  healthGuard: HealthGuard;
}

/** Input accepted by `upsertNode`: identity + posture are required, the rest defaults. */
export type FleetNodeInput = Pick<FleetNode, "id" | "name" | "posture"> &
  Partial<Omit<FleetNode, "id" | "name" | "posture">>;

/** Contents of `<paseoHome>/connector/fleet.json`. */
export interface FleetConfig {
  version: 1;
  localNodeId: string;
  nodes: FleetNode[];
}

/** Compact per-`Meter` totals carried inside a `Fleet pulse` digest. */
export type MeterSummary = Record<string, number>;

/**
 * The sub-kilobyte `Fleet pulse` digest exchanged between `Node`s
 * (ADR 0001 §3: digest-first transport, never token/log streaming).
 */
export interface FleetPulse {
  nodeId: string;
  online: boolean;
  cpuPercent: number;
  freeMemMb: number;
  activeAgents: number;
  activeBurnRuns: number;
  meterSummary: MeterSummary | null;
  freePoolUpdatedAt: string | null;
  runsUpdatedAt: string | null;
  /** ISO timestamp of when this digest was collected on its `Node`. */
  collectedAt: string;
}

/** A `Fleet pulse` merged with the `Node`'s registry facts — one row of `fleet-state.json`. */
export interface FleetNodeState extends FleetPulse {
  name: string;
  posture: NodePosture;
  slotCeiling: number;
  reserveMode: boolean;
  healthGuard: HealthGuard;
  /** Delegated work units currently assigned to the `Node` (maintained by dispatch). */
  slotsInUse: number;
  /** Why the last pulse fetch failed for an offline `Node`, if it did. */
  lastError: string | null;
}

/** Contents of `<paseoHome>/connector/fleet-state.json` (the `Connector bridge` input). */
export interface FleetState {
  version: 1;
  localNodeId: string;
  updatedAt: string;
  nodes: FleetNodeState[];
}

export const FLEET_CONFIG_FILENAME = "fleet.json";
export const FLEET_STATE_FILENAME = "fleet-state.json";

/** `Slot ceiling` applied to newly registered `Node`s. */
export const DEFAULT_SLOT_CEILING = 2;

/** `Health guard` thresholds applied to newly registered `Node`s. */
export const DEFAULT_HEALTH_GUARD: HealthGuard = {
  maxCpuPercent: 85,
  minFreeMemMb: 2048,
};

/** Remote home assumed when a `Node` does not carry `remotePaseoHome`. */
export const DEFAULT_REMOTE_PASEO_HOME = "~/.paseo-factory";

export function connectorDir(paseoHome: string): string {
  return join(paseoHome, "connector");
}

export function fleetConfigPath(paseoHome: string): string {
  return join(connectorDir(paseoHome), FLEET_CONFIG_FILENAME);
}

export function fleetStatePath(paseoHome: string): string {
  return join(connectorDir(paseoHome), FLEET_STATE_FILENAME);
}

function slugifyHostName(host: string): string {
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "local";
}

/**
 * The `Node` entry every fresh registry starts from: this machine, reachable
 * locally. Posture defaults to `mobile` — an unclassified machine is treated as
 * one that may disconnect, which is the conservative scheduling default.
 */
export function defaultLocalNode(): FleetNode {
  const host = os.hostname();
  return {
    id: slugifyHostName(host),
    name: host,
    posture: "mobile",
    transport: "local",
    slotCeiling: DEFAULT_SLOT_CEILING,
    reserveMode: false,
    healthGuard: { ...DEFAULT_HEALTH_GUARD },
  };
}

export function defaultFleetConfig(): FleetConfig {
  const local = defaultLocalNode();
  return { version: 1, localNodeId: local.id, nodes: [local] };
}

/**
 * Atomically writes a JSON file (temp file + rename) so a concurrent reader
 * never observes a torn write. Shared with `dispatch.ts`'s record/state
 * persistence — both files mirror together into `plugin/server/core/`.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/**
 * Loads the `Fleet` registry. A missing file yields the default config (single
 * local `Node`) without writing anything; a corrupted file throws rather than
 * silently resetting the operator's registered `Node`s.
 */
export function loadFleetConfig(paseoHome: string): FleetConfig {
  const path = fleetConfigPath(paseoHome);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return defaultFleetConfig();
  }
  try {
    return JSON.parse(raw) as FleetConfig;
  } catch (error) {
    throw new Error(
      `factory-connector: corrupted fleet registry at ${path}: ${(error as Error).message}`,
    );
  }
}

export function saveFleetConfig(paseoHome: string, config: FleetConfig): void {
  writeJsonAtomic(fleetConfigPath(paseoHome), config);
}

function assertValidNodeInput(input: FleetNodeInput): void {
  if (typeof input.id !== "string" || input.id.trim().length === 0) {
    throw new Error("factory-connector: Node id must be a non-empty string");
  }
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    throw new Error(`factory-connector: Node ${input.id}: name must be a non-empty string`);
  }
  if (input.posture !== "stationary" && input.posture !== "mobile") {
    throw new Error(
      `factory-connector: Node ${input.id}: posture must be "stationary" or "mobile", got ${JSON.stringify(input.posture)}`,
    );
  }
  if (input.slotCeiling !== undefined && (!Number.isInteger(input.slotCeiling) || input.slotCeiling < 1)) {
    throw new Error(
      `factory-connector: Node ${input.id}: slotCeiling must be a positive integer, got ${JSON.stringify(input.slotCeiling)}`,
    );
  }
  // A non-finite Health guard would make every guard comparison fail and
  // silently bar the Node from scheduling — refuse it at the door.
  if (input.healthGuard !== undefined) {
    const { maxCpuPercent, minFreeMemMb } = input.healthGuard;
    if (
      typeof maxCpuPercent !== "number" ||
      !Number.isFinite(maxCpuPercent) ||
      maxCpuPercent <= 0 ||
      maxCpuPercent > 100
    ) {
      throw new Error(
        `factory-connector: Node ${input.id}: healthGuard.maxCpuPercent must be a finite number in (0, 100], got ${JSON.stringify(maxCpuPercent)}`,
      );
    }
    if (typeof minFreeMemMb !== "number" || !Number.isFinite(minFreeMemMb) || minFreeMemMb < 0) {
      throw new Error(
        `factory-connector: Node ${input.id}: healthGuard.minFreeMemMb must be a finite number >= 0, got ${JSON.stringify(minFreeMemMb)}`,
      );
    }
  }
}

function normalizeNode(input: FleetNodeInput): FleetNode {
  assertValidNodeInput(input);
  const node: FleetNode = {
    id: input.id,
    name: input.name,
    posture: input.posture,
    transport: input.transport ?? "ssh",
    remotePaseoHome: input.remotePaseoHome ?? DEFAULT_REMOTE_PASEO_HOME,
    slotCeiling: input.slotCeiling ?? DEFAULT_SLOT_CEILING,
    reserveMode: input.reserveMode ?? false,
    healthGuard: input.healthGuard ?? { ...DEFAULT_HEALTH_GUARD },
  };
  // Keep optional keys out of the stored shape entirely so an in-memory config
  // deep-equals its serialized round-trip.
  if (input.sshTarget !== undefined) node.sshTarget = input.sshTarget;
  if (input.paseoEndpoint !== undefined) node.paseoEndpoint = input.paseoEndpoint;
  return node;
}

/**
 * Registers or updates a `Node` in the `Fleet` registry. Unspecified optional
 * fields fall back to their defaults (not to previously stored values), so a
 * full editor payload is expected when keeping custom settings.
 */
export function upsertNode(paseoHome: string, input: FleetNodeInput): FleetConfig {
  const config = loadFleetConfig(paseoHome);
  const node = normalizeNode(input);
  const index = config.nodes.findIndex((candidate) => candidate.id === node.id);
  if (index === -1) {
    config.nodes.push(node);
  } else {
    config.nodes[index] = node;
  }
  saveFleetConfig(paseoHome, config);
  return config;
}

/** Toggles `Reserve mode` (stops the `Node` accepting background delegated work). */
export function setNodeReserveMode(
  paseoHome: string,
  nodeId: string,
  reserveMode: boolean,
): FleetConfig {
  const config = loadFleetConfig(paseoHome);
  const node = config.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new Error(`factory-connector: no Node with id ${JSON.stringify(nodeId)} in the Fleet`);
  }
  node.reserveMode = reserveMode;
  saveFleetConfig(paseoHome, config);
  return config;
}

/**
 * Unregisters a peer `Node` from the `Fleet` registry. The local `Node`
 * (`localNodeId`) cannot be removed — the registry would lose its anchor and
 * every subsequent fold would mislabel who is running this connector.
 */
export function removeNode(paseoHome: string, nodeId: string): FleetConfig {
  const config = loadFleetConfig(paseoHome);
  if (nodeId === config.localNodeId) {
    throw new Error(
      "factory-connector: the local Node cannot be removed from the Fleet registry",
    );
  }
  const index = config.nodes.findIndex((candidate) => candidate.id === nodeId);
  if (index === -1) {
    throw new Error(`factory-connector: no Node with id ${JSON.stringify(nodeId)} in the Fleet`);
  }
  config.nodes.splice(index, 1);
  saveFleetConfig(paseoHome, config);
  return config;
}

/** Local machine facts a `Fleet pulse` is built from, minus transport bookkeeping. */
export interface LocalPulseSample {
  cpuPercent: number;
  freeMemMb: number;
  activeAgents?: number;
  activeBurnRuns?: number;
  meterSummary?: MeterSummary | null;
  freePoolUpdatedAt?: string | null;
  runsUpdatedAt?: string | null;
}

/** Injectable source of the local `Node`'s pulse facts (tests pass a stub). */
export type LocalPulseSource = () => Promise<LocalPulseSample>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sampleCpuPercent(sampleDelayMs = 120): Promise<number> {
  const total = (snapshot: ReturnType<typeof os.cpus>) =>
    snapshot.reduce(
      (acc, cpu) => {
        const idle = cpu.times.idle;
        const all = cpu.times.idle + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq;
        return { idle: acc.idle + idle, all: acc.all + all };
      },
      { idle: 0, all: 0 },
    );
  const start = total(os.cpus());
  await sleep(sampleDelayMs);
  const end = total(os.cpus());
  const allDelta = end.all - start.all;
  if (allDelta <= 0) return 0;
  const busyDelta = allDelta - (end.idle - start.idle);
  return Math.min(100, Math.max(0, Math.round((busyDelta / allDelta) * 1000) / 10));
}

const TERMINAL_BURN_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "aborted"]);

/**
 * Inspects `<paseoHome>` for active `Burn run`s (`burn-lab/runs/*.json` and
 * inbound `connector/handoffs/*.json`) plus the newest `free-pool.json` and
 * `runs/*.json` timestamps that drive `Gossip sync`.
 */
function readLocalBurnActivity(paseoHome: string): {
  activeBurnRuns: number;
  freePoolUpdatedAt: string | null;
  runsUpdatedAt: string | null;
} {
  let freePoolUpdatedAt: string | null = null;
  try {
    const parsed = JSON.parse(
      readFileSync(join(paseoHome, "burn-lab", "free-pool.json"), "utf8"),
    ) as { updatedAt?: unknown };
    if (typeof parsed.updatedAt === "string" && !Number.isNaN(Date.parse(parsed.updatedAt))) {
      freePoolUpdatedAt = parsed.updatedAt;
    }
  } catch {
    // Missing or unreadable free-pool.json simply yields null.
  }

  const activeRunIds = new Set<string>();
  let runsUpdatedAt: string | null = null;
  let newestRunMs = 0;

  try {
    const runsDir = join(paseoHome, "burn-lab", "runs");
    for (const file of readdirSync(runsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(runsDir, file), "utf8")) as {
          id?: unknown;
          status?: unknown;
          updatedAt?: unknown;
        };
        const runId = typeof parsed.id === "string" && parsed.id !== "" ? parsed.id : file.slice(0, -5);
        if (typeof parsed.status === "string" && !TERMINAL_BURN_RUN_STATUSES.has(parsed.status)) {
          activeRunIds.add(runId);
        }
        if (typeof parsed.updatedAt === "string") {
          const ms = Date.parse(parsed.updatedAt);
          if (!Number.isNaN(ms) && ms > newestRunMs) {
            newestRunMs = ms;
            runsUpdatedAt = parsed.updatedAt;
          }
        }
      } catch {
        // Malformed run files are ignored.
      }
    }
  } catch {
    // No burn-lab/runs directory yet.
  }

  try {
    const handoffsDir = join(paseoHome, "connector", "handoffs");
    for (const file of readdirSync(handoffsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(handoffsDir, file), "utf8")) as {
          direction?: unknown;
          status?: unknown;
          runOrTaskId?: unknown;
          handoffId?: unknown;
        };
        if (parsed.direction === "inbound" && parsed.status === "running") {
          const id =
            typeof parsed.runOrTaskId === "string" && parsed.runOrTaskId !== ""
              ? parsed.runOrTaskId
              : typeof parsed.handoffId === "string"
                ? parsed.handoffId
                : file.slice(0, -5);
          activeRunIds.add(id);
        }
      } catch {
        // Malformed handoff records are ignored.
      }
    }
  } catch {
    // No connector/handoffs directory yet.
  }

  return {
    activeBurnRuns: activeRunIds.size,
    freePoolUpdatedAt,
    runsUpdatedAt,
  };
}

/**
 * Production `LocalPulseSource`: inspects `<paseoHome>` for active `Burn run`s
 * and `Gossip sync` artifact stamps, plus OS CPU/memory telemetry. Running
 * Paseo `Agent` counts are supplied by the plugin server layer via the daemon API.
 */
export function defaultLocalPulseSource(paseoHome?: string): LocalPulseSource {
  return async () => {
    const [cpuPercent, freeMemBytes] = [await sampleCpuPercent(), os.freemem()];
    const activity = paseoHome !== undefined ? readLocalBurnActivity(paseoHome) : null;
    return {
      cpuPercent,
      freeMemMb: Math.round(freeMemBytes / (1024 * 1024)),
      activeAgents: 0,
      activeBurnRuns: activity?.activeBurnRuns ?? 0,
      meterSummary: null,
      freePoolUpdatedAt: activity?.freePoolUpdatedAt ?? null,
      runsUpdatedAt: activity?.runsUpdatedAt ?? null,
    };
  };
}

/** Assembles the local `Node`'s sub-kilobyte `Fleet pulse` digest. */
export async function collectLocalPulse(input: {
  nodeId: string;
  source?: LocalPulseSource;
  now?: () => Date;
}): Promise<FleetPulse> {
  const source = input.source ?? defaultLocalPulseSource();
  const sample = await source();
  return {
    nodeId: input.nodeId,
    online: true,
    cpuPercent: sample.cpuPercent,
    freeMemMb: sample.freeMemMb,
    activeAgents: sample.activeAgents ?? 0,
    activeBurnRuns: sample.activeBurnRuns ?? 0,
    meterSummary: sample.meterSummary ?? null,
    freePoolUpdatedAt: sample.freePoolUpdatedAt ?? null,
    runsUpdatedAt: sample.runsUpdatedAt ?? null,
    collectedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
}

/** Background `Fleet pulse` cadence (idle, `Fleet surface` closed). */
export const PULSE_INTERVAL_IDLE_MS = 60_000;

/** Active `Fleet pulse` cadence while the `Fleet surface` is open (5–10s window, ADR 0001 §3). */
export const PULSE_INTERVAL_ACTIVE_MS = 10_000;

/** The effective pulse interval for the given surface visibility. */
export function pulseIntervalMs(activeSurface: boolean): number {
  return activeSurface ? PULSE_INTERVAL_ACTIVE_MS : PULSE_INTERVAL_IDLE_MS;
}

/**
 * Adaptive-cadence gate: true when a poll is due given the previous snapshot's
 * `updatedAt` and whether the `Fleet surface` is currently open.
 */
export function shouldPollNow(
  previous: FleetState | null,
  options: { activeSurface: boolean; nowMs: number },
): boolean {
  if (!previous) return true;
  const updatedAt = Date.parse(previous.updatedAt);
  if (Number.isNaN(updatedAt)) return true;
  return options.nowMs - updatedAt >= pulseIntervalMs(options.activeSurface);
}

/**
 * Injectable seam for fetching a peer `Node`'s `Fleet pulse` digest.
 * Production default is Tailscale SSH (`createSshPulseTransport`); tests pass a stub.
 */
export interface PulseTransport {
  fetchPulse(node: FleetNode): Promise<FleetPulse>;
}

/** Default ceiling for a single peer pulse fetch before the `Node` is marked offline. */
export const PULSE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Races a promise against a deadline, rejecting with a labelled timeout.
 * Shared with `dispatch.ts`'s pulse-fetch/attempt ceilings.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function offlineNodeState(node: FleetNode, error: string): FleetNodeState {
  const trimmed = error.length > 300 ? `${error.slice(0, 300)}…` : error;
  return {
    nodeId: node.id,
    online: false,
    cpuPercent: 0,
    freeMemMb: 0,
    activeAgents: 0,
    activeBurnRuns: 0,
    meterSummary: null,
    freePoolUpdatedAt: null,
    runsUpdatedAt: null,
    collectedAt: new Date().toISOString(),
    name: node.name,
    posture: node.posture,
    slotCeiling: node.slotCeiling,
    reserveMode: node.reserveMode,
    healthGuard: node.healthGuard,
    slotsInUse: 0,
    lastError: trimmed,
  };
}

function mergeNodeState(node: FleetNode, pulse: FleetPulse, slotsInUse: number): FleetNodeState {
  return {
    nodeId: node.id,
    online: pulse.online,
    cpuPercent: pulse.cpuPercent,
    freeMemMb: pulse.freeMemMb,
    activeAgents: pulse.activeAgents,
    activeBurnRuns: pulse.activeBurnRuns,
    meterSummary: pulse.meterSummary ?? null,
    freePoolUpdatedAt: pulse.freePoolUpdatedAt ?? null,
    runsUpdatedAt: pulse.runsUpdatedAt ?? null,
    collectedAt: pulse.collectedAt,
    name: node.name,
    posture: node.posture,
    slotCeiling: node.slotCeiling,
    reserveMode: node.reserveMode,
    healthGuard: node.healthGuard,
    slotsInUse,
    lastError: null,
  };
}

/**
 * Reads the live `Fleet pulse` snapshot. Unlike the registry, a corrupted or
 * missing snapshot is reported as `null` — it is a cache the next poll rewrites.
 */
export function loadFleetState(paseoHome: string): FleetState | null {
  try {
    return JSON.parse(readFileSync(fleetStatePath(paseoHome), "utf8")) as FleetState;
  } catch {
    return null;
  }
}

/**
 * Atomically writes the `Fleet pulse` snapshot. Dispatch uses this to record
 * `slotsInUse` bookkeeping in place; the next `pollFleetPulse` carries the
 * values over.
 */
export function saveFleetState(paseoHome: string, state: FleetState): void {
  writeJsonAtomic(fleetStatePath(paseoHome), state);
}

/**
 * Options accepted by `pollFleetPulse` (and, verbatim, by its cached wrapper
 * `pollFleetPulseCached`).
 */
export interface PollFleetPulseOptions {
  paseoHome: string;
  transport?: PulseTransport;
  localSource?: LocalPulseSource;
  fetchTimeoutMs?: number;
  now?: () => Date;
}

/**
 * Collects the local `Fleet pulse`, fetches every peer `Node`'s digest through
 * the injectable `PulseTransport` (a failing or timed-out peer is recorded as
 * offline instead of failing the poll), and writes the merged snapshot to
 * `<paseoHome>/connector/fleet-state.json` for the `Fleet surface` and the
 * `Connector bridge`. `slotsInUse` values recorded by dispatch are carried
 * over from the previous snapshot.
 */
export async function pollFleetPulse(options: PollFleetPulseOptions): Promise<FleetState> {
  const config = loadFleetConfig(options.paseoHome);
  const transport = options.transport;
  const timeoutMs = options.fetchTimeoutMs ?? PULSE_FETCH_TIMEOUT_MS;

  const previousSlots = new Map(
    (loadFleetState(options.paseoHome)?.nodes ?? []).map((node) => [node.nodeId, node.slotsInUse]),
  );

  const localPulse = await collectLocalPulse({
    nodeId: config.localNodeId,
    source: options.localSource ?? defaultLocalPulseSource(options.paseoHome),
    now: options.now,
  });

  const nodes: FleetNodeState[] = await Promise.all(
    config.nodes.map(async (node) => {
      const slotsInUse = previousSlots.get(node.id) ?? 0;
      if (node.id === config.localNodeId) {
        return mergeNodeState(node, localPulse, slotsInUse);
      }
      if (!transport) {
        return offlineNodeState(node, "no PulseTransport configured");
      }
      try {
        const pulse = await withTimeout(
          transport.fetchPulse(node),
          timeoutMs,
          `factory-connector: pulse fetch for ${node.id}`,
        );
        return mergeNodeState(node, pulse, slotsInUse);
      } catch (error) {
        return offlineNodeState(node, (error as Error).message);
      }
    }),
  );

  const state: FleetState = {
    version: 1,
    localNodeId: config.localNodeId,
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
    nodes,
  };
  writeJsonAtomic(fleetStatePath(options.paseoHome), state);
  return state;
}

/**
 * How long a settled `Fleet pulse` snapshot satisfies new callers without
 * re-running transports. Half the active poll cadence, so the `Fleet surface`
 * clock and this cache never disagree about freshness.
 */
export const PULSE_CACHE_TTL_MS = 5_000;

type PulseCacheEntry = {
  inFlight: Promise<FleetState> | null;
  state: FleetState | null;
  settledAtMs: number;
};

/**
 * Module-level snapshot cache, keyed per `paseoHome` (the trial/prod isolation
 * law — a trial home and a prod home never share an entry).
 */
const pulseCache = new Map<string, PulseCacheEntry>();

/**
 * `pollFleetPulse` behind an in-memory single-flight + TTL cache: concurrent
 * callers over one `<paseoHome>` share a single in-flight collection, and a
 * snapshot younger than `PULSE_CACHE_TTL_MS` is served as-is, with zero
 * transport runs — the daemon RPC storm prevention for the `Fleet surface`
 * poll path. A failed poll is never cached: the entry is dropped so the next
 * caller retries immediately.
 */
export function pollFleetPulseCached(options: PollFleetPulseOptions): Promise<FleetState> {
  const clock = options.now ?? (() => new Date());
  const existing = pulseCache.get(options.paseoHome);
  const entry: PulseCacheEntry = existing ?? { inFlight: null, state: null, settledAtMs: 0 };
  if (existing === undefined) {
    pulseCache.set(options.paseoHome, entry);
  }
  if (entry.state !== null && clock().getTime() - entry.settledAtMs < PULSE_CACHE_TTL_MS) {
    return Promise.resolve(entry.state);
  }
  if (entry.inFlight !== null) {
    return entry.inFlight;
  }
  const inFlight = pollFleetPulse(options).then(
    (state) => {
      entry.inFlight = null;
      entry.state = state;
      entry.settledAtMs = clock().getTime();
      return state;
    },
    (error: unknown) => {
      // Never cache a failure — drop the entry (only if it is still this one)
      // so the next caller starts a fresh collection.
      if (pulseCache.get(options.paseoHome) === entry) {
        pulseCache.delete(options.paseoHome);
      }
      throw error;
    },
  );
  entry.inFlight = inFlight;
  return inFlight;
}

/** What the caller is selecting candidates for. */
export type SelectionPurpose = "handoff" | "burst";

export interface EligibilityQuery {
  purpose: SelectionPurpose;
  /** Keep only `stationary` `Node`s (`Handoff` with an auto-stationary target). */
  requireStationary?: boolean;
  /** `Node`s to skip, e.g. the initiating `Node` for a `Handoff`. */
  excludeNodeIds?: string[];
}

/** An eligible candidate with its remaining `Slot ceiling` headroom. */
export interface EligibleNode {
  node: FleetNodeState;
  freeSlots: number;
}

function effectiveBusySlots(node: FleetNodeState): number {
  return Math.max(node.slotsInUse, node.activeBurnRuns);
}

/**
 * Filters and ranks candidate `Node`s for `Handoff` or `Burst` against the
 * `Fleet pulse` snapshot. Capacity is determined by active workload on the
 * `Node` (never OS CPU/RAM heuristics): a `Node` is eligible when it is
 * online, not in `Reserve mode`, and its active workload (`slotsInUse` and
 * `activeBurnRuns`) is below its `Slot ceiling`. Ranking: `stationary`
 * before `mobile`, then most free slots, then fewest active burn runs, then
 * fewest active agents.
 */
export function selectEligibleNodes(state: FleetState, query: EligibilityQuery): EligibleNode[] {
  const excluded = new Set(query.excludeNodeIds ?? []);
  return state.nodes
    .filter((node) => !excluded.has(node.nodeId))
    .filter((node) => node.online)
    .filter((node) => !node.reserveMode)
    .filter((node) => effectiveBusySlots(node) < node.slotCeiling)
    .filter((node) => query.requireStationary !== true || node.posture === "stationary")
    .map((node) => ({ node, freeSlots: node.slotCeiling - effectiveBusySlots(node) }))
    .sort((a, b) => {
      const postureRank = (entry: EligibleNode) => (entry.node.posture === "stationary" ? 0 : 1);
      if (postureRank(a) !== postureRank(b)) return postureRank(a) - postureRank(b);
      if (a.freeSlots !== b.freeSlots) return b.freeSlots - a.freeSlots;
      if (a.node.activeBurnRuns !== b.node.activeBurnRuns) {
        return a.node.activeBurnRuns - b.node.activeBurnRuns;
      }
      if (a.node.activeAgents !== b.node.activeAgents) {
        return a.node.activeAgents - b.node.activeAgents;
      }
      return a.node.nodeId.localeCompare(b.node.nodeId);
    });
}

/**
 * Injectable seam for every shell-out this core performs (SSH, `tailscale`).
 * The plugin server layer can adapt this to the SDK's `execCommand`; tests pass
 * a stub so nothing here ever touches the network.
 */
export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options?: { timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string }>;
}

const execFileAsync = promisify(execFile);

/** Production `CommandRunner` backed by `node:child_process.execFile`. */
export const execCommandRunner: CommandRunner = {
  async run(command, args, options) {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: options?.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr };
  },
};

/** The pieces of an `ssh://user@host?daemonPort=6767` target the transport needs. */
export interface SshTargetParts {
  user: string | undefined;
  host: string;
  daemonPort: number | undefined;
}

export function parseSshTarget(sshTarget: string): SshTargetParts {
  let url: URL;
  try {
    url = new URL(sshTarget);
  } catch {
    throw new Error(`factory-connector: malformed sshTarget ${JSON.stringify(sshTarget)}`);
  }
  if (url.protocol !== "ssh:") {
    throw new Error(
      `factory-connector: sshTarget must use the ssh:// scheme, got ${JSON.stringify(sshTarget)}`,
    );
  }
  if (!url.hostname) {
    throw new Error(`factory-connector: sshTarget is missing a host: ${JSON.stringify(sshTarget)}`);
  }
  const daemonPortParam = url.searchParams.get("daemonPort");
  const daemonPort = daemonPortParam === null ? undefined : Number(daemonPortParam);
  if (daemonPort !== undefined && (!Number.isInteger(daemonPort) || daemonPort <= 0)) {
    throw new Error(
      `factory-connector: sshTarget has an invalid daemonPort: ${JSON.stringify(sshTarget)}`,
    );
  }
  return { user: url.username || undefined, host: url.hostname, daemonPort };
}

/**
 * Production `PulseTransport`: reads the peer's own digest out of its
 * `<paseoHome>/connector/fleet-state.json` over Tailscale SSH in BatchMode.
 * Digest-first — one small file read per poll, never token/log streaming.
 */
export function createSshPulseTransport(options?: {
  runner?: CommandRunner;
  connectTimeoutSeconds?: number;
}): PulseTransport {
  const runner = options?.runner ?? execCommandRunner;
  const connectTimeout = options?.connectTimeoutSeconds ?? 5;
  return {
    async fetchPulse(node) {
      if (!node.sshTarget) {
        throw new Error(`factory-connector: Node ${node.id} has no sshTarget to poll`);
      }
      const { user, host } = parseSshTarget(node.sshTarget);
      const destination = user ? `${user}@${host}` : host;
      const remoteHome = node.remotePaseoHome ?? DEFAULT_REMOTE_PASEO_HOME;
      const remoteCommand = `cat ${remoteHome}/connector/${FLEET_STATE_FILENAME}`;
      const { stdout } = await runner.run(
        "ssh",
        ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeout}`, destination, remoteCommand],
        { timeoutMs: PULSE_FETCH_TIMEOUT_MS },
      );
      let peerState: FleetState;
      try {
        peerState = JSON.parse(stdout) as FleetState;
      } catch (error) {
        throw new Error(
          `factory-connector: Node ${node.id} returned an unparsable fleet-state: ${(error as Error).message}`,
        );
      }
      const own = peerState.nodes?.find((entry) => entry.nodeId === peerState.localNodeId);
      if (!own) {
        throw new Error(
          `factory-connector: Node ${node.id} fleet-state carries no entry for its local Node`,
        );
      }
      return {
        nodeId: own.nodeId,
        online: own.online,
        cpuPercent: own.cpuPercent,
        freeMemMb: own.freeMemMb,
        activeAgents: own.activeAgents,
        activeBurnRuns: own.activeBurnRuns,
        meterSummary: own.meterSummary ?? null,
        freePoolUpdatedAt: own.freePoolUpdatedAt ?? null,
        runsUpdatedAt: own.runsUpdatedAt ?? null,
        collectedAt: own.collectedAt,
      };
    },
  };
}

/** A Tailscale peer as reported by `tailscale status --json`, distilled for registration. */
export interface TailscalePeer {
  /** Slug derived from the hostname — usable as a `FleetNode` id candidate. */
  id: string;
  name: string;
  dnsName: string;
  tailscaleIp: string;
  online: boolean;
  os: string;
}

/** Parses `tailscale status --json` stdout into `TailscalePeer` descriptors. */
export function parseTailscalePeers(statusJson: string): TailscalePeer[] {
  let parsed: { Peer?: Record<string, Record<string, unknown>> };
  try {
    parsed = JSON.parse(statusJson) as { Peer?: Record<string, Record<string, unknown>> };
  } catch (error) {
    throw new Error(
      `factory-connector: unparsable tailscale status output: ${(error as Error).message}`,
    );
  }
  const peers: TailscalePeer[] = [];
  for (const peer of Object.values(parsed.Peer ?? {})) {
    const hostName = typeof peer.HostName === "string" ? peer.HostName : "";
    const ips = Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs : [];
    const ip = typeof ips[0] === "string" ? ips[0] : "";
    if (!hostName || !ip) continue;
    const dnsName = typeof peer.DNSName === "string" ? peer.DNSName.replace(/\.$/, "") : "";
    peers.push({
      id: slugifyHostName(hostName),
      name: hostName,
      dnsName,
      tailscaleIp: ip,
      online: peer.Online === true,
      os: typeof peer.OS === "string" ? peer.OS : "unknown",
    });
  }
  return peers.sort((a, b) => a.name.localeCompare(b.name));
}

/** Discovers Tailscale peers for the `Node` registration helper (ADR 0001 §3). */
export async function discoverTailscalePeers(runner: CommandRunner = execCommandRunner): Promise<TailscalePeer[]> {
  const { stdout } = await runner.run("tailscale", ["status", "--json"]);
  return parseTailscalePeers(stdout);
}

/** Options accepted when adopting a discovered Tailscale peer into the registry. */
export interface PeerAdoptOptions {
  /** SSH user on the peer — required: pulse fetches run `ssh -o BatchMode=yes user@host`. */
  user: string;
  posture?: NodePosture;
  /** Overrides the hostname-slug id (e.g. when two machines share a hostname). */
  id?: string;
  name?: string;
}

/**
 * Turns a discovered Tailscale peer into a `FleetNodeInput` for `upsertNode`:
 * the one-call path from `tailscale discover` to a registered, pollable `Node`.
 */
export function tailscalePeerToNodeInput(
  peer: TailscalePeer,
  options: PeerAdoptOptions,
): FleetNodeInput {
  if (typeof options.user !== "string" || options.user.trim().length === 0) {
    throw new Error("factory-connector: adopting a Tailscale peer requires a non-empty SSH user");
  }
  return {
    id: options.id ?? peer.id,
    name: options.name ?? peer.name,
    posture: options.posture ?? "mobile",
    transport: "ssh",
    sshTarget: `ssh://${options.user}@${peer.tailscaleIp}`,
  };
}

/**
 * Guards `node adopt` against the shared-hostname trap: two machines both
 * named "Mac" both slug to id "mac", and the adopt would shadow the registry's
 * local anchor. The operator disambiguates with an explicit id override.
 */
export function assertAdoptableNodeId(config: FleetConfig, id: string): void {
  if (id === config.localNodeId) {
    throw new Error(
      `factory-connector: adopt id ${JSON.stringify(id)} collides with the local Node id — pass an explicit id override`,
    );
  }
}
