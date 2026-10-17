# Installing `factory-connector` on a peer `Node`

Every machine in the `Fleet` runs the plugin from its own trial home `~/.paseo-factory` (never `~/.paseo` — that is the prod home, verified builds only; see `AGENTS.md`).

## From the GitHub release (preferred for peers)

```bash
paseo plugin install 'https://github.com/daymanondev/factory-connector.git:plugin' \
  --ref v0.0.1 \
  --home ~/.paseo-factory
```

The `:plugin` suffix is required: `paseo-plugin.json` lives in `plugin/`, not at the repo root. Without the suffix the daemon fails with `Plugin manifest is missing …/checkout/paseo-plugin.json`.

A fresh install registers with STATUS `disabled` until the daemon loads it:

```bash
paseo reload --home ~/.paseo-factory      # or: paseo restart --home ~/.paseo-factory
paseo plugin ls --home ~/.paseo-factory   # STATUS should read "running"
paseo plugin logs factory-connector --home ~/.paseo-factory
```

Upgrades: re-run the install command with a newer `--ref` (e.g. `v0.0.2`).

## Fallbacks

```bash
# --path is the legacy spelling of the same suffix
paseo plugin install https://github.com/daymanondev/factory-connector.git \
  --ref v0.0.1 --path plugin --home ~/.paseo-factory

# clone + directory source (mirrors the dev machine's registration)
git clone --branch v0.0.1 https://github.com/daymanondev/factory-connector.git ~/factory-connector
paseo plugin install ~/factory-connector/plugin --home ~/.paseo-factory
```

## Requirements

- Paseo 0.11.x (`paseo -v`) — the plugin manifest requires `>=0.11.0 <0.12.0`.
- No Node.js/npm on the peer: the daemon compiles the plugin from the repo's tracked files.
- Windows `Node`s: run everything inside WSL2 (Ubuntu) for POSIX parity (ADR 0001 §5).

After install: open `Fleet surface` in Paseo Desktop and register the peer `Node` (node editor + Tailscale auto-discovery), then `Fleet pulse` picks it up within 60s (5s while the surface is open).
