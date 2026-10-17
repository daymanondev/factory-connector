/**
 * Autonomous `Handoff`, cooperative `Burst`, and `Connector bridge` core.
 *
 * `dispatchHandoff` packages an initiating `Node`'s `Project` as a `git bundle`
 * (reusing `createCommitBundle`), transfers it to a selected `Host node`
 * (preferring `stationary` `Node`s for `auto-stationary` targets via
 * `selectEligibleNodes`), and has the target's own connector stack
 * (`receiveHandoff`) provision its `Mirror repo` and spawn the detached run —
 * so the initiating `mobile` `Node` can disconnect immediately.
 * `executeBurst` distributes parallel work units across eligible online
 * `Node`s respecting `Slot ceiling`, `Health guard`, and `Reserve mode`,
 * retrying failed attempts on surviving `Node`s. `ensureConnectorBridge`
 * writes `fleet-state.json` and generates the `connector-dispatch` CLI wrapper
 * (`CONTEXT.md` "Connector bridge").
 *
 * Pure Node module (mirrored verbatim into `plugin/server/core/` by
 * `npm run sync:plugin-core`). Every network/SSH seam is injectable so tests
 * run fully offline against temp directories.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_REMOTE_PASEO_HOME,
  execCommandRunner,
  fleetStatePath,
  loadFleetConfig,
  parseSshTarget,
  pollFleetPulse,
  saveFleetState,
  selectEligibleNodes,
  type CommandRunner,
  type EligibleNode,
  type FleetNode,
  type FleetNodeState,
  type FleetState,
  type LocalPulseSource,
  type PulseTransport,
} from "./fleet.ts";
import { createCommitBundle, ensureMirrorRepoFromBundle, fleetRef, type CommitBundle } from "./git-sync.ts";

/**
 * Record of one `Handoff` job, kept on both sides: the initiator writes an
 * `outbound` record in `<paseoHome>/connector/handoffs/<handoffId>.json`, the
 * target `Host node` writes its `inbound` twin — each `Node`'s copy is
 * self-sufficient, which is what lets the initiator disconnect.
 */
export interface HandoffRecord {
  version: 1;
  handoffId: string;
  direction: "outbound" | "inbound";
  /** Initiating `Node` that transferred ownership. */
  sourceNodeId: string;
  /** `Host node` that owns the run start-to-finish from here on. */
  targetNodeId: string;
  runOrTaskId: string;
  kind: "burn-run" | "task";
  status: "dispatched" | "running" | "completed" | "failed";
  brief: {
    command: string;
    playbook: string | null;
    prompt: string | null;
  };
  canonicalSlug: string;
  bundle: {
    fileName: string;
    includeTarFileName: string | null;
    baseCommit: string;
    headCommit: string;
    branch: string;
  };
  /** `refs/fleet/<targetNodeId>/<runOrTaskId>` the completion will stage under. */
  expectedFleetRef: string;
  /** Set on the target side: where the detached run executes. */
  mirrorPath: string | null;
  pid: string | null;
  logPath: string | null;
  dispatchedAt: string;
  startedAt: string | null;
  updatedAt: string;
  error: string | null;
}

/** The manifest an initiator drops into the target's inbox — an outbound record. */
export type HandoffManifest = HandoffRecord;

/** File name of the handoff manifest inside the inbox directory. */
export const MANIFEST_FILENAME = "handoff.json";

/** Directory holding one handoff's staging artifacts (bundle, tar, manifest). */
export function handoffStagingDir(paseoHome: string, handoffId: string): string {
  return join(paseoHome, "connector", "handoffs", handoffId);
}

/** Path of the `<paseoHome>/connector/handoffs/<handoffId>.json` record. */
export function handoffRecordPath(paseoHome: string, handoffId: string): string {
  return join(paseoHome, "connector", "handoffs", `${handoffId}.json`);
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function saveHandoffRecord(paseoHome: string, record: HandoffRecord): void {
  writeJsonAtomic(handoffRecordPath(paseoHome, record.handoffId), record);
}

/** Reads a `Handoff` record; null when no such record exists. */
export function loadHandoff(paseoHome: string, handoffId: string): HandoffRecord | null {
  try {
    return JSON.parse(readFileSync(handoffRecordPath(paseoHome, handoffId), "utf8")) as HandoffRecord;
  } catch {
    return null;
  }
}

/**
 * Injectable seam for spawning the detached run on a `Node` (production:
 * `createShDetachedSpawn` — `nohup` under `sh`, surviving the parent). Tests
 * pass a stub so no real long-running process is ever started.
 */
export interface DetachedSpawn {
  spawn(options: { cwd: string; command: string; logPath: string }): Promise<{ pid: string }>;
}

/** Single-quotes a value for safe interpolation into a POSIX shell command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Production `DetachedSpawn`: `nohup`s the command under `sh` with output
 * appended to the log file, returning the background pid. `nohup` + `&`
 * detach the run from this process's lifetime — the `Host node` keeps it
 * running no matter what happens to the connector that spawned it.
 */
export function createShDetachedSpawn(runner: CommandRunner = execCommandRunner): DetachedSpawn {
  return {
    async spawn({ cwd, command, logPath }) {
      mkdirSync(dirname(logPath), { recursive: true });
      const script =
        `cd ${shellQuote(cwd)} && nohup sh -c ${shellQuote(command)} ` +
        `>> ${shellQuote(logPath)} 2>&1 & echo $!`;
      const { stdout } = await runner.run("sh", ["-c", script]);
      const pid = stdout.trim().split("\n").filter((line) => line !== "").pop() ?? "";
      return { pid };
    },
  };
}

function readManifest(manifestPath: string): HandoffManifest {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw new Error(
      `factory-connector: cannot read handoff manifest ${manifestPath}: ${(error as Error).message}`,
    );
  }
  let parsed: HandoffManifest;
  try {
    parsed = JSON.parse(raw) as HandoffManifest;
  } catch (error) {
    throw new Error(
      `factory-connector: handoff manifest ${manifestPath} is not valid JSON: ${(error as Error).message}`,
    );
  }
  const required: Array<keyof HandoffManifest> = [
    "handoffId",
    "sourceNodeId",
    "targetNodeId",
    "runOrTaskId",
    "kind",
    "brief",
    "canonicalSlug",
    "bundle",
    "expectedFleetRef",
  ];
  for (const field of required) {
    if (parsed[field] === undefined || parsed[field] === null) {
      throw new Error(`factory-connector: handoff manifest ${manifestPath} is missing ${field}`);
    }
  }
  if (typeof parsed.brief?.command !== "string" || parsed.brief.command.trim() === "") {
    throw new Error(
      `factory-connector: handoff manifest ${manifestPath} carries no brief.command to run`,
    );
  }
  return parsed;
}

/**
 * Target-side half of a `Handoff`: unpacks the inbox manifest delivered by the
 * initiator's `GitBundleTransport`, provisions/updates the `Mirror repo` via
 * `ensureMirrorRepoFromBundle` (with its `.worktreeinclude` payload extracted
 * over the checkout), spawns the detached run inside the mirror, and writes the
 * `inbound` record. Runs on the `Host node` itself — invoked there by the
 * `connector-dispatch receive-handoff` bridge command.
 */
export async function receiveHandoff(options: {
  paseoHome: string;
  manifestPath: string;
  runner?: CommandRunner;
  spawn?: DetachedSpawn;
  now?: () => Date;
}): Promise<HandoffRecord> {
  const manifest = readManifest(options.manifestPath);
  const inboxDir = dirname(options.manifestPath);
  const bundlePath = join(inboxDir, manifest.bundle.fileName);
  const includeTarPath =
    manifest.bundle.includeTarFileName !== null && manifest.bundle.includeTarFileName !== undefined
      ? join(inboxDir, manifest.bundle.includeTarFileName)
      : null;

  const mirror = await ensureMirrorRepoFromBundle({
    paseoHome: options.paseoHome,
    canonicalSlug: manifest.canonicalSlug,
    bundlePath,
    includeTarPath,
    runner: options.runner,
  });

  const spawn = options.spawn ?? createShDetachedSpawn();
  const logPath = join(options.paseoHome, "connector", "handoffs", `${manifest.handoffId}.log`);
  const { pid } = await spawn.spawn({
    cwd: mirror.mirrorPath,
    command: manifest.brief.command,
    logPath,
  });

  const startedAt = (options.now ?? (() => new Date()))().toISOString();
  const record: HandoffRecord = {
    version: 1,
    handoffId: manifest.handoffId,
    direction: "inbound",
    sourceNodeId: manifest.sourceNodeId,
    targetNodeId: manifest.targetNodeId,
    runOrTaskId: manifest.runOrTaskId,
    kind: manifest.kind,
    status: "running",
    brief: manifest.brief,
    canonicalSlug: manifest.canonicalSlug,
    bundle: manifest.bundle,
    expectedFleetRef: manifest.expectedFleetRef,
    mirrorPath: mirror.mirrorPath,
    pid,
    logPath,
    dispatchedAt: manifest.dispatchedAt,
    startedAt,
    updatedAt: startedAt,
    error: null,
  };
  saveHandoffRecord(options.paseoHome, record);
  return record;
}

/** Remote home assumed when a `Node` does not carry `remotePaseoHome`. */
export { DEFAULT_REMOTE_PASEO_HOME };

/**
 * Injectable seam for running a command on a peer `Node` (spec.md
 * "Injectable Transport Seams"). Production default is Tailscale SSH in
 * BatchMode (`createSshRemoteCommandRunner`); tests pass a stub.
 */
export interface RemoteCommandRunner {
  run(
    node: FleetNode,
    command: string,
    options?: { timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string }>;
}

/** Timeout ceiling for one remote handoff-receive invocation on a peer. */
export const HANDOFF_RECEIVE_TIMEOUT_MS = 120_000;

/** `ConnectTimeout` (seconds) used by the production SSH/SCP seams. */
export const SSH_CONNECT_TIMEOUT_SECONDS = 5;

function sshDestination(node: FleetNode): string {
  if (!node.sshTarget) {
    throw new Error(`factory-connector: Node ${node.id} has no sshTarget to reach`);
  }
  const { user, host } = parseSshTarget(node.sshTarget);
  return user ? `${user}@${host}` : host;
}

/** Production `RemoteCommandRunner`: Tailscale SSH in BatchMode. */
export function createSshRemoteCommandRunner(options?: {
  runner?: CommandRunner;
  connectTimeoutSeconds?: number;
}): RemoteCommandRunner {
  const runner = options?.runner ?? execCommandRunner;
  const connectTimeout = options?.connectTimeoutSeconds ?? SSH_CONNECT_TIMEOUT_SECONDS;
  return {
    async run(node, command, runOptions) {
      return runner.run(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          `ConnectTimeout=${connectTimeout}`,
          sshDestination(node),
          command,
        ],
        { timeoutMs: runOptions?.timeoutMs },
      );
    },
  };
}

/**
 * Injectable seam for moving a `git bundle` payload (and its manifest) onto a
 * peer `Node`. The contract: the file is placed inside `remoteDir` under its
 * own basename, and `remoteDir` is created if absent. Production default is
 * `scp` over Tailscale SSH; tests pass a stub.
 */
export interface GitBundleTransport {
  copyToNode(node: FleetNode, localPath: string, remoteDir: string): Promise<string>;
}

/** Timeout ceiling for one bundle copy to a peer. */
export const BUNDLE_COPY_TIMEOUT_MS = 300_000;

/** Production `GitBundleTransport`: `scp` over Tailscale SSH in BatchMode. */
export function createScpGitBundleTransport(options?: {
  runner?: CommandRunner;
  connectTimeoutSeconds?: number;
}): GitBundleTransport {
  const runner = options?.runner ?? execCommandRunner;
  const connectTimeout = options?.connectTimeoutSeconds ?? SSH_CONNECT_TIMEOUT_SECONDS;
  const sshOptions = ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeout}`];
  return {
    async copyToNode(node, localPath, remoteDir) {
      const destination = sshDestination(node);
      // scp does not create the destination directory.
      await runner.run(
        "ssh",
        [...sshOptions, destination, `mkdir -p ${shellQuote(remoteDir)}`],
        { timeoutMs: HANDOFF_RECEIVE_TIMEOUT_MS },
      );
      await runner.run(
        "scp",
        [...sshOptions, localPath, `${destination}:${remoteDir}`],
        { timeoutMs: BUNDLE_COPY_TIMEOUT_MS },
      );
      return `${remoteDir}/${basename(localPath)}`;
    },
  };
}

/** Target picker for `dispatchHandoff`: a `Node` id or the stationary-preferring auto mode. */
export const AUTO_STATIONARY = "auto-stationary";

/** Generates a handoff id from the run/task id, a timestamp, and a nonce. */
export function generateHandoffId(runOrTaskId: string, now: () => Date = () => new Date()): string {
  const stamp = now().toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "Z");
  return `${runOrTaskId}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function assertPathComponent(kind: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes("..")) {
    throw new Error(
      `factory-connector: invalid ${kind} ${JSON.stringify(value)}; must be alphanumeric-led ` +
        "without spaces, path separators, or '..'",
    );
  }
}

function parsePid(stdout: string): string | null {
  const lastLine = stdout.trim().split("\n").filter((line) => line !== "").pop();
  return lastLine !== undefined && /^\d+$/.test(lastLine) ? lastLine : null;
}

/** The brief an initiator hands a `Host node` with the run's `git bundle`. */
export interface HandoffBrief {
  kind: "burn-run" | "task";
  runOrTaskId: string;
  /** Detached command the target executes inside its `Mirror repo`. */
  command: string;
  playbook?: string | null;
  prompt?: string | null;
}

function selectHandoffTarget(
  state: FleetState,
  targetNodeId: string,
): FleetNodeState {
  if (targetNodeId !== AUTO_STATIONARY) {
    const target = state.nodes.find((node) => node.nodeId === targetNodeId);
    if (!target) {
      throw new Error(
        `factory-connector: cannot hand off to ${JSON.stringify(targetNodeId)}: no such Node in the Fleet snapshot`,
      );
    }
    if (target.nodeId === state.localNodeId) {
      throw new Error(
        "factory-connector: cannot hand off to the initiating Node itself",
      );
    }
    if (!target.online) {
      throw new Error(
        `factory-connector: cannot hand off to ${targetNodeId}: the Node is offline`,
      );
    }
    if (target.reserveMode) {
      throw new Error(
        `factory-connector: cannot hand off to ${targetNodeId}: the Node is in Reserve mode`,
      );
    }
    return target;
  }
  const candidates = selectEligibleNodes(state, {
    purpose: "handoff",
    requireStationary: true,
    excludeNodeIds: [state.localNodeId],
  });
  if (candidates.length === 0) {
    throw new Error(
      "factory-connector: no eligible stationary Node for an auto-stationary Handoff " +
        "(peers are offline, reserved, health-guarded, slot-saturated, or mobile)",
    );
  }
  return candidates[0].node;
}

/**
 * `Handoff` — full ownership transfer of a `Burn run` (or `Task`) to a `Host
 * node` so the initiating `Node` can disconnect immediately.
 *
 * Packages the source `Project`'s `<base>..HEAD` range plus `.worktreeinclude`
 * files (`createCommitBundle`), copies them into the target's
 * `connector/inbox/<handoffId>/`, and asks the target's own
 * `connector-dispatch receive-handoff` bridge command to provision its
 * `Mirror repo` and spawn the detached run. The outbound record written to
 * `<paseoHome>/connector/handoffs/<handoffId>.json` carries the
 * `expectedFleetRef` (`refs/fleet/<targetNodeId>/<runOrTaskId>`) the
 * completion will be staged under for later reconciliation.
 */
export async function dispatchHandoff(options: {
  paseoHome: string;
  /** Source `Project` repository to package. */
  projectPath: string;
  /** Exclusive start of the packaged `<base>..HEAD` range. */
  base: string;
  /** `Project` canonical slug naming the target `Mirror repo`. */
  canonicalSlug: string;
  brief: HandoffBrief;
  /** Current `Fleet pulse` snapshot used to pick and sanity-check the target. */
  state: FleetState;
  /** Explicit `Node` id or `"auto-stationary"` (default). */
  targetNodeId?: string;
  handoffId?: string;
  localRunner?: CommandRunner;
  bundleTransport?: GitBundleTransport;
  remoteRunner?: RemoteCommandRunner;
  now?: () => Date;
}): Promise<HandoffRecord> {
  const now = options.now ?? (() => new Date());
  const brief: HandoffRecord["brief"] = {
    command: options.brief.command,
    playbook: options.brief.playbook ?? null,
    prompt: options.brief.prompt ?? null,
  };
  const kind = options.brief.kind;
  const runOrTaskId = options.brief.runOrTaskId;
  if (kind !== "burn-run" && kind !== "task") {
    throw new Error(
      `factory-connector: handoff kind must be "burn-run" or "task", got ${JSON.stringify(kind)}`,
    );
  }
  if (typeof brief.command !== "string" || brief.command.trim() === "") {
    throw new Error("factory-connector: handoff brief.command is required (the detached run)");
  }
  assertPathComponent("canonical slug", options.canonicalSlug);

  const targetState = selectHandoffTarget(options.state, options.targetNodeId ?? AUTO_STATIONARY);
  const registry = new Map(loadFleetConfig(options.paseoHome).nodes.map((node) => [node.id, node]));
  const targetNode = registry.get(targetState.nodeId);
  if (!targetNode) {
    throw new Error(
      `factory-connector: Node ${targetState.nodeId} is not in the fleet registry at this home`,
    );
  }
  if (targetNode.transport !== "ssh") {
    throw new Error(
      `factory-connector: cannot hand off to ${targetNode.id}: Handoff targets must be ssh-transport Nodes`,
    );
  }
  const expectedFleetRef = fleetRef(targetNode.id, runOrTaskId);

  const handoffId = options.handoffId ?? generateHandoffId(runOrTaskId, now);
  assertPathComponent("handoff id", handoffId);
  const stagingDir = handoffStagingDir(options.paseoHome, handoffId);
  const bundle: CommitBundle = await createCommitBundle({
    repoPath: options.projectPath,
    base: options.base,
    outPath: join(stagingDir, "commit.bundle"),
    runner: options.localRunner,
  });

  const record: HandoffRecord = {
    version: 1,
    handoffId,
    direction: "outbound",
    sourceNodeId: options.state.localNodeId,
    targetNodeId: targetNode.id,
    runOrTaskId,
    kind,
    status: "dispatched",
    brief,
    canonicalSlug: options.canonicalSlug,
    bundle: {
      fileName: basename(bundle.bundlePath),
      includeTarFileName: bundle.includeTarPath ? basename(bundle.includeTarPath) : null,
      baseCommit: bundle.baseCommit,
      headCommit: bundle.headCommit,
      branch: bundle.branch,
    },
    expectedFleetRef,
    mirrorPath: null,
    pid: null,
    logPath: null,
    dispatchedAt: now().toISOString(),
    startedAt: null,
    updatedAt: now().toISOString(),
    error: null,
  };
  const manifestPath = join(stagingDir, MANIFEST_FILENAME);
  writeFileSync(manifestPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const transport = options.bundleTransport ?? createScpGitBundleTransport();
  const remoteRunner = options.remoteRunner ?? createSshRemoteCommandRunner();
  const remoteHome = targetNode.remotePaseoHome ?? DEFAULT_REMOTE_PASEO_HOME;
  const inboxDir = `${remoteHome}/connector/inbox/${handoffId}`;

  try {
    await transport.copyToNode(targetNode, bundle.bundlePath, inboxDir);
    if (bundle.includeTarPath) {
      await transport.copyToNode(targetNode, bundle.includeTarPath, inboxDir);
    }
    await transport.copyToNode(targetNode, manifestPath, inboxDir);
    const receiveCommand =
      `${remoteHome}/connector/bin/connector-dispatch receive-handoff ` +
      `--manifest ${shellQuote(`${inboxDir}/${MANIFEST_FILENAME}`)}`;
    const { stdout } = await remoteRunner.run(targetNode, receiveCommand, {
      timeoutMs: HANDOFF_RECEIVE_TIMEOUT_MS,
    });
    record.pid = parsePid(stdout);
  } catch (error) {
    record.status = "failed";
    record.error = (error as Error).message;
    record.updatedAt = now().toISOString();
    saveHandoffRecord(options.paseoHome, record);
    throw new Error(
      `factory-connector: handoff ${handoffId} to ${targetNode.id} failed: ${record.error}`,
    );
  }

  record.updatedAt = now().toISOString();
  saveHandoffRecord(options.paseoHome, record);

  // The dispatched run occupies one of the target's slots until reconciliation.
  saveFleetState(options.paseoHome, {
    ...options.state,
    nodes: options.state.nodes.map((node) =>
      node.nodeId === targetNode.id ? { ...node, slotsInUse: node.slotsInUse + 1 } : node,
    ),
  });
  return record;
}

/**
 * `Burst` — cooperative parallel execution. One unit of stateless work (a
 * `Scout pool` / `OSS lab` / `Council` probe or one isolated worktree + `Gate`
 * attempt) that can safely be attempted more than once.
 */
export interface BurstWorkUnit {
  id: string;
  /** Shell command for the unit; it carries its own working context. */
  command: string;
}

/** One execution of one unit on one `Node` (failover appends more attempts). */
export interface BurstAttempt {
  nodeId: string;
  startedAt: string;
  endedAt: string;
  ok: boolean;
  error: string | null;
  stdout: string;
  stderr: string;
}

/** Final outcome of one unit: every attempt in order plus where it settled. */
export interface BurstUnitResult {
  unitId: string;
  command: string;
  attempts: BurstAttempt[];
  ok: boolean;
  /** `Node` that finally ran the unit (null when every attempt failed). */
  nodeId: string | null;
}

/** What a whole `Burst` settled to. */
export interface BurstReport {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  results: BurstUnitResult[];
}

/** Default ceiling for a single work-unit attempt before failover kicks in. */
export const BURST_ATTEMPT_TIMEOUT_MS = 300_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
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

/**
 * Distributes a batch of parallel work units across the eligible online
 * `Node`s of the `Fleet` (`selectEligibleNodes` already applied `Slot
 * ceiling`, `Health guard`, and `Reserve mode` filtering), scheduling greedily
 * onto the roomiest surviving candidate and never exceeding a `Node`'s free
 * slots. Any attempt that fails — a peer disconnecting or timing out
 * mid-attempt included — is transparently retried on a surviving `Node` (each
 * `Node` is tried at most once per unit). In-flight occupancy is recorded as
 * `slotsInUse` in `fleet-state.json` for the whole `Fleet` to see, and
 * released as attempts settle.
 */
export async function executeBurst(options: {
  paseoHome: string;
  state: FleetState;
  units: BurstWorkUnit[];
  localRunner?: CommandRunner;
  remoteRunner?: RemoteCommandRunner;
  attemptTimeoutMs?: number;
  now?: () => Date;
}): Promise<BurstReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();

  const seen = new Set<string>();
  for (const unit of options.units) {
    if (typeof unit?.id !== "string" || unit.id.trim() === "") {
      throw new Error("factory-connector: every Burst work unit needs a non-empty id");
    }
    if (seen.has(unit.id)) {
      throw new Error(`factory-connector: duplicate Burst work unit id ${JSON.stringify(unit.id)}`);
    }
    seen.add(unit.id);
    if (typeof unit.command !== "string" || unit.command.trim() === "") {
      throw new Error(`factory-connector: Burst work unit ${unit.id} needs a command`);
    }
  }

  const eligible = selectEligibleNodes(options.state, { purpose: "burst" });
  if (eligible.length === 0) {
    throw new Error(
      "factory-connector: Burst found no eligible online Node (all offline, in Reserve mode, " +
        "outside Health guard thresholds, or slot-saturated)",
    );
  }

  const registry = new Map(loadFleetConfig(options.paseoHome).nodes.map((node) => [node.id, node]));
  const localRunner = options.localRunner ?? execCommandRunner;
  const remoteRunner = options.remoteRunner ?? createSshRemoteCommandRunner();
  const attemptTimeoutMs = options.attemptTimeoutMs ?? BURST_ATTEMPT_TIMEOUT_MS;

  const remaining = new Map<string, number>(eligible.map((entry) => [entry.node.nodeId, entry.freeSlots]));
  const inFlight = new Map<string, number>(eligible.map((entry) => [entry.node.nodeId, 0]));
  // Slot bookkeeping is written into a private copy of the snapshot so peers
  // polling fleet-state.json observe live occupancy.
  const slotsState: FleetState = {
    ...options.state,
    nodes: options.state.nodes.map((node) => ({ ...node })),
  };
  function persistSlots(): void {
    for (const node of slotsState.nodes) {
      const value = inFlight.get(node.nodeId);
      if (value !== undefined) node.slotsInUse = value;
    }
    saveFleetState(options.paseoHome, slotsState);
  }

  interface QueueEntry {
    result: BurstUnitResult;
    excluded: Set<string>;
  }
  const entries: QueueEntry[] = options.units.map((unit) => ({
    result: { unitId: unit.id, command: unit.command, attempts: [], ok: false, nodeId: null },
    excluded: new Set<string>(),
  }));
  const queue: QueueEntry[] = [...entries];
  const running = new Set<Promise<void>>();

  /** Roomiest non-excluded candidate with free capacity (ties keep fleet rank). */
  function pickNode(entry: QueueEntry): EligibleNode | null {
    let best: EligibleNode | null = null;
    let bestCapacity = 0;
    for (const candidate of eligible) {
      if (entry.excluded.has(candidate.node.nodeId)) continue;
      const capacity = remaining.get(candidate.node.nodeId) ?? 0;
      if (capacity > bestCapacity) {
        best = candidate;
        bestCapacity = capacity;
      }
    }
    return best;
  }

  async function runAttempt(entry: QueueEntry, choice: EligibleNode): Promise<void> {
    const nodeId = choice.node.nodeId;
    remaining.set(nodeId, (remaining.get(nodeId) ?? 0) - 1);
    inFlight.set(nodeId, (inFlight.get(nodeId) ?? 0) + 1);
    persistSlots();

    const attempt: BurstAttempt = {
      nodeId,
      startedAt: now().toISOString(),
      endedAt: "",
      ok: false,
      error: null,
      stdout: "",
      stderr: "",
    };
    try {
      const node = registry.get(nodeId);
      if (!node) {
        throw new Error(`factory-connector: Node ${nodeId} is not in the fleet registry at this home`);
      }
      const outcome =
        node.transport === "local"
          ? await withTimeout(
              localRunner.run("sh", ["-c", entry.result.command], { timeoutMs: attemptTimeoutMs }),
              attemptTimeoutMs,
              `factory-connector: Burst unit ${entry.result.unitId} on ${nodeId}`,
            )
          : await withTimeout(
              remoteRunner.run(node, `sh -c ${shellQuote(entry.result.command)}`, {
                timeoutMs: attemptTimeoutMs,
              }),
              attemptTimeoutMs,
              `factory-connector: Burst unit ${entry.result.unitId} on ${nodeId}`,
            );
      attempt.stdout = outcome.stdout;
      attempt.stderr = outcome.stderr;
      attempt.ok = true;
      entry.result.ok = true;
      entry.result.nodeId = nodeId;
    } catch (error) {
      attempt.ok = false;
      attempt.error = (error as Error).message;
    } finally {
      attempt.endedAt = now().toISOString();
      entry.result.attempts.push(attempt);
      remaining.set(nodeId, (remaining.get(nodeId) ?? 0) + 1);
      inFlight.set(nodeId, (inFlight.get(nodeId) ?? 0) - 1);
      persistSlots();
    }
    if (!attempt.ok) {
      // The attempt failed on this Node — a disconnected peer is the common
      // cause. Retry the unit on a surviving Node (each Node at most once).
      entry.excluded.add(nodeId);
      if (entry.excluded.size < eligible.length) {
        queue.unshift(entry);
      }
    }
  }

  function schedule(): void {
    for (let i = 0; i < queue.length; ) {
      const entry = queue[i];
      const choice = pickNode(entry);
      if (!choice) {
        i += 1;
        continue;
      }
      queue.splice(i, 1);
      const completion = runAttempt(entry, choice).then(() => {
        running.delete(completion);
        schedule();
      });
      running.add(completion);
    }
  }

  schedule();
  while (running.size > 0) {
    await Promise.all([...running]);
  }

  return {
    ok: entries.every((entry) => entry.result.ok),
    startedAt,
    finishedAt: now().toISOString(),
    results: entries.map((entry) => entry.result),
  };
}

/**
 * `Connector bridge` — the local file + CLI contract (`CONTEXT.md`) through
 * which `factory-burn-lab` and `paseo-factory` consume `Fleet` capacity with
 * zero cross-repo code imports.
 */

/** Path of the generated CLI wrapper. */
export function connectorDispatchPath(paseoHome: string): string {
  return join(paseoHome, "connector", "bin", "connector-dispatch");
}

/**
 * Default entry the wrapper execs: the `dispatch-cli.ts` sitting next to this
 * module — `src/` in the repo, `plugin/server/core/` in the mirrored plugin
 * layout (both are the same directory relative to this file).
 */
export function defaultCoreCliPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "dispatch-cli.ts");
}

/**
 * Writes `<paseoHome>/connector/fleet-state.json` (from the supplied snapshot,
 * or a fresh `pollFleetPulse` through the injectable transport) and generates
 * the executable `<paseoHome>/connector/bin/connector-dispatch` wrapper that
 * execs `node <coreCliPath> --home <paseoHome> "$@"`. Sibling repos read the
 * snapshot file for capacity and shell out to the wrapper for `Handoff` and
 * `Burst` — no shared code, no imports across repos.
 */
export async function ensureConnectorBridge(options: {
  paseoHome: string;
  /** Snapshot to publish; when omitted one is polled first. */
  state?: FleetState;
  transport?: PulseTransport;
  localSource?: LocalPulseSource;
  now?: () => Date;
  /** Entry the wrapper execs (defaults to the co-located `dispatch-cli.ts`). */
  coreCliPath?: string;
}): Promise<{ state: FleetState; statePath: string; dispatchPath: string }> {
  const state =
    options.state ??
    (await pollFleetPulse({
      paseoHome: options.paseoHome,
      transport: options.transport,
      localSource: options.localSource,
      now: options.now,
    }));
  if (options.state) {
    saveFleetState(options.paseoHome, options.state);
  }

  const dispatchPath = connectorDispatchPath(options.paseoHome);
  mkdirSync(dirname(dispatchPath), { recursive: true });
  const coreCliPath = options.coreCliPath ?? defaultCoreCliPath();
  const script =
    "#!/bin/sh\n" +
    "# Generated by factory-connector (ensureConnectorBridge) — do not edit.\n" +
    "# Connector bridge CLI: lets factory-burn-lab / paseo-factory invoke\n" +
    "# Handoff and Burst with zero cross-repo code imports (CONTEXT.md).\n" +
    `exec node "${coreCliPath}" --home "${options.paseoHome}" "$@"\n`;
  writeFileSync(dispatchPath, script, "utf8");
  chmodSync(dispatchPath, 0o755);

  return { state, statePath: fleetStatePath(options.paseoHome), dispatchPath };
}
