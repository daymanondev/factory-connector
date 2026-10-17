/**
 * The `Fleet surface`'s view vocabulary — the one shape the client renders and
 * the server folds. Plain JSON only: `shared/` may be imported by both
 * bundles, so it names no SDK surface beyond zod and no node built-in. The
 * `version` literal is the snapshot's compatibility contract — a client that
 * sees a version it does not know says so, never guesses. The server-side fold
 * (registry + pulse snapshot + handoff records → view) lives in
 * `plugin/server/view.ts`; this file is the wire shape alone.
 */
import { z } from "zod";

/** Bump when the shape changes in a way an older client cannot render. */
export const FLEET_VIEW_VERSION = 1 as const;

export const NodePostureSchema = z.enum(["stationary", "mobile"]);
export type NodePostureView = z.infer<typeof NodePostureSchema>;

export const NodeTransportSchema = z.enum(["local", "ssh"]);

export const HealthGuardSchema = z.object({
  maxCpuPercent: z.number(),
  minFreeMemMb: z.number(),
});

/** One `Node` card of the `Fleet` matrix — registry facts merged with its latest `Fleet pulse`. */
export const FleetNodeViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  posture: NodePostureSchema,
  transport: NodeTransportSchema,
  /** `ssh://user@100.x.y.z?daemonPort=6767` Tailscale target (SSH Nodes only). */
  sshTarget: z.string().nullable(),
  online: z.boolean(),
  cpuPercent: z.number(),
  freeMemMb: z.number(),
  activeAgents: z.number().int(),
  activeBurnRuns: z.number().int(),
  meterSummary: z.record(z.string(), z.number()).nullable(),
  slotCeiling: z.number().int(),
  slotsInUse: z.number().int(),
  reserveMode: z.boolean(),
  healthGuard: HealthGuardSchema,
  /** True for the `Node` this plugin runs on. */
  local: z.boolean(),
  freePoolUpdatedAt: z.string().nullable(),
  runsUpdatedAt: z.string().nullable(),
  /** When the Node's digest was collected; null when it was never polled. */
  collectedAt: z.string().nullable(),
  /** Why the last pulse fetch failed, when it did. */
  lastError: z.string().nullable(),
});
export type FleetNodeView = z.infer<typeof FleetNodeViewSchema>;

/** The node editor's full payload — identity + posture required, the rest defaults. */
export const FleetNodeInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  posture: NodePostureSchema,
  transport: NodeTransportSchema.optional(),
  sshTarget: z.string().optional(),
  paseoEndpoint: z.string().optional(),
  remotePaseoHome: z.string().optional(),
  slotCeiling: z.number().int().min(1).optional(),
  reserveMode: z.boolean().optional(),
  healthGuard: HealthGuardSchema.partial().optional(),
});
export type FleetNodeInputView = z.infer<typeof FleetNodeInputSchema>;

export const HandoffDirectionSchema = z.enum(["outbound", "inbound"]);
export const HandoffKindSchema = z.enum(["burn-run", "task"]);
export const HandoffStatusSchema = z.enum(["dispatched", "running", "completed", "failed"]);

/** One `Handoff` record row of the `Synced Fleet Runs & Fleet Refs` list. */
export const HandoffRecordViewSchema = z.object({
  handoffId: z.string(),
  direction: HandoffDirectionSchema,
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  runOrTaskId: z.string(),
  kind: HandoffKindSchema,
  status: HandoffStatusSchema,
  playbook: z.string().nullable(),
  prompt: z.string().nullable(),
  canonicalSlug: z.string(),
  /** `refs/fleet/<nodeId>/<runOrTaskId>` the completion stages under for `Land`. */
  expectedFleetRef: z.string(),
  dispatchedAt: z.string(),
  updatedAt: z.string(),
  error: z.string().nullable(),
  logPath: z.string().nullable(),
});
export type HandoffRecordView = z.infer<typeof HandoffRecordViewSchema>;

/** The whole `Fleet surface` — one fold of everything the UI renders. */
export const FleetViewSchema = z.object({
  version: z.literal(FLEET_VIEW_VERSION),
  localNodeId: z.string(),
  generatedAt: z.string(),
  /** The `<paseoHome>` the server runs against (diagnostics + Land hints). */
  paseoHome: z.string(),
  nodes: z.array(FleetNodeViewSchema),
  handoffs: z.array(HandoffRecordViewSchema),
});
export type FleetView = z.infer<typeof FleetViewSchema>;

/** One execution of one `Burst` work unit on one `Node` (failover appends more). */
export const BurstAttemptViewSchema = z.object({
  nodeId: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
});
export type BurstAttemptView = z.infer<typeof BurstAttemptViewSchema>;

/** Final outcome of one `Burst` work unit: every attempt in order plus where it settled. */
export const BurstUnitResultViewSchema = z.object({
  unitId: z.string(),
  command: z.string(),
  attempts: z.array(BurstAttemptViewSchema),
  ok: z.boolean(),
  /** `Node` that finally ran the unit (null when every attempt failed). */
  nodeId: z.string().nullable(),
});
export type BurstUnitResultView = z.infer<typeof BurstUnitResultViewSchema>;

/** What a whole `Burst` settled to. */
export const BurstReportViewSchema = z.object({
  ok: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string(),
  results: z.array(BurstUnitResultViewSchema),
});
export type BurstReportView = z.infer<typeof BurstReportViewSchema>;

/** One `free-pool.json` pulled from a peer because its stamp was newer. */
export const GossipFreePoolPullSchema = z.object({
  nodeId: z.string(),
  updatedAt: z.string(),
});

/** One completed `BurnRunRecord` (and its artifacts) pulled from a peer. */
export const GossipRunPullSchema = z.object({
  nodeId: z.string(),
  runId: z.string(),
  updatedAt: z.string(),
});

/** What a `Gossip sync` pass actually reconciled. */
export const GossipSyncReportViewSchema = z.object({
  freePool: z.array(GossipFreePoolPullSchema),
  runs: z.array(GossipRunPullSchema),
});
export type GossipSyncReportView = z.infer<typeof GossipSyncReportViewSchema>;
