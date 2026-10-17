/**
 * The server-side fold of the `Fleet surface` view: the peer `Fleet` registry
 * (`fleet.json`), the live `Fleet pulse` snapshot (`fleet-state.json`), and the
 * `Handoff` records (`connector/handoffs/*.json`) become the one plain-JSON
 * `FleetView` the client renders (`plugin/shared/view.ts` is the wire shape).
 * A `Node` the registry knows but no poll has covered yet still renders —
 * offline with null facts, never invented ones.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  loadFleetConfig,
  loadFleetState,
  type FleetNode,
  type FleetNodeState,
  type FleetState,
} from "./core/fleet.ts";
import {
  FLEET_VIEW_VERSION,
  type FleetNodeView,
  type FleetView,
  type HandoffRecordView,
} from "../shared/view.ts";

/** Directory holding the `<handoffId>.json` records (staging dirs sit beside them). */
function handoffsDir(paseoHome: string): string {
  return join(paseoHome, "connector", "handoffs");
}

/** Reads every persisted `Handoff` record; malformed entries are skipped, never fatal. */
export function readHandoffRecords(paseoHome: string): HandoffRecordView[] {
  let files: string[];
  try {
    files = readdirSync(handoffsDir(paseoHome));
  } catch {
    return [];
  }
  const records: HandoffRecordView[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".json")) continue;
    const path = join(handoffsDir(paseoHome), file);
    try {
      if (!statSync(path).isFile()) continue;
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      records.push({
        handoffId: String(raw.handoffId),
        direction: raw.direction === "inbound" ? "inbound" : "outbound",
        sourceNodeId: String(raw.sourceNodeId),
        targetNodeId: String(raw.targetNodeId),
        runOrTaskId: String(raw.runOrTaskId),
        kind: raw.kind === "task" ? "task" : "burn-run",
        status: (["dispatched", "running", "completed", "failed"] as const).includes(
          raw.status as "dispatched",
        )
          ? (raw.status as HandoffRecordView["status"])
          : "dispatched",
        playbook:
          typeof raw.playbook === "string"
            ? raw.playbook
            : ((raw.brief as Record<string, unknown> | undefined)?.playbook as string | undefined) ?? null,
        prompt:
          typeof raw.prompt === "string"
            ? raw.prompt
            : ((raw.brief as Record<string, unknown> | undefined)?.prompt as string | undefined) ?? null,
        canonicalSlug: String(raw.canonicalSlug),
        expectedFleetRef: String(raw.expectedFleetRef),
        dispatchedAt: String(raw.dispatchedAt),
        updatedAt: String(raw.updatedAt),
        error: typeof raw.error === "string" ? raw.error : null,
        logPath: typeof raw.logPath === "string" ? raw.logPath : null,
      });
    } catch {
      // A handoff record this fold cannot parse must not blank the surface.
    }
  }
  return records;
}

function nodeViewOf(node: FleetNode, state: FleetNodeState | undefined, local: boolean): FleetNodeView {
  return {
    id: node.id,
    name: node.name,
    posture: node.posture,
    transport: node.transport,
    sshTarget: node.sshTarget ?? null,
    online: state?.online ?? false,
    cpuPercent: state?.cpuPercent ?? 0,
    freeMemMb: state?.freeMemMb ?? 0,
    activeAgents: state?.activeAgents ?? 0,
    activeBurnRuns: state?.activeBurnRuns ?? 0,
    meterSummary: state?.meterSummary ?? null,
    slotCeiling: node.slotCeiling,
    slotsInUse: state?.slotsInUse ?? 0,
    reserveMode: node.reserveMode,
    healthGuard: node.healthGuard,
    local,
    freePoolUpdatedAt: state?.freePoolUpdatedAt ?? null,
    runsUpdatedAt: state?.runsUpdatedAt ?? null,
    collectedAt: state?.collectedAt ?? null,
    lastError: state?.lastError ?? null,
  };
}

/**
 * Folds the whole `Fleet surface`: registry + pulse snapshot + handoff
 * records. `state` overrides the on-disk snapshot when supplied (a poll the
 * caller just ran); a missing snapshot simply renders every `Node` unpolled.
 */
export function foldFleetView(options: {
  paseoHome: string;
  state?: FleetState | null;
  now?: () => Date;
}): FleetView {
  const config = loadFleetConfig(options.paseoHome);
  const state = options.state !== undefined ? options.state : loadFleetState(options.paseoHome);
  const stateByNode = new Map((state?.nodes ?? []).map((entry) => [entry.nodeId, entry]));
  return {
    version: FLEET_VIEW_VERSION,
    localNodeId: config.localNodeId,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    paseoHome: options.paseoHome,
    nodes: config.nodes.map((node) =>
      nodeViewOf(node, stateByNode.get(node.id), node.id === config.localNodeId),
    ),
    handoffs: readHandoffRecords(options.paseoHome),
  };
}
