# 04: Paseo `Fleet surface` plugin UI, server RPCs, and trial daemon installation

**What to build:** The `factory-connector` Paseo plugin (`plugin/paseo-plugin.json`, `plugin/index.server.ts`, `plugin/index.client.tsx`) renders the 100% UI-driven `Fleet surface` inside Paseo Desktop (4-node `Fleet` matrix, `Reserve mode` toggles, `Node` editor + Tailscale discovery, 1-click `Handoff` launcher, `Gossip sync`, and `Fleet ref` `Land` button), passes `npm run check:bundle` and `npm test`, and installs cleanly on `~/.paseo-factory`.

**Blocked by:** 03: Autonomous `Handoff`, cooperative `Burst` with disconnect failover, and `Connector bridge`

**Status:** ready-for-agent

- [ ] `plugin/paseo-plugin.json`, `plugin/shared/view.ts`, `plugin/shared/rpc.ts`, and `plugin/server/surface-rpc.ts` expose `connector.snapshot`, `connector.pulse`, `connector.node.upsert`, `connector.node.remove`, `connector.node.reserve`, `connector.handoff`, `connector.burst`, `connector.gossip.sync`, and `connector.ref.land`.
- [ ] `plugin/index.client.tsx` and `plugin/client/fleet/shell.tsx` render the `Fleet Connector` sidebar screen and workspace panel in Paseo Desktop (Hermes-safe CJS bundle, zero `class` syntax).
- [ ] `npm run sync:plugin-core && npm run typecheck && npm test` passes 100%, and `factory-connector` is registered in `~/.paseo-factory/config.json` and `~/.paseo/config.json`.
  - Amendment (2026-10-17, review of integration/v0.0.1-connector): registration in `~/.paseo/config.json` is deliberately deferred. AGENTS.md pins `~/.paseo` as prod, "where only verified builds are installed" — v0.0.1 is not yet a verified build, so it stays trial-only. Verified state: registered + enabled in `~/.paseo-factory/config.json`; absent from `~/.paseo/config.json`. Register in the prod home when a verified build is cut.
