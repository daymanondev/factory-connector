#!/usr/bin/env node
/**
 * `connector-dispatch` CLI entry — the executable half of the `Connector
 * bridge`. `ensureConnectorBridge` generates `<paseoHome>/connector/bin/
 * connector-dispatch` as a tiny `sh` wrapper that execs
 * `node <this file> --home <paseoHome> "$@"`, so `factory-burn-lab` and
 * `paseo-factory` can request `Handoff` / `Burst` and read `Fleet` capacity
 * with zero cross-repo code imports.
 *
 * Pure Node module (mirrored verbatim into `plugin/server/core/` by
 * `npm run sync:plugin-core`); runs under plain Node type stripping.
 */

import { readFileSync } from "node:fs";
import { createSshPulseTransport, pollFleetPulse, type FleetState } from "./fleet.ts";
import {
  AUTO_STATIONARY,
  createScpGitBundleTransport,
  createSshRemoteCommandRunner,
  dispatchHandoff,
  executeBurst,
  receiveHandoff,
  type BurstWorkUnit,
  type HandoffBrief,
} from "./dispatch.ts";

const USAGE = `usage: connector-dispatch --home <paseoHome> <command> [options]

commands:
  snapshot
      Poll the Fleet pulse and print the fleet-state.json snapshot as JSON.
  handoff --project <dir> --base <rev> --slug <slug> --run-id <id> --command <cmd>
           [--target <nodeId|auto-stationary>] [--kind burn-run|task]
           [--playbook <name>] [--prompt <text> | --prompt-file <path>]
      Transfer full run ownership to a Host node and print the handoff record.
  burst --units <json-array> | --units-file <path>
      Distribute parallel work units across eligible Nodes; print the report
      (exit 1 when any unit failed everywhere).
  receive-handoff --manifest <path>
      Target-side: provision the Mirror repo from the inbox manifest and spawn
      the detached run; prints the spawned pid.
`;

interface ParsedArgs {
  home: string | null;
  command: string | null;
  flags: Map<string, string>;
}

function parseArgv(argv: string[]): ParsedArgs {
  let home: string | null = null;
  let command: string | null = null;
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--home") {
      home = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(arg.slice(2), next);
        i += 1;
      } else {
        flags.set(arg.slice(2), "");
      }
    } else if (command === null) {
      command = arg;
    }
  }
  return { home, command, flags };
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value === "") {
    throw new Error(`missing required option --${name}\n\n${USAGE}`);
  }
  return value;
}

/** Fresh snapshot for dispatch decisions (production SSH pulse transport). */
async function pollSnapshot(home: string): Promise<FleetState> {
  return pollFleetPulse({ paseoHome: home, transport: createSshPulseTransport() });
}

async function main(argv: string[]): Promise<number> {
  const { home, command, flags } = parseArgv(argv);
  if (!home) {
    throw new Error(`missing required option --home\n\n${USAGE}`);
  }

  switch (command) {
    case "snapshot": {
      const state = await pollSnapshot(home);
      process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
      return 0;
    }

    case "handoff": {
      const state = await pollSnapshot(home);
      const prompt = flags.has("prompt")
        ? requireFlag(flags, "prompt")
        : flags.has("prompt-file")
          ? readFileSync(requireFlag(flags, "prompt-file"), "utf8")
          : null;
      const brief: HandoffBrief = {
        kind: (flags.get("kind") as HandoffBrief["kind"]) ?? "burn-run",
        runOrTaskId: requireFlag(flags, "run-id"),
        command: requireFlag(flags, "command"),
        playbook: flags.get("playbook") ?? null,
        prompt,
      };
      const record = await dispatchHandoff({
        paseoHome: home,
        projectPath: requireFlag(flags, "project"),
        base: requireFlag(flags, "base"),
        canonicalSlug: requireFlag(flags, "slug"),
        brief,
        state,
        targetNodeId: flags.get("target") ?? AUTO_STATIONARY,
        bundleTransport: createScpGitBundleTransport(),
        remoteRunner: createSshRemoteCommandRunner(),
      });
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
      return 0;
    }

    case "burst": {
      const state = await pollSnapshot(home);
      const raw = flags.has("units")
        ? requireFlag(flags, "units")
        : readFileSync(requireFlag(flags, "units-file"), "utf8");
      let units: BurstWorkUnit[];
      try {
        units = JSON.parse(raw) as BurstWorkUnit[];
      } catch (error) {
        throw new Error(`--units is not valid JSON: ${(error as Error).message}`);
      }
      if (!Array.isArray(units)) {
        throw new Error("--units must be a JSON array of { id, command } work units");
      }
      const report = await executeBurst({ paseoHome: home, state, units });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report.ok ? 0 : 1;
    }

    case "receive-handoff": {
      const record = await receiveHandoff({
        paseoHome: home,
        manifestPath: requireFlag(flags, "manifest"),
      });
      // Machine-readable ack for the initiating Node: the spawned pid.
      process.stdout.write(`${record.pid ?? ""}\n`);
      return 0;
    }

    default:
      throw new Error(`unknown or missing command ${JSON.stringify(command)}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`connector-dispatch: ${(error as Error).message}\n`);
    process.exitCode = 1;
  },
);
