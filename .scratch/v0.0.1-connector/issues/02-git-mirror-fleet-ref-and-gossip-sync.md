# 02: Git-native `Mirror repo`, `Fleet ref` staging, `Land`, and `Gossip sync`

**What to build:** Peer `Node`s can exchange code state using compact `git bundle` files (never SMB/NFS), automatically provision on-demand `Mirror repo` directories (`<paseoHome>/connector/repos/<canonical-slug>`) when receiving work for an uncloned `Project`, silently stage completed peer commits into `refs/fleet/<nodeId>/<runOrTaskId>` (`Fleet ref`) without touching the user's active working tree, land a `Fleet ref` on demand, and reconcile `free-pool.json` + completed `BurnRunRecord` reports via last-write-wins `Gossip sync`.

**Blocked by:** 01: Fleet registry, `Node posture`, `Health guard`, and low-bandwidth `Fleet pulse`

**Status:** ready-for-agent

- [ ] `createCommitBundle` and `ensureMirrorRepoFromBundle` package `<base>..HEAD` (plus `.worktreeinclude` files) from an initiating repository and unpack/update `<paseoHome>/connector/repos/<canonical-slug>` on a target `Node`.
- [ ] `stageFleetRefFromBundle` unpacks a peer `Node`'s completed commit bundle into `refs/fleet/<nodeId>/<runOrTaskId>` in the local Git repository while leaving the active working tree and index untouched.
- [ ] `landFleetRef` checks out or merges `refs/fleet/<nodeId>/<runOrTaskId>` into a local branch (`fleet/<nodeId>/<runOrTaskId>`) when explicitly invoked by the operator.
- [ ] `reconcileGossipSync` compares `freePoolUpdatedAt` and run timestamps from `Fleet pulse` digests and reconciles newer `free-pool.json` and completed `BurnRunRecord` / `report.md` artifacts across `Node`s.
- [ ] Behavioral unit tests in `test/git-sync.test.ts` pass against real temporary Git repositories on disk.
