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

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  DEFAULT_REMOTE_PASEO_HOME,
  execCommandRunner,
  loadFleetConfig,
  parseSshTarget,
  saveFleetState,
  selectEligibleNodes,
  type CommandRunner,
  type FleetNode,
  type FleetNodeState,
  type FleetState,
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
