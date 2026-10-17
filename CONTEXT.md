# factory-connector

A peer-to-peer multi-machine mesh plugin for Paseo that connects autonomous factory nodes over Tailscale into a single observable fleet, enabling cross-machine workload handoff, cooperative parallel execution, and low-bandwidth git-native state synchronization for `paseo-factory` and `factory-burn-lab`.

## Language

### Fleet and nodes

**Fleet**:
The set of all registered machines connected over Tailscale (`<paseoHome>/connector/fleet.json`) that share visibility, health telemetry, and workload capacity through `factory-connector`.
_Avoid_: cluster, pool, server farm, grid

**Node**:
One autonomous machine (macOS or Windows WSL2) in the `Fleet` running its own Paseo daemon, `paseo-factory`, `factory-burn-lab`, and `factory-connector` stack, capable of both hosting full runs independently and executing delegated work units from peer `Node`s.
_Avoid_: worker (that names a `Lane` in `paseo-factory`), master, slave, hub, spoke, minion, host

**Node posture**:
The physical availability classification of a `Node` — either `stationary` (always-on desktop/workstation safe to host long-running unattended work) or `mobile` (laptop that may close its lid or disconnect at any time).
_Avoid_: device type, form factor, role

**Host node**:
The `Node` that owns and coordinates the lifecycle of a specific `Burn run` or `Task` from start to finish, whether started locally on that `Node` or received via a `Handoff`.
_Avoid_: master node, hub, primary server, leader

### Execution and delegation

**Handoff**:
Transferring full ownership of a `Burn run` or `Task` (along with its `git bundle` and `.worktreeinclude` payload) from the initiating `Node` to a target `Host node` (typically a `stationary` `Node`) so the initiating `Node` can disconnect immediately while the target `Host node` runs the job to completion.
_Avoid_: remote job, push, migration, offload

**Burst**:
Cooperative parallel execution in which a `Host node` distributes individual stateless probes or isolated worktree attempts of an active run across available online peer `Node`s in the `Fleet`, automatically retrying locally or on surviving `Node`s if a peer disconnects mid-attempt.
_Avoid_: scatter-gather, map-reduce, swarm split, worker pool

**Connector bridge**:
The local file and CLI contract (`<paseoHome>/connector/fleet-state.json` and `<paseoHome>/connector/bin/connector-dispatch`) through which `factory-burn-lab` and `paseo-factory` discover online `Node`s and request `Handoff` or `Burst` execution without cross-repo code imports.
_Avoid_: plugin SDK, shared library, IPC bus

### Capacity and scheduling

**Slot ceiling**:
The maximum number of concurrent `Burst` or `Handoff` work units a `Node` allows at one time, configured per `Node` to bound resource consumption.
_Avoid_: thread count, max workers, concurrency limit

**Health guard**:
The real-time CPU load and available memory threshold on a `Node` above which the `Node` refuses new delegated work units until pressure subsides.
_Avoid_: circuit breaker, rate limiter, throttle

**Reserve mode**:
The operator-controlled state on a `Node` that stops it from accepting background delegated work from the `Fleet` so its local CPU and memory remain dedicated to the human's active foreground work.
_Avoid_: drain mode, maintenance mode, offline mode

### Telemetry, git, and synchronization

**Fleet surface**:
The `factory-connector` UI screen inside Paseo Desktop that displays all `Node`s in the `Fleet` on one unified view (online status, `Node posture`, CPU/memory, active Paseo `Agent`s, active `Burn run`s, `Meter` totals, `Reserve mode` toggles, `Handoff` dispatch, and 1-click `Fleet ref` landing) without switching Paseo's per-host picker.
_Avoid_: dashboard, cluster portal, node manager

**Fleet pulse**:
The sub-kilobyte periodic digest exchanged between `Node`s over Tailscale (`online`, CPU/RAM, active agent/run counts, `freePoolUpdatedAt` timestamp) at a low background cadence (60s idle, 5–10s while the `Fleet surface` is open), never streaming live token output or raw logs unless requested on demand.
_Avoid_: heartbeat stream, live feed, telemetry firehose

**Mirror repo**:
The automatically provisioned Git repository under `<paseoHome>/connector/repos/<canonical-slug>` on a peer `Node` (with its own OS-native `node_modules` cache) created on demand from a `git bundle` whenever a `Node` receives a `Handoff` or `Burst` for a `Project` it has not yet cloned locally.
_Avoid_: shadow clone, remote workspace, shared folder

**Fleet ref**:
The namespaced Git reference (`refs/fleet/<nodeId>/<runOrTaskId>`) fetched silently into a `Node`'s local repository when a peer `Node` completes a run or attempt, staging the verified commits locally without touching the user's active working tree until explicitly landed.
_Avoid_: remote branch, shadow branch, staging branch

**Gossip sync**:
The automatic peer-to-peer reconciliation over Tailscale using last-write-wins timestamps in each `Fleet pulse` that propagates shared fleet artifacts (`free-pool.json` model rankings, `fleet.json` node registry, and completed run reports/summaries) across all reachable `Node`s.
_Avoid_: replication, broadcast, master sync
