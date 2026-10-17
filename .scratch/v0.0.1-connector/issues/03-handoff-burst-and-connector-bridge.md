# 03: Autonomous `Handoff`, cooperative `Burst` with disconnect failover, and `Connector bridge`

**What to build:** An initiating `Node` (such as a `mobile` laptop about to disconnect) can `Handoff` a full `Burn run` or `Task` to a `stationary` `Host node` that runs it autonomously to completion, and any `Host node` can `Burst` parallel probes or worktree attempts across online peer `Node`s with automatic retry on surviving `Node`s if a peer disconnects mid-attempt, exposed via both `src/dispatch.ts` and `<paseoHome>/connector/bin/connector-dispatch`.

**Blocked by:** 01: Fleet registry, `Node posture`, `Health guard`, and low-bandwidth `Fleet pulse`, 02: Git-native `Mirror repo`, `Fleet ref` staging, `Land`, and `Gossip sync`

**Status:** ready-for-agent

- [ ] `dispatchHandoff` packages the source `Project`'s `git bundle` + `.worktreeinclude` and dispatches a detached run to a selected `Host node` (or auto-selected `stationary` `Node`), recording the handoff in `<paseoHome>/connector/handoffs/<handoffId>.json` so the initiating `Node` can disconnect immediately and later reconcile completion + `Fleet ref`.
- [ ] `executeBurst` distributes a batch of parallel work units across eligible online `Node`s (respecting `Slot ceiling`, `Health guard`, and `Reserve mode`) and transparently retries any work unit on a surviving `Node` if a peer `Node` disconnects or times out mid-attempt.
- [ ] `ensureConnectorBridge` writes `<paseoHome>/connector/fleet-state.json` and generates the `<paseoHome>/connector/bin/connector-dispatch` CLI wrapper so `factory-burn-lab` and `paseo-factory` can consume `Fleet` capacity without cross-repo imports.
- [ ] Behavioral unit tests in `test/dispatch.test.ts` verify `Handoff` survival across initiator disconnect and `Burst` failover when a peer `Node` drops mid-run.
