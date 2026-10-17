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
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { execCommandRunner, type CommandRunner, type FleetNode, type FleetPulse } from "./fleet.ts";

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
