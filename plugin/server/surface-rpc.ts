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
import {
  defaultLocalPulseSource,
  loadFleetConfig,
  loadFleetState,
  pollFleetPulse,
  removeNode,
  setNodeReserveMode,
  shouldPollNow,
  upsertNode,
  type CommandRunner,
  type FleetState,
  type LocalPulseSource,
  type PulseTransport,
} from "./core/fleet.ts";
import type { GossipArtifactTransport } from "./core/git-sync.ts";
import { dispatchHandoff, type GitBundleTransport, type HandoffRecord, type RemoteCommandRunner } from "./core/dispatch.ts";
import { foldFleetView } from "./view.ts";
import { handoff, nodeRemove, nodeReserve, nodeUpsert, pulse, snapshot } from "../shared/rpc.ts";
import type { FleetNodeInputView, FleetView, HandoffRecordView } from "../shared/view.ts";

/** What each `server.handle` call passes besides the parsed input. */
export interface SurfaceCallContext {
  paseo?: unknown;
}

/** The structural slice of PaseoApi the surface reads (agent activity counts). */
export interface SurfaceDaemonApi {
  agents: {
    list(options?: { filter?: { includeArchived?: boolean } }): Promise<{ entries: unknown[] }>;
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
  remoteRunner?: DispatchRemoteRunner;
  /** Local command runner for `Burst` on the local `Node` (tests stub it). */
  localRunner?: CommandRunner;
  /** Daemon API for local activity counts, when the shell captured one. */
  daemon?: () => SurfaceDaemonApi | undefined;
  now?: () => Date;
  onLog?: (message: string) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  /** The freshest snapshot there is — the on-disk one, or a first poll. */
  const currentState = async (): Promise<FleetState> =>
    loadFleetState(deps.paseoHome) ??
    (await pollFleetPulse({
      paseoHome: deps.paseoHome,
      transport: deps.transport,
      localSource: deps.localSource ?? defaultLocalPulseSource(),
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
        const state = due
          ? await pollFleetPulse({
              paseoHome: deps.paseoHome,
              transport: deps.transport,
              localSource: deps.localSource ?? defaultLocalPulseSource(),
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
}
