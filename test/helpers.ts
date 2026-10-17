/**
 * The shared offline test harness (dispatch + surface-rpc + git-sync tests):
 * temp homes, real-`git` fixture helpers, and the registry/snapshot/node
 * builders plus the simulated target `Node` every Handoff test rides on.
 * Nothing here touches the network or a real `<paseoHome>` — every SSH/git
 * seam is stubbed or driven against temp directories.
 */
import { after } from "node:test";
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_HEALTH_GUARD, saveFleetConfig, type FleetNode, type FleetNodeState, type FleetState } from "../src/fleet.ts";
import { receiveHandoff, type DetachedSpawn, type GitBundleTransport, type RemoteCommandRunner } from "../src/dispatch.ts";

const execFileAsync = promisify(execFile);

export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `factory-connector-${prefix}-`));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function makeTempHome(prefix: string): string {
  return makeTempDir(`${prefix}-home`);
}

/** Runs real `git` against a fixture checkout (tests may drive git directly). */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.toString();
}

export async function initRepo(dir: string, branch = "main"): Promise<string> {
  await execFileAsync("git", ["init", "-q", "-b", branch, dir]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "connector@test.example"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "Connector Test"]);
  return dir;
}

export async function commitAll(repo: string, message: string): Promise<string> {
  await execFileAsync("git", ["-C", repo, "add", "-A"]);
  await execFileAsync("git", ["-C", repo, "commit", "-qm", message]);
  return (await git(repo, "rev-parse", "HEAD")).trim();
}

export function fleetNode(overrides: Partial<FleetNode> & { id: string }): FleetNode {
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

export function nodeState(overrides: Partial<FleetNodeState> & { nodeId: string }): FleetNodeState {
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

export function fleetStateOf(nodes: FleetNodeState[], localNodeId = "laptop"): FleetState {
  return { version: 1, localNodeId, updatedAt: "2026-10-17T10:00:00.000Z", nodes };
}

/** Persists a registry whose local `Node` is the `laptop` (mobile initiator). */
export function seedRegistry(home: string, nodes: FleetNode[]): void {
  saveFleetConfig(home, {
    version: 1,
    localNodeId: "laptop",
    nodes: [fleetNode({ id: "laptop", name: "Laptop", posture: "mobile", transport: "local" }), ...nodes],
  });
}

/** Stub `DetachedSpawn` that records every spawn without running anything. */
export function recordingSpawn(): { spawns: Array<{ cwd: string; command: string; logPath: string }>; spawn: DetachedSpawn } {
  const spawns: Array<{ cwd: string; command: string; logPath: string }> = [];
  return {
    spawns,
    spawn: {
      async spawn(options) {
        spawns.push(options);
        return { pid: "31337" };
      },
    },
  };
}

/**
 * Simulated target `Node`: the `GitBundleTransport` really copies files into a
 * temp target home's inbox, and the `RemoteCommandRunner` really executes the
 * composed `connector-dispatch receive-handoff` command against that home —
 * exactly what the production bridge on the peer would do, minus SSH. It also
 * answers the initiator's `Mirror repo` HEAD probe (`git -C … rev-parse HEAD`)
 * from the same temp home, so two-tier bundle tests see real mirror state.
 */
export function simulatedTargetNode(targetHome: string, spawn: DetachedSpawn): {
  transport: GitBundleTransport;
  remoteRunner: RemoteCommandRunner;
  commands: Array<{ nodeId: string; command: string }>;
} {
  const commands: Array<{ nodeId: string; command: string }> = [];
  // `~/.paseo-factory` (the default remote home) maps onto the temp home root,
  // exactly as the peer's shell would expand it.
  const toTargetPath = (remote: string): string =>
    remote.replace(/^~\/\.paseo-factory(?=\/|$)/, targetHome).replace(/^~(?=\/|$)/, targetHome);
  return {
    commands,
    transport: {
      async copyToNode(_node, localPath, remoteDir) {
        const dir = toTargetPath(remoteDir);
        mkdirSync(dir, { recursive: true });
        const destination = join(dir, basename(localPath));
        copyFileSync(localPath, destination);
        return `${remoteDir}/${basename(localPath)}`;
      },
    },
    remoteRunner: {
      async run(node, command) {
        commands.push({ nodeId: node.id, command });
        const probe = /git -C (\S+) rev-parse HEAD$/.exec(command);
        if (probe) {
          const mirrorPath = toTargetPath(probe[1]);
          try {
            return { stdout: `${(await git(mirrorPath, "rev-parse", "HEAD")).trim()}\n`, stderr: "" };
          } catch {
            throw new Error(`simulated peer: no repo at ${mirrorPath}`);
          }
        }
        const match = /--manifest '([^']+)'/.exec(command);
        if (!match) throw new Error(`unexpected remote command: ${command}`);
        const record = await receiveHandoff({
          paseoHome: targetHome,
          manifestPath: toTargetPath(match[1]),
          spawn,
        });
        return { stdout: `${record.pid}\n`, stderr: "" };
      },
    },
  };
}
