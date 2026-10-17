/**
 * The `Fleet surface`'s RPC contracts — the one vocabulary both halves
 * import. Every method name is `connector.*` (the daemon validates
 * `/^[a-z][a-z0-9._-]*$/` and uniqueness); every output is a discriminated
 * union on `ok` so a refusal is data, never an exception across the RPC line.
 * The handlers run inside the plugin server process against the co-located
 * connector core (`plugin/server/core/`, mirrored from `src/`).
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { BurstReportViewSchema, FleetNodeInputSchema, FleetViewSchema, GossipSyncReportViewSchema, HandoffKindSchema, HandoffRecordViewSchema, LandedFleetRefViewSchema, LandFleetRefModeSchema } from "./view.ts";

/** Every handler's refusal shape: a stable machine code plus the human sentence. */
export const Failure = z.object({ ok: z.literal(false), code: z.string(), error: z.string() });

export const snapshot = defineRpc({
  name: "connector.snapshot",
  input: z.object({}),
  output: z.union([z.object({ ok: z.literal(true), view: FleetViewSchema }), Failure]),
});

export const nodeUpsert = defineRpc({
  name: "connector.node.upsert",
  input: FleetNodeInputSchema,
  output: z.union([z.object({ ok: z.literal(true), view: FleetViewSchema }), Failure]),
});

export const nodeRemove = defineRpc({
  name: "connector.node.remove",
  input: z.object({ nodeId: z.string().min(1) }),
  output: z.union([z.object({ ok: z.literal(true), view: FleetViewSchema }), Failure]),
});

export const nodeReserve = defineRpc({
  name: "connector.node.reserve",
  input: z.object({ nodeId: z.string().min(1), reserveMode: z.boolean() }),
  output: z.union([z.object({ ok: z.literal(true), view: FleetViewSchema }), Failure]),
});

export const pulse = defineRpc({
  name: "connector.pulse",
  input: z.object({
    /** True while the `Fleet surface` is open — tightens the cadence to 5s (60s idle). */
    activeSurface: z.boolean().optional(),
  }),
  output: z.union([z.object({ ok: z.literal(true), view: FleetViewSchema }), Failure]),
});

export const handoff = defineRpc({
  name: "connector.handoff",
  input: z.object({
    /** Source `Project` repository to package as a `git bundle`. */
    projectPath: z.string().min(1),
    /** Exclusive start of the packaged `<base>..HEAD` range. */
    base: z.string().min(1),
    /** `Project` canonical slug naming the target `Mirror repo`. */
    canonicalSlug: z.string().min(1),
    kind: HandoffKindSchema,
    runOrTaskId: z.string().min(1),
    /** Detached command the target `Host node` executes inside its `Mirror repo`. */
    command: z.string().min(1),
    playbook: z.string().nullable().optional(),
    prompt: z.string().nullable().optional(),
    /** Explicit `Node` id or `"auto-stationary"` (the default). */
    targetNodeId: z.string().optional(),
  }),
  output: z.union([z.object({ ok: z.literal(true), handoff: HandoffRecordViewSchema }), Failure]),
});

export const burst = defineRpc({
  name: "connector.burst",
  input: z.object({
    units: z
      .array(
        z.object({
          id: z.string().min(1),
          command: z.string().min(1),
        }),
      )
      .min(1),
  }),
  output: z.union([z.object({ ok: z.literal(true), report: BurstReportViewSchema }), Failure]),
});

export const gossipSync = defineRpc({
  name: "connector.gossip.sync",
  input: z.object({}),
  output: z.union([z.object({ ok: z.literal(true), report: GossipSyncReportViewSchema }), Failure]),
});

export const refLand = defineRpc({
  name: "connector.ref.land",
  input: z.object({
    /** Local repository the `Fleet ref` is staged in. */
    repoPath: z.string().min(1),
    nodeId: z.string().min(1),
    runOrTaskId: z.string().min(1),
    mode: LandFleetRefModeSchema.optional(),
  }),
  output: z.union([z.object({ ok: z.literal(true), landed: LandedFleetRefViewSchema }), Failure]),
});

export const tailscaleDiscover = defineRpc({
  name: "connector.tailscale.discover",
  input: z.object({}),
  output: z.union([
    z.object({
      ok: z.literal(true),
      peers: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          dnsName: z.string(),
          tailscaleIp: z.string(),
          online: z.boolean(),
          os: z.string(),
        }),
      ),
    }),
    Failure,
  ]),
});
