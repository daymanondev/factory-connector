# factory-connector

Peer-to-peer multi-machine Tailscale mesh plugin (`factory-connector`) for [Paseo](https://paseo.sh), paired with [`paseo-factory`](../research-slp) and [`factory-burn-lab`](../factory-burn-lab). Connects autonomous `Node`s (3 Macs + 1 Windows WSL2) into a single observable `Fleet` with 1-click **`Handoff`** (full run ownership transfer so mobile laptops can disconnect safely), **`Burst`** (cooperative parallel execution across online nodes), and low-bandwidth **`Fleet pulse`** / **`Gossip sync`** + Git-native **`Mirror repo`** / **`Fleet ref`** synchronization.

## Relationship to `paseo-factory` and `factory-burn-lab`

- **Symmetric Peer `Fleet` (`<paseoHome>/connector/`):** Every `Node` runs its own Paseo daemon and can act as a self-sufficient `Host node` for `Burn run`s and `Task`s, or contribute free slots to peer `Node`s under `Slot ceiling`, `Health guard`, and `Reserve mode`.
- **Zero Code Coupling (`Connector bridge`):** `factory-connector` writes live fleet topology and capacity to `<paseoHome>/connector/fleet-state.json` and provides `<paseoHome>/connector/bin/connector-dispatch` so `factory-burn-lab` and `paseo-factory` can offload work without cross-repo imports.
- **Zero Contamination of `paseo-factory`:** All fleet registries (`fleet.json`), pulse snapshots (`fleet-state.json`), on-demand `Mirror repo` caches (`repos/<canonical-slug>`), and staged `git bundle` transfers live under `<paseoHome>/connector/`.

## Trial daemon

All paseo/factory/burn-lab/connector runtime work targets the trial home `~/.paseo-factory` (never the default `~/.paseo` — that is prod, where only verified builds are installed). `paseo` sits at `~/.local/bin/paseo`; node comes from nvm (`~/.nvm/versions/node/`, default v24). On the Windows `Node`, the entire runtime runs inside **WSL2 (Ubuntu)** for 100% POSIX parity.

Installing this plugin on a peer `Node`: `paseo plugin install '<git-url>:plugin' --ref <tag> --home ~/.paseo-factory` — the `:plugin` suffix is mandatory (the manifest lives in `plugin/`, not the repo root). Full runbook: `docs/install.md`.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature-slug>/` (not GitHub Issues). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), recorded as `Status:` lines in issue files. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` (symlinked as `GLOSSARY.md`) and `docs/adr/` at the repo root, created and maintained by `/domain-modeling`. See `docs/agents/domain.md`.
