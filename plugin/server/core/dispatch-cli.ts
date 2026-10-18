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
import { userInfo } from "node:os";
import {
  assertAdoptableNodeId,
  createSshPulseTransport,
  discoverTailscalePeers,
  execCommandRunner,
  loadFleetConfig,
  parseSshTarget,
  pollFleetPulse,
  removeNode,
  tailscalePeerToNodeInput,
  upsertNode,
  withTimeout,
  PULSE_FETCH_TIMEOUT_MS,
  type FleetNodeInput,
  type FleetState,
} from "./fleet.ts";
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
  node list
      Print the fleet.json registry (local anchor + registered peers).
  node upsert --id <id> --name <name> --posture <stationary|mobile>
              --ssh-target ssh://user@100.x.y.z [--remote-home <path>]
      Register or update a peer Node, then print the registry.
  node adopt --ip <tailscale-ip> --user <ssh-user> [--posture <stationary|mobile>]
             [--id <override>] [--name <override>] [--remote-home <path>]
      One-shot registration: discover the Tailscale peer by IP, register it,
      then immediately verify its pulse fetch (exit 1 with a hint on failure).
  node remove --id <id>
      Unregister a peer Node (the local Node cannot be removed).
  node check [--id <id>]
      Run the exact pulse-fetch SSH against the peer Node(s); exit 1 on failure.
  tailscale discover
      List Tailscale peers as registration candidates (id, name, ip, os, online).
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
  positionals: string[];
  flags: Map<string, string>;
}

function parseArgv(argv: string[]): ParsedArgs {
  let home: string | null = null;
  const positionals: string[] = [];
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
    } else {
      positionals.push(arg);
    }
  }
  return { home, positionals, flags };
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

interface NodeCheckResult {
  id: string;
  ok: boolean;
  detail: string;
}

/** Runs the exact pulse-fetch SSH against the registry's peer Node(s). */
async function checkNodes(home: string, onlyId?: string): Promise<NodeCheckResult[]> {
  const config = loadFleetConfig(home);
  const targets = config.nodes.filter(
    (node) => node.transport === "ssh" && (onlyId === undefined || node.id === onlyId),
  );
  if (onlyId !== undefined && targets.length === 0) {
    throw new Error(`no SSH Node with id ${JSON.stringify(onlyId)} in the Fleet registry`);
  }
  const transport = createSshPulseTransport();
  return Promise.all(
    targets.map(async (node) => {
      try {
        const pulse = await withTimeout(
          transport.fetchPulse(node),
          PULSE_FETCH_TIMEOUT_MS,
          `pulse fetch for ${node.id}`,
        );
        return {
          id: node.id,
          ok: true,
          detail: `online agents=${pulse.activeAgents} runs=${pulse.activeBurnRuns}`,
        };
      } catch (error) {
        return { id: node.id, ok: false, detail: (error as Error).message };
      }
    }),
  );
}

/** This machine's own Tailscale IP, for the adopt follow-up hint (null when unknown). */
async function localTailscaleIp(): Promise<string | null> {
  try {
    const { stdout } = await execCommandRunner.run("tailscale", ["status", "--json"]);
    const self = (JSON.parse(stdout) as { Self?: { TailscaleIPs?: string[] } }).Self;
    return self?.TailscaleIPs?.[0] ?? null;
  } catch {
    return null;
  }
}

async function main(argv: string[]): Promise<number> {
  const { home, positionals, flags } = parseArgv(argv);
  if (!home) {
    throw new Error(`missing required option --home\n\n${USAGE}`);
  }
  const command = positionals[0] ?? null;

  switch (command) {
    case "snapshot": {
      const state = await pollSnapshot(home);
      process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
      return 0;
    }

    case "node": {
      const sub = positionals[1];
      if (sub === "list") {
        process.stdout.write(`${JSON.stringify(loadFleetConfig(home), null, 2)}\n`);
        return 0;
      }
      if (sub === "upsert") {
        const sshTarget = requireFlag(flags, "ssh-target");
        parseSshTarget(sshTarget);
        const input: FleetNodeInput = {
          id: requireFlag(flags, "id"),
          name: requireFlag(flags, "name"),
          posture: (flags.get("posture") as FleetNodeInput["posture"]) ?? "mobile",
          transport: "ssh",
          sshTarget,
        };
        if (flags.has("remote-home")) input.remotePaseoHome = requireFlag(flags, "remote-home");
        upsertNode(home, input);
        process.stdout.write(`${JSON.stringify(loadFleetConfig(home), null, 2)}\n`);
        return 0;
      }
      if (sub === "adopt") {
        const ip = requireFlag(flags, "ip");
        const user = requireFlag(flags, "user");
        const peers = await discoverTailscalePeers();
        const peer = peers.find((candidate) => candidate.tailscaleIp === ip);
        if (!peer) {
          throw new Error(
            `no Tailscale peer with IP ${ip} — run 'connector-dispatch tailscale discover' to list candidates`,
          );
        }
        const input = tailscalePeerToNodeInput(peer, {
          user,
          posture: (flags.get("posture") as FleetNodeInput["posture"]) ?? undefined,
          id: flags.get("id") || undefined,
          name: flags.get("name") || undefined,
        });
        assertAdoptableNodeId(loadFleetConfig(home), input.id);
        if (flags.has("remote-home")) input.remotePaseoHome = requireFlag(flags, "remote-home");
        const updated = upsertNode(home, input);
        const registered = updated.nodes.find((node) => node.id === input.id);
        process.stdout.write(`${JSON.stringify(registered, null, 2)}\n`);
        const [check] = await checkNodes(home, input.id);
        process.stderr.write(`node check: ${check.id} ${check.ok ? "OK" : "FAIL"} — ${check.detail}\n`);
        const selfIp = await localTailscaleIp();
        if (!check.ok) {
          process.stderr.write(
            `hint: the pulse runs 'ssh -o BatchMode=yes ${user}@${ip} cat ${input.remotePaseoHome ?? "~/.paseo-factory"}/connector/fleet-state.json' — give this machine key auth on the peer (ssh-copy-id) and pre-accept its host key (ssh-keyscan)\n`,
          );
          if (selfIp !== null) {
            process.stderr.write(
              `also register this machine on the peer once reachable: connector-dispatch node adopt --ip ${selfIp} --user ${userInfo().username}\n`,
            );
          }
          return 1;
        }
        if (selfIp !== null) {
          process.stderr.write(
            `next: on the peer, register this machine back — connector-dispatch node adopt --ip ${selfIp} --user ${userInfo().username}\n`,
          );
        }
        return 0;
      }
      if (sub === "remove") {
        removeNode(home, requireFlag(flags, "id"));
        process.stdout.write(`${JSON.stringify(loadFleetConfig(home), null, 2)}\n`);
        return 0;
      }
      if (sub === "check") {
        const results = await checkNodes(home, flags.get("id") || undefined);
        for (const result of results) {
          process.stdout.write(`${result.id}: ${result.ok ? "OK" : "FAIL"} — ${result.detail}\n`);
        }
        return results.every((result) => result.ok) ? 0 : 1;
      }
      throw new Error(`unknown or missing 'node' subcommand ${JSON.stringify(sub)}\n\n${USAGE}`);
    }

    case "tailscale": {
      const sub = positionals[1];
      if (sub === "discover") {
        const peers = await discoverTailscalePeers();
        process.stdout.write(`${JSON.stringify(peers, null, 2)}\n`);
        process.stderr.write(
          `register one: connector-dispatch node adopt --ip <tailscaleIp> --user <ssh-user> [--posture stationary]\n`,
        );
        return 0;
      }
      throw new Error(`unknown or missing 'tailscale' subcommand ${JSON.stringify(sub)}\n\n${USAGE}`);
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
