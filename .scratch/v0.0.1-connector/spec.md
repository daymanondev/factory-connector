# Spec — `factory-connector` v0.0.1: Symmetric Peer Fleet, Low-Bandwidth `Fleet pulse`, `Handoff` & `Burst` Mesh, and Paseo `Fleet surface`

Status: ready-for-agent

- **Grounded in:** [`CONTEXT.md`](../../CONTEXT.md) · [`ADR 0001`](../../docs/adr/0001-symmetric-peer-fleet-handoff-and-burst-mesh.md) · [`docs/research/multi-machine-factory-connector.md`](../../docs/research/multi-machine-factory-connector.md)

## Problem Statement

The operator runs four machines connected via Tailscale: one primary `mobile` MacBook (which moves around and may close its lid or disconnect at any time), two additional Macs (`stationary`), and one Windows machine running WSL2 Ubuntu (`stationary`). Running heavy `factory-burn-lab` multi-model swarms or concurrent `paseo-factory` tasks on a single machine exhausts local CPU/RAM and slows down foreground work, while opening four separate machines to check what each is doing is tedious.

However, Paseo Desktop's built-in multi-host support only offers a per-screen host picker (viewing one machine at a time with no cross-machine orchestration), and a naive master–slave (`Hub–Spoke`) design anchored to the laptop would freeze or kill active runs across the other machines whenever the laptop closes its lid. Meanwhile, streaming raw agent token outputs or full gate logs across Tailscale would waste bandwidth (especially on mobile hotspots).

The operator needs a standalone companion Paseo plugin (`factory-connector`) that connects all four machines as a **Symmetric Peer `Fleet`** where every `Node` is self-sufficient, provides a unified **`Fleet surface`** UI inside Paseo Desktop, supports 1-click **`Handoff`** (transferring full job ownership to a `stationary` `Host node` in 1–2 seconds so the laptop can disconnect safely), supports cooperative **`Burst`** (splitting parallel probes/worktree attempts across online peer `Node`s), and exchanges sub-kilobyte **`Fleet pulse`** digests plus Git-native `git bundle` payloads over Tailscale.

## Solution

1. **Symmetric Peer `Fleet` Registry, `Health guard`, and Digest-First `Fleet pulse` (`src/fleet.ts`):**
   - Manages the peer `Fleet` registry (`<paseoHome>/connector/fleet.json`) and live state snapshot (`<paseoHome>/connector/fleet-state.json`).
   - Each `Node` carries its `id`, `name`, `posture` (`stationary` | `mobile`), `transport` (`local` | `ssh`), `sshTarget` / `paseoEndpoint` (`ssh://user@100.x.y.z?daemonPort=6767`), `slotCeiling`, and `reserveMode` flag.
   - Polls peer `Node`s using a digest-first **`Fleet pulse`** (~500 bytes JSON: `online`, `cpuPercent`, `freeMemMb`, `activeAgents`, `activeBurnRuns`, `meterSummary`, `freePoolUpdatedAt`, `runsUpdatedAt`) at a 60s background cadence (or 5–10s when `Fleet surface` is open), never streaming live token chunks or heavy logs over Tailscale.
   - Enforces **`Slot ceiling`**, **`Health guard`** (CPU load & free RAM thresholds), and **`Reserve mode`** when selecting candidate `Node`s for `Handoff` or `Burst`.

2. **Git-Native `Mirror repo`, `Fleet ref`, and `Gossip sync` (`src/git-sync.ts`):**
   - Packages any repository commit range (`<base>..HEAD`) and `.worktreeinclude` files into a compact `git bundle` payload for cross-machine transfer without shared network filesystems (SMB/NFS).
   - Automatically provisions and updates on-demand **`Mirror repo`** directories at `<paseoHome>/connector/repos/<canonical-slug>` on peer `Node`s (preserving each `Node`'s OS-native `node_modules` cache) so the operator never has to manually `git clone` projects on every machine.
   - Stages completed remote commits silently into the initiating repository under **`Fleet ref`** (`refs/fleet/<nodeId>/<runOrTaskId>`) without touching the user's active working tree, and provides a 1-click **`Land`** operation to checkout or fast-forward/merge a `Fleet ref`.
   - Performs last-write-wins **`Gossip sync`** of `free-pool.json` and completed `BurnRunRecord` / `report.md` summaries whenever a `Fleet pulse` reports a newer timestamp on a peer `Node`.

3. **Autonomous `Handoff`, Cooperative `Burst`, and `Connector bridge` (`src/dispatch.ts`):**
   - **`Handoff`:** Transfers a `Burn run` (or `Task`) brief plus its `git bundle` to a selected `Host node` (preferring `stationary` `Node`s when `targetNodeId === "auto-stationary"`), spawning the detached run on the target `Node`'s Paseo/Burn runtime so the initiating `mobile` `Node` can disconnect immediately.
   - **`Burst`:** Distributes an array of parallel work units (stateless `Scout pool` / `OSS lab` / `Council` probes or isolated worktree + `Gate` attempts) across eligible online `Node`s in the `Fleet` respecting each `Node`'s available slots, `Health guard`, and `Reserve mode`, automatically retrying any failed/disconnected peer attempt on surviving `Node`s.
   - **`Connector bridge`:** Writes `<paseoHome>/connector/fleet-state.json` and generates `<paseoHome>/connector/bin/connector-dispatch` so `factory-burn-lab` and `paseo-factory` can invoke `Burst` and `Handoff` with zero cross-repo code imports.

4. **100% UI-Driven `Fleet surface` inside Paseo Desktop (`plugin/`):**
   - Registers the `Fleet Connector` sidebar screen and workspace panel inside Paseo Desktop.
   - Displays the 4-node `Fleet` matrix (`stationary` vs `mobile` badge, Online/Offline, CPU/RAM `Health guard` meters, `Slot ceiling` usage, active Paseo `Agent`s & `Burn run`s per `Node`, and `Reserve mode` 1-click toggle).
   - Provides a `Node` registration/editor modal (with Tailscale auto-discovery helper), a **`Handoff Run`** launcher (pick Project, Playbook, Brief, and target `stationary` `Node`), a **`Synced Fleet Runs & Fleet Refs`** list with 1-click **`Land Branch`** and on-demand report/log viewer, and a **`Gossip Sync Now`** button.

## User Stories

1. As an `Owner`, I want to open `Fleet Connector` (`Fleet surface`) in Paseo Desktop on my current Mac and immediately see the status of all 4 machines (current Mac, 2 secondary Macs, 1 Windows WSL2 machine) in one unified screen without switching Paseo's host picker, so that I never have to walk over or turn on each screen to see what it is doing.
2. As an `Owner`, I want each `Node` card on `Fleet surface` to show its `Node posture` (`stationary` vs `mobile`), online latency, CPU/free-RAM `Health guard` status, active Paseo `Agent`s, active `Burn run`s, and `Slot ceiling` utilization, so that I know at a glance which machines are busy and which are idle.
3. As an `Owner`, I want to toggle **`Reserve mode`** on my primary MacBook with one click on `Fleet surface`, so that background `Burst` tasks stop scheduling onto my laptop while I am doing heavy foreground work.
4. As an `Owner` about to close my laptop and move around, I want to launch a `Handoff` from `Fleet surface` (selecting a `Project`, `Burn playbook`, prompt, and either a specific `Node` or `Auto Stationary Node`), so that my laptop packages the `git bundle` in 1–2 seconds, transfers full ownership to the stationary `Host node`, and lets me close my laptop immediately while the stationary machine runs the job from start to finish.
5. As an `Owner` running a multi-model `Burn run` on any `Host node`, I want `Burst` to automatically split parallel model probes and isolated worktree + `Gate` attempts across all eligible online `Node`s in the `Fleet` (and transparently retry on surviving `Node`s if a `mobile` `Node` disconnects mid-attempt), so that 4 machines finish the work up to 4x faster.
6. As an `Owner` who never manually cloned a pet project onto my secondary Macs or Windows WSL2 machine, I want `factory-connector` to automatically provision and update a **`Mirror repo`** (`<paseoHome>/connector/repos/<canonical-slug>`) from a compact `git bundle` whenever work is handed off or burst to that `Node`, so that zero manual repo setup is needed on peer machines.
7. As an `Owner` reconnecting my laptop to Tailscale after a stationary `Node` finished a handed-off run, I want `Gossip sync` to automatically pull the completed `BurnRunRecord`, `report.md`, updated `free-pool.json`, and stage the winning commits under `refs/fleet/<nodeId>/<runId>` (`Fleet ref`) without touching my dirty working tree, so that I can read the report immediately and click `Land` when I am ready to apply the code.
8. As an `Owner` using Tailscale over a mobile hotspot while traveling, I want background communication between `Node`s to use sub-kilobyte `Fleet pulse` digests (60s idle, 5–10s while viewing `Fleet surface`) and never stream live LLM tokens or multi-megabyte gate logs unless I click to inspect a specific log, so that bandwidth and battery usage remain negligible.

## Implementation Decisions

1. **Placement & Hermes Bundle Boundary Law (Shared with `paseo-factory` & `factory-burn-lab`):**
   - Pure Node modules live in `src/` (`src/fleet.ts`, `src/git-sync.ts`, `src/dispatch.ts`, `src/index.ts`) and are mirrored verbatim into `plugin/server/core/` via `npm run sync:plugin-core`.
   - `scripts/check-bundle.mjs` verifies that `plugin/index.client.tsx` (Hermes-safe CJS, zero `class` declarations, zero `node:*` imports) and `plugin/index.server.ts` compile cleanly from git-tracked files.
2. **State Layout under `<paseoHome>/connector/`:**
   - `<paseoHome>/connector/fleet.json`: persistent configuration of registered `Node`s (`id`, `name`, `posture`, `transport`, `sshTarget`, `paseoEndpoint`, `slotCeiling`, `reserveMode`, `healthGuard`: `{ maxCpuPercent, minFreeMemMb }`).
   - `<paseoHome>/connector/fleet-state.json`: live `Fleet pulse` snapshot written for both the `Fleet surface` UI and the `Connector bridge` consumed by `factory-burn-lab` / `paseo-factory`.
   - `<paseoHome>/connector/handoffs/<handoffId>.json`: records of outbound and inbound `Handoff` jobs and their staged `Fleet ref`s.
   - `<paseoHome>/connector/repos/<canonical-slug>/`: on-demand `Mirror repo` checkouts on peer `Node`s.
3. **Injectable Transport Seams for Deterministic Offline Testing:**
   - All network/SSH/Git operations (`PulseTransport`, `RemoteCommandRunner`, `GitBundleTransport`) accept injected runner callbacks in `src/fleet.ts`, `src/git-sync.ts`, and `src/dispatch.ts`, defaulting in production to Tailscale SSH (`ssh -o BatchMode=yes -o ConnectTimeout=5 ...`) and local `git bundle` commands.

## Testing Decisions

- **High-seam behavioral tests only (`test/*.test.ts`):**
  - Test `Fleet` registration, `Reserve mode`, `Health guard` filtering, `Slot ceiling` accounting, and `Fleet pulse` cadence/digest size through public functions in `src/fleet.ts`.
  - Test real `git bundle` creation, `Mirror repo` provisioning, `Fleet ref` (`refs/fleet/<nodeId>/<runId>`) staging without dirtying the working tree, `Land` checkout/merge, and `Gossip sync` timestamp reconciliation against real temporary Git repositories on disk in `src/git-sync.ts`.
  - Test `Handoff` ownership transfer (preferring `stationary` `Node`s and surviving initiator disconnect) and `Burst` parallel distribution + mid-attempt peer disconnect failover in `src/dispatch.ts`.
  - Test `Fleet surface` RPC handlers (`connector.snapshot`, `connector.node.upsert`, `connector.node.reserve`, `connector.pulse`, `connector.handoff`, `connector.burst`, `connector.gossip.sync`, `connector.ref.land`) in `test/surface-rpc.test.ts`.
- **Gate command:** `npm run sync:plugin-core && npm run typecheck && npm test`.

## Out of Scope

- Modifying `paseo-factory` (`../research-slp`) source files directly (any needed hooks are filed as `Upstream issue`s in `../research-slp/.scratch/burn-lab-upstream/issues/`).
- Native Windows (`cmd.exe` / PowerShell) execution outside WSL2 — the Windows `Node` runs inside WSL2 (Ubuntu) per `ADR 0001 §5`.
