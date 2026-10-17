# 01: Fleet registry, `Node posture`, `Health guard`, and low-bandwidth `Fleet pulse`

**What to build:** A `Node` can register itself and peer `Node`s (`stationary` or `mobile`) in `<paseoHome>/connector/fleet.json`, toggle `Reserve mode`, evaluate `Slot ceiling` and `Health guard` (CPU/RAM thresholds),discover Tailscale peers, and exchange sub-kilobyte `Fleet pulse` digests (updating `<paseoHome>/connector/fleet-state.json` for the `Connector bridge`).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `loadFleetConfig` / `saveFleetConfig` / `upsertNode` / `setNodeReserveMode` persist `<paseoHome>/connector/fleet.json` with a default local `Node` entry and support `posture: "stationary" | "mobile"`, `slotCeiling`, `reserveMode`, and `healthGuard` (`maxCpuPercent`, `minFreeMemMb`).
- [ ] `collectLocalPulse` and `pollFleetPulse` gather sub-kilobyte `Fleet pulse` digests across local and SSH peer `Node`s, writing `<paseoHome>/connector/fleet-state.json` and enforcing adaptive cadence (60s background vs 5–10s active UI).
- [ ] `selectEligibleNodes` filters and ranks candidate `Node`s for `Handoff` (preferring `stationary` `Node`s) and `Burst` (respecting `online`, `Reserve mode`, `Slot ceiling`, and `Health guard`).
- [ ] Behavioral unit tests in `test/fleet.test.ts` pass against real temp directories.
