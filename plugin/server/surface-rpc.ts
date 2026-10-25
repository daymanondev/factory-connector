/**
 * The `Fleet surface`'s in-process RPC handlers: every `connector.*` RPC runs
 * inside the plugin server process against the co-located connector core
 * (`plugin/server/core/`, mirrored verbatim from `src/` by
 * `npm run sync:plugin-core`), so Owner acts from the UI — `Reserve mode`
 * toggles, `Node` registration, `Handoff`, `Burst`, `Gossip sync`, `Land` —
 * invoke the core directly. Every network/SSH/git seam is injectable through
 * `SurfaceDeps` (spec.md "Injectable Transport Seams"); tests pass stubs and a
 * temp paseo home, production defaults to Tailscale SSH in BatchMode.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  defaultLocalPulseSource,
  discoverTailscalePeers,
  execCommandRunner,
  loadFleetConfig,
  loadFleetState,
  pollFleetPulse,
  pollFleetPulseCached,
  removeNode,
  setNodeReserveMode,
  shouldPollNow,
  upsertNode,
  type CommandRunner,
  type FleetState,
  type LocalPulseSource,
  type PulseTransport,
} from "./core/fleet.ts";
import { burnRunsDirPath, createSshGossipTransport, landFleetRef, reconcileGossipSync, type GossipArtifactTransport } from "./core/git-sync.ts";
import {
  dispatchHandoff,
  executeBurst,
  loadHandoff,
  type GitBundleTransport,
  type HandoffRecord,
  type RemoteCommandRunner,
} from "./core/dispatch.ts";
import { foldFleetView } from "./view.ts";
import { burst, gossipSync, handoff, logRead, nodeRemove, nodeReserve, nodeUpsert, pulse, refLand, snapshot, tailscaleDiscover } from "../shared/rpc.ts";
import type { BurstReportView, FleetNodeInputView, FleetView, GossipSyncReportView, HandoffLogView, HandoffRecordView, LandedFleetRefView } from "../shared/view.ts";

/** What each `server.handle` call passes besides the parsed input. */
export interface SurfaceCallContext {
  paseo?: unknown;
}

/** The structural slice of PaseoApi the surface reads (agent activity counts). */
export interface SurfaceDaemonApi {
  agents: {
    list(options?: { filter?: { includeArchived?: boolean; includeBackground?: boolean } }): Promise<{ entries: unknown[] }>;
  };
}

/** The injection bag: every seam the handlers touch, over one paseo home. */
export interface SurfaceDeps {
  paseoHome: string;
  /** Peer `Fleet pulse` fetcher — defaults to Tailscale SSH (tests stub it). */
  transport?: PulseTransport;
  /** Local pulse facts source — defaults to real CPU/RAM sampling (tests stub it). */
  localSource?: LocalPulseSource;
  /** Peer artifact reader for `Gossip sync` — defaults to Tailscale SSH (tests stub it). */
  gossipTransport?: GossipArtifactTransport;
  /** Bundle mover for `Handoff` — defaults to `scp` over SSH (tests stub it). */
  bundleTransport?: GitBundleTransport;
  /** Peer command runner for `Handoff`/`Burst` — defaults to SSH (tests stub it). */
  remoteRunner?: RemoteCommandRunner;
  /** Local command runner for `Burst` on the local `Node` (tests stub it). */
  localRunner?: CommandRunner;
  /** `tailscale status --json` runner for discovery (tests stub it). */
  discoveryRunner?: CommandRunner;
  /** Daemon API for local activity counts, when the shell captured one. */
  daemon?: () => SurfaceDaemonApi | undefined;
  now?: () => Date;
  onLog?: (message: string) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Digest-first ceiling (ADR 0001 §3) on any log/report the on-demand viewer
 * serves to the `Fleet surface`: the operator reads a capped tail, never a
 * token/log stream.
 */
export const LOG_READ_MAX_BYTES = 64 * 1024;

/** Reads at most the last `maxBytes` of a file; null when it cannot be read. */
function readTail(path: string, maxBytes: number): string | null {
  let handle: number;
  try {
    handle = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = statSync(path).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(handle, buffer, 0, length, Math.max(0, size - length));
    const content = buffer.toString("utf8");
    return size > maxBytes ? `… [truncated to the last ${maxBytes} bytes]\n${content}` : content;
  } finally {
    closeSync(handle);
  }
}

/** A `HandoffRecord` as the wire list renders it. */
function handoffViewOf(record: HandoffRecord): HandoffRecordView {
  return {
    handoffId: record.handoffId,
    direction: record.direction,
    sourceNodeId: record.sourceNodeId,
    targetNodeId: record.targetNodeId,
    runOrTaskId: record.runOrTaskId,
    kind: record.kind,
    status: record.status,
    playbook: record.brief.playbook,
    prompt: record.brief.prompt,
    canonicalSlug: record.canonicalSlug,
    expectedFleetRef: record.expectedFleetRef,
    dispatchedAt: record.dispatchedAt,
    updatedAt: record.updatedAt,
    error: record.error,
    logPath: record.logPath,
  };
}

export function createSurfaceHandlers(deps: SurfaceDeps) {
  const log = deps.onLog ?? (() => {});
  const failure = (code: string, error: string) => ({ ok: false as const, code, error });

  /** The current view, folded over the given (or on-disk) pulse snapshot. */
  const view = (state?: Parameters<typeof foldFleetView>[0]["state"]): FleetView =>
    foldFleetView({ paseoHome: deps.paseoHome, state, now: deps.now });

  /**
   * The freshest snapshot there is — the on-disk one, or a first poll (through
   * the single-flight TTL cache, so a concurrent `connector.pulse` never races
   * a second transport sweep).
   */
  const currentState = async (): Promise<FleetState> =>
    loadFleetState(deps.paseoHome) ??
    (await pollFleetPulseCached({
      paseoHome: deps.paseoHome,
      transport: deps.transport,
      localSource: deps.localSource ?? defaultLocalPulseSource(deps.paseoHome),
      now: deps.now,
    }));

  return {
    async snapshot(_input: {}) {
      try {
        return { ok: true as const, view: view() };
      } catch (error) {
        return failure("snapshot-failed", messageOf(error));
      }
    },

    async pulse(input: { activeSurface?: boolean }) {
      try {
        const now = deps.now ?? (() => new Date());
        const previous = loadFleetState(deps.paseoHome);
        const due = shouldPollNow(previous, {
          activeSurface: input.activeSurface === true,
          nowMs: now().getTime(),
        });
        // `shouldPollNow` stays the cadence law on top; the due poll itself
        // runs through the single-flight TTL cache so concurrent callers share
        // one in-flight collection.
        const state = due
          ? await pollFleetPulseCached({
              paseoHome: deps.paseoHome,
              transport: deps.transport,
              localSource: deps.localSource ?? defaultLocalPulseSource(deps.paseoHome),
              now,
            })
          : (previous as NonNullable<typeof previous>);
        return { ok: true as const, view: view(state) };
      } catch (error) {
        return failure("pulse-failed", messageOf(error));
      }
    },

    async nodeUpsert(input: FleetNodeInputView) {
      try {
        upsertNode(deps.paseoHome, input);
        log(`node.upsert: ${input.id} (${input.posture}) registered`);
        return { ok: true as const, view: view() };
      } catch (error) {
        return failure("invalid-node", messageOf(error));
      }
    },

    async nodeReserve(input: { nodeId: string; reserveMode: boolean }) {
      try {
        setNodeReserveMode(deps.paseoHome, input.nodeId, input.reserveMode);
        log(`node.reserve: ${input.nodeId} → ${input.reserveMode ? "reserved" : "available"}`);
        return { ok: true as const, view: view() };
      } catch (error) {
        return failure("unknown-node", messageOf(error));
      }
    },

    async nodeRemove(input: { nodeId: string }) {
      // The refusal codes the operator acts on: unknown peer vs the local Node.
      const config = loadFleetConfig(deps.paseoHome);
      if (!config.nodes.some((node) => node.id === input.nodeId)) {
        return failure("unknown-node", `no Node with id ${JSON.stringify(input.nodeId)} in the Fleet`);
      }
      if (input.nodeId === config.localNodeId) {
        return failure(
          "local-node",
          "the local Node cannot be removed from the Fleet registry — it anchors who is running this connector",
        );
      }
      try {
        removeNode(deps.paseoHome, input.nodeId);
        log(`node.remove: ${input.nodeId} unregistered`);
        return { ok: true as const, view: view() };
      } catch (error) {
        return failure("remove-failed", messageOf(error));
      }
    },

    async handoff(input: {
      projectPath: string;
      base: string;
      canonicalSlug: string;
      kind: "burn-run" | "task";
      runOrTaskId: string;
      command: string;
      playbook?: string | null;
      prompt?: string | null;
      targetNodeId?: string;
    }) {
      try {
        const record = await dispatchHandoff({
          paseoHome: deps.paseoHome,
          projectPath: input.projectPath,
          base: input.base,
          canonicalSlug: input.canonicalSlug,
          brief: {
            kind: input.kind,
            runOrTaskId: input.runOrTaskId,
            command: input.command,
            playbook: input.playbook ?? null,
            prompt: input.prompt ?? null,
          },
          state: await currentState(),
          targetNodeId: input.targetNodeId,
          localRunner: deps.localRunner,
          bundleTransport: deps.bundleTransport,
          remoteRunner: deps.remoteRunner,
          now: deps.now,
        });
        log(`handoff: ${record.handoffId} → ${record.targetNodeId} (${record.expectedFleetRef})`);
        return { ok: true as const, handoff: handoffViewOf(record) };
      } catch (error) {
        return failure("handoff-failed", messageOf(error));
      }
    },

    async burst(input: { units: { id: string; command: string }[] }) {
      try {
        const report = await executeBurst({
          paseoHome: deps.paseoHome,
          state: await currentState(),
          units: input.units,
          localRunner: deps.localRunner,
          remoteRunner: deps.remoteRunner,
          now: deps.now,
        });
        const settled = report.results.filter((result) => result.ok).length;
        log(`burst: ${settled}/${report.results.length} units settled ok`);
        return { ok: true as const, report: report as BurstReportView };
      } catch (error) {
        return failure("burst-failed", messageOf(error));
      }
    },

    async gossipSync(_input: {}) {
      try {
        // "Now" means now: a fresh poll collects the peers' current stamps to
        // order the reconciliation against (a stale snapshot would miss runs a
        // peer finished since the last cadence tick).
        const state = await pollFleetPulse({
          paseoHome: deps.paseoHome,
          transport: deps.transport,
          localSource: deps.localSource ?? defaultLocalPulseSource(deps.paseoHome),
          now: deps.now,
        });
        const registry = new Map(loadFleetConfig(deps.paseoHome).nodes.map((node) => [node.id, node]));
        const peers = state.nodes
          .filter((entry) => entry.nodeId !== state.localNodeId && entry.online)
          .flatMap((entry) => {
            const node = registry.get(entry.nodeId);
            return node === undefined ? [] : [{ node, pulse: entry }];
          });
        const report = await reconcileGossipSync({
          paseoHome: deps.paseoHome,
          peers,
          transport: deps.gossipTransport ?? createSshGossipTransport(),
        });
        log(
          `gossip.sync: pulled ${report.freePool.length} free-pool update(s), ${report.runs.length} run record(s)`,
        );
        return { ok: true as const, report: report as GossipSyncReportView };
      } catch (error) {
        return failure("gossip-failed", messageOf(error));
      }
    },

    async refLand(input: {
      repoPath: string;
      nodeId: string;
      runOrTaskId: string;
      mode?: "checkout" | "merge";
    }) {
      try {
        const landed = await landFleetRef({
          repoPath: input.repoPath,
          nodeId: input.nodeId,
          runOrTaskId: input.runOrTaskId,
          mode: input.mode,
        });
        log(`ref.land: ${input.nodeId}/${input.runOrTaskId} → ${landed.branch} (${landed.mode})`);
        return { ok: true as const, landed: landed as LandedFleetRefView };
      } catch (error) {
        return failure("land-failed", messageOf(error));
      }
    },

    async logRead(input: { handoffId: string }) {
      try {
        const record = loadHandoff(deps.paseoHome, input.handoffId);
        if (!record) {
          return failure(
            "unknown-handoff",
            `no Handoff record ${JSON.stringify(input.handoffId)} on this Node`,
          );
        }
        // The log lives where the run executed: on the target (inbound record)
        // — an initiator's outbound record has no local log to serve.
        const logTail = record.logPath !== null ? readTail(record.logPath, LOG_READ_MAX_BYTES) : null;
        // The gossip-synced report this Node holds for the run, when it has one.
        const reportPath = join(
          burnRunsDirPath(deps.paseoHome),
          record.runOrTaskId,
          "report.md",
        );
        const report = readTail(reportPath, LOG_READ_MAX_BYTES);
        const logView: HandoffLogView = {
          handoffId: record.handoffId,
          logPath: record.logPath,
          logTail,
          reportPath: report !== null ? reportPath : null,
          report,
        };
        log(`log.read: ${record.handoffId} (log ${logTail !== null ? "served" : "absent"}, report ${report !== null ? "served" : "absent"})`);
        return { ok: true as const, log: logView };
      } catch (error) {
        return failure("log-read-failed", messageOf(error));
      }
    },

    async tailscaleDiscover(_input: {}) {
      try {
        const peers = await discoverTailscalePeers(deps.discoveryRunner ?? execCommandRunner);
        log(`tailscale.discover: ${peers.length} peer(s) visible`);
        return { ok: true as const, peers };
      } catch (error) {
        return failure("discovery-failed", messageOf(error));
      }
    },
  };
}

/** The handlers' shared type — the shell builds them once and registers them. */
export type SurfaceHandlers = ReturnType<typeof createSurfaceHandlers>;

/**
 * Registers every `connector.*` handler on the plugin server. Each call
 * carries the daemon's `context.paseo` through to the handler context.
 */
export function registerSurfaceRpc(server: PluginServerContext, handlers: SurfaceHandlers): void {
  server.handle(snapshot, (input) => handlers.snapshot(input));
  server.handle(nodeUpsert, (input) => handlers.nodeUpsert(input));
  server.handle(nodeRemove, (input) => handlers.nodeRemove(input));
  server.handle(nodeReserve, (input) => handlers.nodeReserve(input));
  server.handle(pulse, (input) => handlers.pulse(input));
  server.handle(handoff, (input) => handlers.handoff(input));
  server.handle(burst, (input) => handlers.burst(input));
  server.handle(gossipSync, (input) => handlers.gossipSync(input));
  server.handle(logRead, (input) => handlers.logRead(input));
  server.handle(refLand, (input) => handlers.refLand(input));
  server.handle(tailscaleDiscover, (input) => handlers.tailscaleDiscover(input));
}
