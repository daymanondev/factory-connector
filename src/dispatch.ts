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
import { dirname, join } from "node:path";
import {
  DEFAULT_REMOTE_PASEO_HOME,
  execCommandRunner,
  type CommandRunner,
} from "./fleet.ts";
import { ensureMirrorRepoFromBundle } from "./git-sync.ts";

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
