# Installing `factory-connector` on a peer `Node`

Every machine in the `Fleet` runs the plugin from its own trial home `~/.paseo-factory` (never `~/.paseo` — that is the prod home, verified builds only; see `AGENTS.md`).

## From the GitHub release (preferred for peers)

```bash
paseo plugin install 'https://github.com/daymanondev/factory-connector.git:plugin' \
  --ref v0.0.2 \
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
  --ref v0.0.2 --path plugin --home ~/.paseo-factory

# clone + directory source (mirrors the dev machine's registration)
git clone --branch v0.0.2 https://github.com/daymanondev/factory-connector.git ~/factory-connector
paseo plugin install ~/factory-connector/plugin --home ~/.paseo-factory
```

## Requirements

- Paseo 0.11.x (`paseo -v`) — the plugin manifest requires `>=0.11.0 <0.12.0`.
- No Node.js/npm on the peer: the daemon compiles the plugin from the repo's tracked files.
- Windows `Node`s: run everything inside WSL2 (Ubuntu) for POSIX parity (ADR 0001 §5).

After install, register the peer `Node` from either side — the prerequisite both ways is key-based SSH (the pulse runs `ssh -o BatchMode=yes user@host`, so `ssh-copy-id` + `ssh-keyscan` once per direction):

- CLI (scriptable, no Desktop needed): `<paseoHome>/connector/bin/connector-dispatch node adopt --ip <tailscale-ip> --user <ssh-user> [--posture stationary] [--id <override>]` — discovers the peer over Tailscale, registers it, and immediately verifies the pulse fetch (exit 1 with a hint when SSH auth is missing). Use `--id` when both machines share a hostname.
- Paseo Desktop `Fleet surface`: node editor + Tailscale auto-discovery.

Then `Fleet pulse` picks the peer up within 60s (5s while the surface is open).
