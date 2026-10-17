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

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

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
  const host = hostname();
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

function writeJsonAtomic(path: string, value: unknown): void {
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
