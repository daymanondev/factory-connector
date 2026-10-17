/**
 * factory-connector plugin server entry — the shell around the connector core.
 *
 * The plugin process owns the background `Fleet pulse` cadence (60s idle; the
 * UI's `connector.pulse` calls tighten it to 5s while the `Fleet surface` is
 * open) and keeps the `Connector bridge` fresh: at boot it writes
 * `<paseoHome>/connector/fleet-state.json` and generates the executable
 * `<paseoHome>/connector/bin/connector-dispatch` wrapper that `paseo-factory`
 * and `factory-burn-lab` shell out to (CONTEXT.md "Connector bridge"). Every
 * `connector.*` RPC handler runs in-process against the same core.
 *
 * The daemon forks the plugin process with `PASEO_HOME` inherited, so a daemon
 * started with `--home ~/.paseo-factory` keeps all connector state under the
 * trial home (AGENTS.md) — never the prod `~/.paseo`.
 */
import { homedir } from "node:os";
import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { ensureConnectorBridge } from "./server/core/dispatch.ts";
import {
  createSshPulseTransport,
  defaultLocalPulseSource,
  PULSE_INTERVAL_IDLE_MS,
  type LocalPulseSource,
} from "./server/core/fleet.ts";
import { createSshGossipTransport } from "./server/core/git-sync.ts";
import { createSurfaceHandlers, registerSurfaceRpc } from "./server/surface-rpc.ts";
import type { SurfaceDaemonApi } from "./server/surface-rpc.ts";

const PLUGIN_ID = "factory-connector";
const SHELL_VERSION = "0.0.1";

const log = (message: string) => console.log(`[${PLUGIN_ID}] ${message}`);

/** `~`-expansion so a manually set `PASEO_HOME=~/x` still resolves. */
function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return `${homeDir}/${value.slice(2)}`;
  return value;
}

/** The daemon home this plugin runs under: `PASEO_HOME` or `~/.paseo`. */
function resolvePaseoHome(env: NodeJS.ProcessEnv, homeDir: string): string {
  const raw = env.PASEO_HOME && env.PASEO_HOME.trim() !== "" ? env.PASEO_HOME : `${homeDir}/.paseo`;
  return expandHome(raw, homeDir);
}

export default function contribute(server: PluginServerContext) {
  const home = resolvePaseoHome(process.env, homedir());

  // The daemon API is captured from whichever lifecycle hook fires first (the
  // reference shell's precedent) — it feeds the local `Fleet pulse`'s active
  // `Agent` count. One variable, written idempotently; undefined until then.
  let daemonApi: SurfaceDaemonApi | undefined;
  const capturePaseo = (context: PluginHookContext): void => {
    if (daemonApi === undefined) {
      daemonApi = context.paseo as unknown as SurfaceDaemonApi;
      log("pulse: captured the daemon API — local agent counts are live");
    }
  };
  const offAgentCreated = server.on("agent.created", (_event, context) => capturePaseo(context));

  const localSource: LocalPulseSource = async () => {
    const sample = await defaultLocalPulseSource()();
    const api = daemonApi;
    if (api !== undefined) {
      try {
        const page = await api.agents.list({ filter: { includeArchived: false } });
        sample.activeAgents = page.entries.length;
      } catch {
        // The count is optional — the pulse renders without it.
      }
    }
    return sample;
  };

  const handlers = createSurfaceHandlers({
    paseoHome: home,
    transport: createSshPulseTransport(),
    localSource,
    gossipTransport: createSshGossipTransport(),
    daemon: () => daemonApi,
    onLog: log,
  });
  registerSurfaceRpc(server, handlers);

  // The Connector bridge: publish the snapshot and the connector-dispatch CLI
  // wrapper so sibling repos can consume the Fleet with zero code imports.
  // The daemon evaluates this bundle as CommonJS without `import.meta`, so the
  // CLI entry is resolved from the daemon's install records (config.json /
  // staged checkouts) inside ensureConnectorBridge.
  void ensureConnectorBridge({ paseoHome: home }).then(
    (bridge) =>
      log(
        bridge.dispatchPath === undefined
          ? `bridge: ${bridge.statePath} ready (dispatch wrapper skipped — no resolvable CLI entry)`
          : `bridge: ${bridge.statePath} + ${bridge.dispatchPath} ready`,
      ),
    (error) => log(`bridge: initial write failed: ${error instanceof Error ? error.message : String(error)}`),
  );

  // The idle `Fleet pulse` cadence — 60s in the background; the surface's own
  // calls tighten it while open. One poll is always cheap (sub-KB digests).
  const cadence = setInterval(() => {
    void handlers.pulse({ activeSurface: false }).catch((error: unknown) => {
      log(`pulse: background poll failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, PULSE_INTERVAL_IDLE_MS);

  log(`up v${SHELL_VERSION} — home ${home}, idle pulse every ${PULSE_INTERVAL_IDLE_MS / 1000}s`);

  return () => {
    clearInterval(cadence);
    offAgentCreated();
    log(`down v${SHELL_VERSION}`);
  };
}
