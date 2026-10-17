# ADR 0001 — Symmetric Peer Fleet, Handoff & Burst Mesh, and Digest-First Tailscale Transport

- **Status:** Accepted — 2026-10-17 (ratified by Andrew over a three-round `/grill-with-docs` session)
- **Context:** Andrew operates four machines connected over Tailscale: one primary MacBook (which moves around and may close its lid / disconnect at any time), two additional Macs, and one Windows machine. Running heavy `factory-burn-lab` swarms or multiple `paseo-factory` tasks on a single machine contends with foreground development resources, while manually checking four separate machines is tedious. However, a naive master–slave (`Hub–Spoke`) design anchored to the MacBook would stall or kill active runs across the entire setup whenever the laptop closes its lid. Furthermore, Paseo's plugin compiler forbids cross-plugin code imports, and continuous streaming of agent tokens or logs across Tailscale would waste bandwidth (especially when the laptop is on a mobile hotspot).

## Decision

1. **Separate Repository & Companion Paseo Plugin (`factory-connector`).**
   - `factory-connector` lives in its own repository (`/Users/andrewpham/Documents/code/self-project/factory-connector`), installs into Paseo (`~/.paseo-factory` and `~/.paseo`), and owns the isolated state directory `<paseoHome>/connector/`.
   - It exposes the **`Fleet surface`** inside Paseo Desktop for unified 4-machine visibility and control, and exposes the **`Connector bridge`** (`<paseoHome>/connector/fleet-state.json` + `<paseoHome>/connector/bin/connector-dispatch`) so `factory-burn-lab` and `paseo-factory` can consume multi-machine capacity with zero cross-repo code imports.

2. **Symmetric Peer `Fleet` Architecture (No Single Master / No "Hired Slaves").**
   - Every machine in the `Fleet` is an autonomous **`Node`** running the full Paseo daemon (`127.0.0.1:6767`), `paseo-factory`, `factory-burn-lab`, and `factory-connector` stack.
   - Each `Node` declares a **`Node posture`**: `stationary` (always-on desktop/workstation) or `mobile` (laptop that may disconnect at any time).
   - Two execution modes are supported:
     - **`Handoff` (Full Ownership Transfer):** Any `Node` (e.g., the `mobile` MacBook before closing its lid) can package a `Burn run` or `Task` (`git bundle` + `.worktreeinclude` + brief) and hand it off in 1–2 seconds to a target **`Host node`** (preferring `stationary` `Node`s). Once received, the target `Host node` coordinates the entire run autonomously (`Supervisor` framing → swarm/worktree execution → `Gate` → synthesis) even if the initiating laptop is offline.
     - **`Burst` (Cooperative Parallel Execution):** Whichever `Host node` is coordinating a run automatically distributes stateless probes (`Scout pool`, `OSS lab`, `Council`) and isolated worktree attempts (`Proto arena`, `Night shift`, `Self-evolve`) across online peer `Node`s that have free capacity below their **`Slot ceiling`**, pass their **`Health guard`** (CPU/RAM thresholds), and are not in **`Reserve mode`**. If a peer `Node` disconnects mid-attempt, the `Host node` transparently retries that attempt on surviving `Node`s.

3. **Digest-First, Event-Driven Tailscale Transport (Near-Zero Idle Bandwidth).**
   - Nodes connect over Tailscale SSH (`ssh://user@<tailscale-ip>?daemonPort=6767` via Paseo's native SSH loopback transport and batch SSH commands) or Tailscale IP WebSocket.
   - **No live token or log streaming:** Agents execute 100% locally on the `Node` hosting their process. Nodes never stream live LLM token chunks or raw `Gate` stdout over Tailscale.
   - **Low-frequency `Fleet pulse`:** In the background (when `Fleet surface` is closed), nodes exchange a ~500-byte JSON `Fleet pulse` digest at most once every 60 seconds (< 10 B/s). When the operator actively opens `Fleet surface`, polling steps up to 5–10 seconds (~1–3 KB per digest) and drops back to 60s as soon as the screen closes. Full timelines or gate logs are fetched strictly on-demand when clicked.
   - **Event-driven `Gossip sync`:** Each `Fleet pulse` carries `freePoolUpdatedAt` and `runsUpdatedAt` timestamps; `free-pool.json` (~4 KB) and completed run reports (`report.md`) are transferred only once when a newer timestamp is observed.

4. **Git-Native Workspace Synchronization (`Mirror repo` & `Fleet ref`, Never SMB/NFS).**
   - Shared network filesystems (SMB/NFS/SSHFS) are explicitly rejected due to `.git/index.lock` contention, slow `node_modules` I/O, and cross-OS native binary incompatibilities.
   - Instead, `factory-connector` uses canonical project slugs from the initiating repository and automatically provisions on-demand **`Mirror repo`** caches at `<paseoHome>/connector/repos/<canonical-slug>` on peer `Node`s (each maintaining its own OS-native `node_modules`).
   - Code state crosses Tailscale strictly as compact `git bundle` payloads (`<base>..<claimedCommit>`, typically 10–100 KB). When a peer `Node` completes a run, its winning commit is fetched silently into the initiating repository under **`Fleet ref`** (`refs/fleet/<nodeId>/<runOrTaskId>`), never mutating the user's active working tree until the user clicks **`Land`**.

5. **Windows Node Standardization via WSL2 (Ubuntu).**
   - The Windows machine in the 4-node `Fleet` runs its Paseo daemon, Node (nvm), `git`, `opencode`, `pi`, and `factory-connector` inside **WSL2 (Ubuntu)**, providing 100% POSIX parity (`#!/bin/sh` wrappers, `Git shim`, `symlinkSync`, `/tmp`, `process.kill(-pid)`, and POSIX `Gate` commands) with the three macOS `Node`s.
