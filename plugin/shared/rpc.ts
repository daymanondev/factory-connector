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
import { FleetNodeInputSchema, FleetViewSchema } from "./view.ts";

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
