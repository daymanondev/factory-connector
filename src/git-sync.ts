/**
 * Git-native `Mirror repo`, `Fleet ref`, `Land`, and `Gossip sync` core.
 *
 * `Node`s exchange code state as compact `git bundle` payloads (never SMB/NFS
 * shared folders, ADR 0001 §4): `createCommitBundle` packages an initiating
 * repository's `<base>..HEAD` range plus `.worktreeinclude` files,
 * `ensureMirrorRepoFromBundle` provisions/updates the on-demand
 * `<paseoHome>/connector/repos/<canonical-slug>` `Mirror repo` on a target
 * `Node`, `stageFleetRefFromBundle` silently stages a peer's completed commits
 * under `refs/fleet/<nodeId>/<runOrTaskId>` without touching the user's active
 * working tree, `landFleetRef` applies a staged `Fleet ref` on explicit
 * operator request, and `reconcileGossipSync` performs last-write-wins
 * reconciliation of `free-pool.json` and completed `BurnRunRecord` /
 * `report.md` artifacts from `Fleet pulse` timestamps.
 *
 * Pure Node module (mirrored verbatim into `plugin/server/core/` by
 * `npm run sync:plugin-core`). Every git/network seam is injectable via
 * `CommandRunner` so tests run fully offline against temp repositories.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_REMOTE_PASEO_HOME,
  execCommandRunner,
  parseSshTarget,
  type CommandRunner,
  type FleetNode,
  type FleetPulse,
} from "./fleet.ts";

const execFileAsync = promisify(execFile);

/** Timeout ceiling for one local git/tar invocation driven through the runner. */
export const GIT_OPERATION_TIMEOUT_MS = 120_000;

async function runGit(
  runner: CommandRunner,
  repoPath: string | undefined,
  args: string[],
): Promise<string> {
  const fullArgs = repoPath === undefined ? args : ["-C", repoPath, ...args];
  const { stdout } = await runner.run("git", fullArgs, { timeoutMs: GIT_OPERATION_TIMEOUT_MS });
  return stdout;
}

/** `.worktreeinclude` payload of `createCommitBundle`. */
export interface CommitBundle {
  /** Path to the created `git bundle` file. */
  bundlePath: string;
  /**
   * Path to a gzip tar of the files matched by the repo's `.worktreeinclude`
   * (env files, local secrets — untracked, so the bundle alone cannot carry
   * them). `null` when the repo lists no include files.
   */
  includeTarPath: string | null;
  /** Resolved `<base>` commit sha (ancestor of `headCommit`). */
  baseCommit: string;
  /** Resolved `HEAD` commit sha — the tip of the packaged `<base>..HEAD` range. */
  headCommit: string;
  /** Branch `HEAD` was on when the bundle was created (mirrors check it out). */
  branch: string;
}

/**
 * One `.worktreeinclude` pattern as a match predicate over repo-relative paths
 * (same semantics as `paseo-factory`'s `.worktreeinclude`: `*` and `?` never
 * cross `/`, a trailing `/` matches a directory prefix).
 */
function worktreeIncludePatternMatches(pattern: string, file: string): boolean {
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(file);
}

/** Parses `.worktreeinclude` content: one pattern per line, `#` comments. */
export function parseWorktreeIncludePatterns(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * Files an initiating repository's `.worktreeinclude` names: untracked
 * (including git-ignored) files matching one of its patterns. Missing include
 * file or empty pattern list yields an empty list — the common case.
 */
export async function listWorktreeIncludeFiles(
  repoPath: string,
  runner: CommandRunner = execCommandRunner,
): Promise<string[]> {
  let raw: string;
  try {
    raw = readFileSync(join(repoPath, ".worktreeinclude"), "utf8");
  } catch {
    return [];
  }
  const patterns = parseWorktreeIncludePatterns(raw);
  if (patterns.length === 0) return [];

  const untracked = new Set<string>();
  for (const extra of [[], ["--ignored"]] as const) {
    const listed = await runGit(runner, repoPath, [
      "ls-files",
      "--others",
      "--exclude-standard",
      ...extra,
    ]);
    for (const line of listed.split("\n")) {
      const file = line.trim();
      if (file !== "") untracked.add(file);
    }
  }

  const included: string[] = [];
  for (const file of untracked) {
    if (!patterns.some((pattern) => worktreeIncludePatternMatches(pattern, file))) continue;
    try {
      if (!statSync(join(repoPath, file)).isFile()) continue;
    } catch {
      continue;
    }
    included.push(file);
  }
  return included.sort();
}

/**
 * Packages an initiating repository's `<base>..HEAD` commit range plus its
 * `.worktreeinclude` files into transfer-ready artifacts.
 *
 * The bundle is self-contained (the range's prerequisite `<base>` history is
 * included) because a thin `git bundle create <base>..HEAD` payload records
 * `<base>` as a prerequisite and git refuses to clone/fetch it anywhere that
 * lacks those commits — which would break provisioning a fresh `Mirror repo`
 * on a peer `Node` that has never seen the project. Peers that already hold
 * the history simply deduplicate the objects on fetch.
 */
export async function createCommitBundle(options: {
  repoPath: string;
  /** Commit-ish the range starts from (exclusive). Must be an ancestor of HEAD. */
  base: string;
  /** Where the `.bundle` file is written (parent directories are created). */
  outPath: string;
  runner?: CommandRunner;
}): Promise<CommitBundle> {
  const runner = options.runner ?? execCommandRunner;
  const repoPath = options.repoPath;

  const headCommit = (await runGit(runner, repoPath, ["rev-parse", "HEAD"])).trim();
  const baseCommit = (await runGit(runner, repoPath, ["rev-parse", options.base])).trim();
  try {
    await runGit(runner, repoPath, ["merge-base", "--is-ancestor", baseCommit, headCommit]);
  } catch {
    throw new Error(
      `factory-connector: base ${baseCommit} is not an ancestor of HEAD ${headCommit}; ` +
        "a commit bundle must package a <base>..HEAD range",
    );
  }

  const branch = (await runGit(runner, repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  // Bundling the branch ref alongside HEAD lets a fresh clone resolve its
  // default branch instead of landing in detached HEAD.
  const revs = branch === "HEAD" ? ["HEAD"] : ["HEAD", branch];

  mkdirSync(dirname(options.outPath), { recursive: true });
  await runGit(runner, repoPath, ["bundle", "create", options.outPath, ...revs]);

  let includeTarPath: string | null = null;
  const includeFiles = await listWorktreeIncludeFiles(repoPath, runner);
  if (includeFiles.length > 0) {
    includeTarPath = `${options.outPath}.worktreeinclude.tgz`;
    const listPath = `${options.outPath}.worktreeinclude.list`;
    writeFileSync(listPath, `${includeFiles.join("\n")}\n`, "utf8");
    try {
      await runner.run(
        "tar",
        ["-czf", includeTarPath, "-C", repoPath, "-T", listPath],
        { timeoutMs: GIT_OPERATION_TIMEOUT_MS },
      );
    } finally {
      // The list is scaffolding; never leave it next to the payload.
      rmSync(listPath, { force: true });
    }
  }

  return { bundlePath: options.outPath, includeTarPath, baseCommit, headCommit, branch };
}

/** Path of the on-demand `Mirror repo` for a `Project` canonical slug. */
export function mirrorRepoPath(paseoHome: string, canonicalSlug: string): string {
  return join(paseoHome, "connector", "repos", canonicalSlug);
}

function assertCanonicalSlug(canonicalSlug: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(canonicalSlug) || canonicalSlug.includes("..")) {
    throw new Error(
      `factory-connector: invalid canonical slug ${JSON.stringify(canonicalSlug)}; ` +
        "slugs must be alphanumeric-led and cannot contain path separators or '..'",
    );
  }
}

/** Outcome of provisioning/updating a `Mirror repo` from a bundle. */
export interface MirrorRepoResult {
  mirrorPath: string;
  /** True when the `Mirror repo` was provisioned from scratch this call. */
  created: boolean;
  /** Commit the mirror's checkout points at after the operation. */
  headCommit: string;
  /** Branch the mirror has checked out (null in detached HEAD). */
  branch: string | null;
}

/**
 * Unpacks or updates `<paseoHome>/connector/repos/<canonical-slug>` on a
 * target `Node` from a `createCommitBundle` payload. A fresh mirror is cloned
 * from the bundle (no `origin` remote is kept — all future updates arrive as
 * bundles); an existing mirror fast-forwards to the bundle's HEAD. When an
 * include tar is supplied its files are (re)extracted over the mirror so the
 * peer's OS-native checkout keeps the env/secrets the initiator listed.
 */
export async function ensureMirrorRepoFromBundle(options: {
  paseoHome: string;
  canonicalSlug: string;
  bundlePath: string;
  includeTarPath?: string | null;
  runner?: CommandRunner;
}): Promise<MirrorRepoResult> {
  const runner = options.runner ?? execCommandRunner;
  assertCanonicalSlug(options.canonicalSlug);
  const mirrorPath = mirrorRepoPath(options.paseoHome, options.canonicalSlug);

  let created = false;
  if (!existsSync(join(mirrorPath, ".git"))) {
    mkdirSync(dirname(mirrorPath), { recursive: true });
    await runGit(runner, undefined, ["clone", "--quiet", options.bundlePath, mirrorPath]);
    // Cloning from a bundle records the (transient) bundle path as `origin`;
    // mirrors are updated exclusively via bundles, so drop the stale remote.
    await runGit(runner, mirrorPath, ["remote", "remove", "origin"]);
    created = true;
  } else {
    // Refuse cleanly when the bundle needs history this mirror lacks
    // (git's "Repository lacks these prerequisite commits" is opaque here).
    try {
      await runGit(runner, mirrorPath, ["bundle", "verify", options.bundlePath]);
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? (error as Error).message;
      throw new Error(
        `factory-connector: bundle ${options.bundlePath} cannot update the mirror at ` +
          `${mirrorPath}: ${stderr}`,
      );
    }
    await runGit(runner, mirrorPath, ["fetch", "--quiet", options.bundlePath, "HEAD"]);
    await runGit(runner, mirrorPath, ["merge", "--ff-only", "FETCH_HEAD"]);
  }

  if (options.includeTarPath && existsSync(options.includeTarPath)) {
    await runner.run(
      "tar",
      ["-xzf", options.includeTarPath, "-C", mirrorPath],
      { timeoutMs: GIT_OPERATION_TIMEOUT_MS },
    );
  }

  const headCommit = (await runGit(runner, mirrorPath, ["rev-parse", "HEAD"])).trim();
  const branch = (await runGit(runner, mirrorPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  return { mirrorPath, created, headCommit, branch: branch === "HEAD" ? null : branch };
}

/** Asserts a `Fleet ref` path component is safe inside a git ref name. */
function assertRefComponent(kind: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes("..")) {
    throw new Error(
      `factory-connector: invalid ${kind} ${JSON.stringify(value)}; ref components must be ` +
        "alphanumeric-led without spaces, path separators, or '..'",
    );
  }
}

/** The namespaced `Fleet ref` a peer `Node`'s completed work is staged under. */
export function fleetRef(nodeId: string, runOrTaskId: string): string {
  assertRefComponent("node id", nodeId);
  assertRefComponent("run or task id", runOrTaskId);
  return `refs/fleet/${nodeId}/${runOrTaskId}`;
}

/** The local branch a landed `Fleet ref` is materialized as. */
export function fleetRefBranch(nodeId: string, runOrTaskId: string): string {
  return fleetRef(nodeId, runOrTaskId).replace(/^refs\/fleet\//, "fleet/");
}

/** Result of staging a peer completion bundle into the local repository. */
export interface StagedFleetRef {
  /** The `refs/fleet/<nodeId>/<runOrTaskId>` ref that now holds the commits. */
  ref: string;
  /** Commit the ref points at (the bundle's HEAD). */
  commit: string;
}

/**
 * Unpacks a peer `Node`'s completed commit bundle into
 * `refs/fleet/<nodeId>/<runOrTaskId>` in the local repository. The fetch
 * writes objects and the ref only — the user's active working tree, index,
 * `HEAD`, and checked-out branch are left untouched (verified by the tests);
 * the operator applies the code later via `landFleetRef`. Re-staging the same
 * ref (a peer follow-up) overwrites it with the newer completion.
 */
export async function stageFleetRefFromBundle(options: {
  repoPath: string;
  bundlePath: string;
  nodeId: string;
  runOrTaskId: string;
  runner?: CommandRunner;
}): Promise<StagedFleetRef> {
  const runner = options.runner ?? execCommandRunner;
  const ref = fleetRef(options.nodeId, options.runOrTaskId);
  try {
    await runGit(runner, options.repoPath, [
      "fetch",
      "--quiet",
      options.bundlePath,
      `+HEAD:${ref}`,
    ]);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? (error as Error).message;
    throw new Error(
      `factory-connector: could not stage ${ref} from bundle ${options.bundlePath}: ${stderr}`,
    );
  }
  const commit = (await runGit(runner, options.repoPath, ["rev-parse", ref])).trim();
  return { ref, commit };
}

/** How the operator asked a `Fleet ref` to be applied. */
export type LandFleetRefMode = "checkout" | "merge";

/** Result of landing a staged `Fleet ref`. */
export interface LandedFleetRef {
  /** Local branch the `Fleet ref` was materialized as (`fleet/<nodeId>/<runId>`). */
  branch: string;
  /** Commit landed at. */
  commit: string;
  mode: LandFleetRefMode;
}

/**
 * The explicit 1-click **`Land`**: applies a staged `Fleet ref`
 * (`refs/fleet/<nodeId>/<runOrTaskId>`) to the repository. Unlike staging,
 * landing deliberately touches the checkout:
 *
 * - `checkout` (default) materializes the local branch
 *   `fleet/<nodeId>/<runOrTaskId>` at the ref and switches to it — the
 *   review-and-inspect path.
 * - `merge` merges the ref into the current branch (fast-forwarding when the
 *   branch is behind, creating a merge commit when histories diverged) — the
 *   apply-the-code path.
 */
export async function landFleetRef(options: {
  repoPath: string;
  nodeId: string;
  runOrTaskId: string;
  mode?: LandFleetRefMode;
  runner?: CommandRunner;
}): Promise<LandedFleetRef> {
  const runner = options.runner ?? execCommandRunner;
  const mode = options.mode ?? "checkout";
  const ref = fleetRef(options.nodeId, options.runOrTaskId);
  const branch = fleetRefBranch(options.nodeId, options.runOrTaskId);

  let commit: string;
  try {
    commit = (await runGit(runner, options.repoPath, ["rev-parse", ref])).trim();
  } catch {
    throw new Error(
      `factory-connector: cannot land ${ref}: the Fleet ref is not staged in ` +
        `${options.repoPath}; stage it with stageFleetRefFromBundle first`,
    );
  }

  if (mode === "checkout") {
    await runGit(runner, options.repoPath, ["checkout", "-q", "-B", branch, commit]);
  } else {
    await runGit(runner, options.repoPath, ["merge", "--no-edit", "--no-gpg-sign", ref]);
  }

  const headAfter = (await runGit(runner, options.repoPath, ["rev-parse", "HEAD"])).trim();
  return { branch, commit: mode === "checkout" ? commit : headAfter, mode };
}

/**
 * `Gossip sync` — last-write-wins reconciliation of shared fleet artifacts
 * from `Fleet pulse` timestamps (CONTEXT.md "Gossip sync"). Pull-only per
 * peer: every `Node` runs the same reconciliation against the peers it can
 * reach, so newer artifacts propagate without a master.
 */

/** Local path of the `free-pool.json` shared with `factory-burn-lab`. */
export function freePoolArtifactPath(paseoHome: string): string {
  return join(paseoHome, "burn-lab", "free-pool.json");
}

/** Local directory of completed `BurnRunRecord` JSON files and artifacts. */
export function burnRunsDirPath(paseoHome: string): string {
  return join(paseoHome, "burn-lab", "runs");
}

/** Peer-relative path of `free-pool.json` (POSIX on every `Node`'s runtime). */
export const FREE_POOL_RELATIVE_PATH = "burn-lab/free-pool.json";

/** Peer-relative directory of completed run records and artifacts. */
export const BURN_RUNS_RELATIVE_DIR = "burn-lab/runs";

/** A peer's digest paired with the `Node` it came from. */
export interface GossipPeerDigest {
  node: FleetNode;
  pulse: FleetPulse;
}

/**
 * Injectable seam for reading shared artifacts off a peer `Node`.
 * Production default is Tailscale SSH (`createSshGossipTransport`); tests
 * pass an in-memory stub so nothing here ever touches the network.
 */
export interface GossipArtifactTransport {
  /** Reads one artifact (UTF-8) relative to the peer's `<paseoHome>`; null when absent. */
  readFile(node: FleetNode, relativePath: string): Promise<string | null>;
  /** Lists file names directly inside a peer-relative directory (empty when unreadable). */
  listFiles(node: FleetNode, relativeDir: string): Promise<string[]>;
}

/** One `free-pool.json` pulled from a peer because its stamp was newer. */
export interface GossipFreePoolPull {
  nodeId: string;
  updatedAt: string;
}

/** One completed `BurnRunRecord` (and its artifacts) pulled from a peer. */
export interface GossipRunPull {
  nodeId: string;
  runId: string;
  updatedAt: string;
}

/** What a `reconcileGossipSync` pass actually reconciled. */
export interface GossipSyncReport {
  freePool: GossipFreePoolPull[];
  runs: GossipRunPull[];
}

function parseStampMs(stamp: string | null | undefined): number {
  if (typeof stamp !== "string") return 0;
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? 0 : ms;
}

function readLocalFreePoolStamp(paseoHome: string): number {
  try {
    const parsed = JSON.parse(readFileSync(freePoolArtifactPath(paseoHome), "utf8")) as {
      updatedAt?: unknown;
    };
    return parseStampMs(typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined);
  } catch {
    return 0;
  }
}

function readLocalRunStamps(paseoHome: string): Map<string, string> {
  const stamps = new Map<string, string>();
  const dir = burnRunsDirPath(paseoHome);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return stamps;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        id?: unknown;
        updatedAt?: unknown;
      };
      if (typeof parsed.updatedAt === "string") {
        stamps.set(file.replace(/\.json$/, ""), parsed.updatedAt);
      }
    } catch {
      // A malformed local record never blocks gossip; it simply looks oldest.
    }
  }
  return stamps;
}

function writeArtifact(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/**
 * Compares `freePoolUpdatedAt` / `runsUpdatedAt` stamps carried by `Fleet
 * pulse` digests against the local artifacts and pulls, last-write-wins, every
 * peer artifact that is strictly newer: the peer's `free-pool.json` and its
 * completed `BurnRunRecord` JSON plus each pulled run's `report.md` summary.
 * Peers that are not newer, offline, or carry null stamps cost nothing — no
 * transport reads at all.
 */
export async function reconcileGossipSync(options: {
  paseoHome: string;
  peers: GossipPeerDigest[];
  transport: GossipArtifactTransport;
}): Promise<GossipSyncReport> {
  const report: GossipSyncReport = { freePool: [], runs: [] };
  let localFreePoolStamp = readLocalFreePoolStamp(options.paseoHome);
  const localRunStamps = readLocalRunStamps(options.paseoHome);
  let localRunsMax = Math.max(0, ...[...localRunStamps.values()].map((stamp) => parseStampMs(stamp)));

  for (const { node, pulse } of options.peers) {
    if (parseStampMs(pulse.freePoolUpdatedAt) > localFreePoolStamp) {
      const content = await options.transport.readFile(node, FREE_POOL_RELATIVE_PATH);
      if (content !== null) {
        writeArtifact(freePoolArtifactPath(options.paseoHome), content);
        report.freePool.push({ nodeId: node.id, updatedAt: pulse.freePoolUpdatedAt as string });
        localFreePoolStamp = parseStampMs(pulse.freePoolUpdatedAt);
      }
    }

    if (parseStampMs(pulse.runsUpdatedAt) > localRunsMax) {
      const listing = await options.transport.listFiles(node, BURN_RUNS_RELATIVE_DIR);
      for (const file of listing) {
        if (!file.endsWith(".json")) continue;
        const runId = file.replace(/\.json$/, "");
        const recordPath = `${BURN_RUNS_RELATIVE_DIR}/${file}`;
        const content = await options.transport.readFile(node, recordPath);
        if (content === null) continue;
        let peerStamp: string | null = null;
        try {
          const parsed = JSON.parse(content) as { updatedAt?: unknown };
          if (typeof parsed.updatedAt === "string") peerStamp = parsed.updatedAt;
        } catch {
          continue; // an unparsable peer record cannot be ordered — skip it
        }
        if (peerStamp === null) continue;
        const localStamp = localRunStamps.get(runId);
        if (parseStampMs(peerStamp) <= parseStampMs(localStamp)) continue;

        writeArtifact(join(burnRunsDirPath(options.paseoHome), file), content);
        const reportPath = `${BURN_RUNS_RELATIVE_DIR}/${runId}/report.md`;
        const reportContent = await options.transport.readFile(node, reportPath);
        if (reportContent !== null) {
          writeArtifact(join(burnRunsDirPath(options.paseoHome), runId, "report.md"), reportContent);
        }
        report.runs.push({ nodeId: node.id, runId, updatedAt: peerStamp });
        localRunStamps.set(runId, peerStamp);
        localRunsMax = Math.max(localRunsMax, parseStampMs(peerStamp));
      }
    }
  }

  return report;
}

/** Timeout ceiling for one SSH artifact read during `Gossip sync`. */
export const GOSSIP_FETCH_TIMEOUT_MS = 30_000;

/**
 * Production `GossipArtifactTransport`: reads artifacts from a peer `Node`
 * over Tailscale SSH in BatchMode (digest-first — summaries only, never token
 * or gate-log streaming, ADR 0001 §3).
 */
export function createSshGossipTransport(options?: {
  runner?: CommandRunner;
  connectTimeoutSeconds?: number;
}): GossipArtifactTransport {
  const runner = options?.runner ?? execCommandRunner;
  const connectTimeout = options?.connectTimeoutSeconds ?? 5;

  function remotePath(node: FleetNode, relativePath: string): string {
    const remoteHome = node.remotePaseoHome ?? DEFAULT_REMOTE_PASEO_HOME;
    return `${remoteHome}/${relativePath}`;
  }

  async function ssh(node: FleetNode, remoteCommand: string): Promise<string> {
    if (!node.sshTarget) {
      throw new Error(`factory-connector: Node ${node.id} has no sshTarget to gossip with`);
    }
    const { user, host } = parseSshTarget(node.sshTarget);
    const destination = user ? `${user}@${host}` : host;
    const { stdout } = await runner.run(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        `ConnectTimeout=${connectTimeout}`,
        destination,
        remoteCommand,
      ],
      { timeoutMs: GOSSIP_FETCH_TIMEOUT_MS },
    );
    return stdout;
  }

  return {
    async readFile(node, relativePath) {
      try {
        const stdout = await ssh(node, `cat ${remotePath(node, relativePath)}`);
        // A missing file surfaces as a non-zero `cat` exit (thrown) or an
        // empty read; either way there is no artifact to reconcile.
        return stdout.trim() === "" ? null : stdout;
      } catch {
        return null;
      }
    },
    async listFiles(node, relativeDir) {
      try {
        const stdout = await ssh(node, `ls -1 ${remotePath(node, relativeDir)}`);
        return stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "");
      } catch {
        return [];
      }
    },
  };
}
