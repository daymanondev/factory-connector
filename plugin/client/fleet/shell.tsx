/**
 * The one `<FleetShell />` every `Fleet surface` entry renders: the global
 * screen and the workspace panel — one component, two hosts. It owns the
 * `Fleet pulse` poll (10s while mounted, ADR 0001 §3) and every RPC action
 * (`Reserve mode` toggles, `Node` registration/removal, the 1-click `Handoff`
 * launcher, `Gossip sync`, `Fleet ref` `Land`). Function components only — no
 * class syntax reaches the Hermes bundle.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsInput, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  gossipSync,
  handoff,
  logRead,
  nodeRemove,
  nodeReserve,
  nodeUpsert,
  pulse,
  refLand,
  tailscaleDiscover,
} from "../../shared/rpc.ts";
import type {
  FleetNodeView,
  FleetView,
  HandoffLogView,
  HandoffRecordView,
} from "../../shared/view.ts";
import { Btn, Card, Pill } from "../kit/pill.tsx";
import { FLEET_ACTIVE_MS, usePoll } from "../kit/poll.ts";
import { SPACING, text } from "../kit/theme.ts";

/** The navigation slice the shell uses — `openAgent` jumps to a session. */
export interface Navigation {
  openAgent(input: { agentId: string; serverId?: string }): void;
}

const postures = [
  { label: "Stationary", value: "stationary" },
  { label: "Mobile", value: "mobile" },
] as const;

const transports = [
  { label: "Tailscale SSH", value: "ssh" },
  { label: "Local", value: "local" },
] as const;

const handoffKinds = [
  { label: "Burn run", value: "burn-run" },
  { label: "Task", value: "task" },
] as const;

const landModes = [
  { label: "Checkout fleet branch", value: "checkout" },
  { label: "Merge into current branch", value: "merge" },
] as const;

/** The Node editor's draft — every field a string; parsed on save. */
interface NodeDraft {
  id: string;
  name: string;
  posture: "stationary" | "mobile";
  transport: "local" | "ssh";
  sshTarget: string;
  remotePaseoHome: string;
  slotCeiling: string;
  maxCpuPercent: string;
  minFreeMemMb: string;
}

/** The Handoff launcher's draft. */
interface HandoffDraft {
  projectPath: string;
  base: string;
  canonicalSlug: string;
  runOrTaskId: string;
  kind: "burn-run" | "task";
  command: string;
  playbook: string;
  prompt: string;
  targetNodeId: string;
}

function emptyNodeDraft(): NodeDraft {
  return {
    id: "",
    name: "",
    posture: "stationary",
    transport: "ssh",
    sshTarget: "",
    remotePaseoHome: "~/.paseo-factory",
    slotCeiling: "2",
    maxCpuPercent: "85",
    minFreeMemMb: "2048",
  };
}

function draftOf(node: FleetNodeView): NodeDraft {
  return {
    id: node.id,
    name: node.name,
    posture: node.posture,
    transport: node.transport,
    sshTarget: node.sshTarget ?? "",
    // Seed from the registry's stored remote home so saving an untouched
    // editor keeps a custom remotePaseoHome instead of resetting it.
    remotePaseoHome: node.remotePaseoHome ?? "~/.paseo-factory",
    slotCeiling: String(node.slotCeiling),
    maxCpuPercent: String(node.healthGuard.maxCpuPercent),
    minFreeMemMb: String(node.healthGuard.minFreeMemMb),
  };
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "project";
}

export function FleetShell({
  theme,
  dir,
  navigation,
  serverId,
}: {
  theme: PluginTheme;
  /** The workspace panel's directory scope; undefined on the global screen. */
  dir?: string;
  navigation?: Navigation;
  serverId?: string;
}) {
  const toast = useToast();
  const pulseCall = useRpc(pulse);
  const upsertCall = useRpc(nodeUpsert);
  const removeCall = useRpc(nodeRemove);
  const reserveCall = useRpc(nodeReserve);
  const handoffCall = useRpc(handoff);
  const gossipCall = useRpc(gossipSync);
  const landCall = useRpc(refLand);
  const discoverCall = useRpc(tailscaleDiscover);
  const logCall = useRpc(logRead);

  const [bump, setBump] = useState(0);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<NodeDraft | null>(null);
  const [peers, setPeers] = useState<{ id: string; name: string; tailscaleIp: string; online: boolean; os: string }[] | null>(null);
  const [handoffForm, setHandoffForm] = useState<HandoffDraft | null>(null);
  const [landTarget, setLandTarget] = useState<{ nodeId: string; runOrTaskId: string; repoPath: string; mode: "checkout" | "merge" } | null>(null);
  const [logView, setLogView] = useState<{ record: HandoffRecordView; log: HandoffLogView } | null>(null);
  const refresh = () => setBump((n) => n + 1);

  const poll = usePoll(
    async () => {
      const r = await pulseCall({ activeSurface: true });
      if (!r.ok) return { ok: false as const, code: r.code, error: r.error };
      return { ok: true as const, value: r.view };
    },
    `fleet:${bump}`,
    () => FLEET_ACTIVE_MS,
  );
  const view = poll.value;

  const act = async (name: string, run: () => Promise<{ ok: boolean; error?: string | null }>): Promise<boolean> => {
    setBusy(true);
    try {
      const reply = await run();
      if (!reply.ok) {
        toast.error(`${name}: ${reply.error ?? "failed"}`);
        return false;
      }
      return true;
    } catch (error) {
      toast.error(`${name}: ${String(error)}`);
      return false;
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (view === null) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0, padding: SPACING[4], gap: SPACING[2] }}>
        <Text style={text(theme, "section")}>Fleet Connector</Text>
        {poll.error !== null ? (
          <Text style={text(theme, "label", "statusWarning")}>{poll.error.message}</Text>
        ) : (
          <Text style={text(theme, "meta")}>Taking the Fleet pulse…</Text>
        )}
      </View>
    );
  }

  const toggleReserve = (node: FleetNodeView): void => {
    void act("Reserve mode", () => reserveCall({ nodeId: node.id, reserveMode: !node.reserveMode }));
  };

  const saveNode = (): void => {
    if (draft === null) return;
    const slotCeiling = Number.parseInt(draft.slotCeiling, 10);
    const maxCpuPercent = Number.parseInt(draft.maxCpuPercent, 10);
    const minFreeMemMb = Number.parseInt(draft.minFreeMemMb, 10);
    if (draft.id.trim() === "" || draft.name.trim() === "") {
      toast.error("Node: id and name are required");
      return;
    }
    if (!Number.isInteger(slotCeiling) || slotCeiling < 1) {
      toast.error("Node: slot ceiling must be a positive integer");
      return;
    }
    void act("Node", async () => {
      const reply = await upsertCall({
        id: draft.id.trim(),
        name: draft.name.trim(),
        posture: draft.posture,
        transport: draft.transport,
        ...(draft.sshTarget.trim() === "" ? {} : { sshTarget: draft.sshTarget.trim() }),
        remotePaseoHome: draft.remotePaseoHome.trim() === "" ? undefined : draft.remotePaseoHome.trim(),
        slotCeiling,
        healthGuard: { maxCpuPercent, minFreeMemMb },
      });
      return reply;
    });
    setDraft(null);
  };

  const discover = (): void => {
    void act("Tailscale", async () => {
      const reply = await discoverCall({});
      if (reply.ok) setPeers(reply.peers);
      return reply;
    });
  };

  const launchHandoff = (): void => {
    if (handoffForm === null) return;
    const form = handoffForm;
    if (form.projectPath.trim() === "" || form.command.trim() === "" || form.runOrTaskId.trim() === "") {
      toast.error("Handoff: project, run id, and command are required");
      return;
    }
    void act("Handoff", async () => {
      const reply = await handoffCall({
        projectPath: form.projectPath.trim(),
        base: form.base.trim() === "" ? "HEAD~1" : form.base.trim(),
        canonicalSlug: form.canonicalSlug.trim() === "" ? slugify(form.projectPath.split("/").pop() ?? "project") : form.canonicalSlug.trim(),
        kind: form.kind,
        runOrTaskId: form.runOrTaskId.trim(),
        command: form.command,
        ...(form.playbook.trim() === "" ? {} : { playbook: form.playbook.trim() }),
        ...(form.prompt.trim() === "" ? {} : { prompt: form.prompt.trim() }),
        ...(form.targetNodeId === "auto-stationary" ? {} : { targetNodeId: form.targetNodeId }),
      });
      return reply;
    });
    setHandoffForm(null);
  };

  const land = (): void => {
    if (landTarget === null) return;
    const target = landTarget;
    if (target.repoPath.trim() === "") {
      toast.error("Land: the repository path is required");
      return;
    }
    void act("Land", () => landCall({ repoPath: target.repoPath.trim(), nodeId: target.nodeId, runOrTaskId: target.runOrTaskId, mode: target.mode }));
    setLandTarget(null);
  };

  const gossipNow = (): void => {
    void act("Gossip sync", async () => {
      const reply = await gossipCall({});
      if (reply.ok) {
        toast.show(
          `pulled ${reply.report.freePool.length} free-pool update(s), ${reply.report.runs.length} run record(s)`,
          { variant: "info" },
        );
      }
      return reply;
    });
  };

  /** On-demand log/report inspection (spec.md §Solution 4) — capped digest-first server-side. */
  const viewLog = (record: HandoffRecordView): void => {
    void act("Log", async () => {
      const reply = await logCall({ handoffId: record.handoffId });
      if (reply.ok) setLogView({ record, log: reply.log });
      return reply;
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: SPACING[4], paddingBottom: SPACING[6], gap: SPACING[4] }}>
        <Card theme={theme} gap={SPACING[2]}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2], flexWrap: "wrap" }}>
            <Text style={text(theme, "detailTitle")}>Fleet Connector</Text>
            <Pill theme={theme} label={`${view.nodes.filter((node) => node.online).length}/${view.nodes.length} online`} tone="accent" lit />
            <Pill theme={theme} label={`local: ${view.localNodeId}`} mono />
          </View>
          <Text style={text(theme, "meta")}>pulse {view.generatedAt}</Text>
          <View style={{ flexDirection: "row", gap: SPACING[2], flexWrap: "wrap" }}>
            <Btn theme={theme} label="Handoff Run" icon="Rocket" disabled={busy} solid onPress={() => setHandoffForm({
              projectPath: dir ?? "",
              base: "HEAD~1",
              canonicalSlug: dir === undefined ? "" : slugify(dir.split("/").filter((part) => part !== "").pop() ?? "project"),
              runOrTaskId: `run-${Date.now().toString(36)}`,
              kind: "burn-run",
              command: "",
              playbook: "",
              prompt: "",
              targetNodeId: "auto-stationary",
            })} />
            <Btn theme={theme} label="Gossip Sync Now" icon="RefreshCw" disabled={busy} onPress={gossipNow} />
            <Btn theme={theme} label="Register Node" icon="Plus" disabled={busy} onPress={() => { setPeers(null); setDraft(emptyNodeDraft()); }} />
          </View>
          {poll.error !== null ? <Text style={text(theme, "label", "statusWarning")}>{poll.error.message}</Text> : null}
        </Card>

        {view.nodes.map((node) => (
          <NodeCard
            key={node.id}
            theme={theme}
            node={node}
            busy={busy}
            onToggleReserve={() => toggleReserve(node)}
            onEdit={() => { setPeers(null); setDraft(draftOf(node)); }}
            onRemove={() => {
              void act("Remove Node", () => removeCall({ nodeId: node.id }));
            }}
          />
        ))}

        <Card theme={theme} gap={SPACING[2]}>
          <Text style={text(theme, "section")}>Synced Fleet Runs &amp; Fleet Refs</Text>
          {view.handoffs.length === 0 ? (
            <Text style={text(theme, "meta")}>No Handoff records on this Node yet.</Text>
          ) : (
            view.handoffs.map((record) => (
              <HandoffRow
                key={record.handoffId}
                theme={theme}
                record={record}
                busy={busy}
                dir={dir}
                onLand={() =>
                  setLandTarget({ nodeId: record.targetNodeId, runOrTaskId: record.runOrTaskId, repoPath: dir ?? "", mode: "checkout" })
                }
                onViewLog={() => viewLog(record)}
              />
            )
          ))}
        </Card>
      </ScrollView>

      {draft !== null ? (
        <NodeEditor
          theme={theme}
          draft={draft}
          peers={peers}
          busy={busy}
          onChange={(next) => setDraft(next)}
          onDiscover={discover}
          onSave={saveNode}
          onClose={() => setDraft(null)}
        />
      ) : null}

      {handoffForm !== null ? (
        <HandoffLauncher
          theme={theme}
          form={handoffForm}
          nodes={view.nodes.filter((node) => !node.local)}
          busy={busy}
          onChange={(next) => setHandoffForm(next)}
          onLaunch={launchHandoff}
          onClose={() => setHandoffForm(null)}
        />
      ) : null}

      {landTarget !== null ? (
        <LandDialog
          theme={theme}
          target={landTarget}
          busy={busy}
          onChange={(next) => setLandTarget(next)}
          onLand={land}
          onClose={() => setLandTarget(null)}
        />
      ) : null}

      {logView !== null ? (
        <LogDialog
          theme={theme}
          record={logView.record}
          log={logView.log}
          onClose={() => setLogView(null)}
        />
      ) : null}
    </View>
  );
}

/** One `Node` card of the `Fleet` matrix. */
function NodeCard({
  theme,
  node,
  busy,
  onToggleReserve,
  onEdit,
  onRemove,
}: {
  theme: PluginTheme;
  node: FleetNodeView;
  busy: boolean;
  onToggleReserve: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <Card theme={theme} gap={SPACING[2]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2], flexWrap: "wrap" }}>
        <Text style={text(theme, "rowTitle")}>{node.name}</Text>
        {node.local ? <Pill theme={theme} label="this Node" tone="accent" lit /> : null}
        <Pill theme={theme} label={node.posture} icon={node.posture === "stationary" ? "Monitor" : "Laptop"} />
        <Pill theme={theme} label={node.online ? "online" : "offline"} tone={node.online ? "statusSuccess" : "statusDanger"} lit={node.online} icon={node.online ? "Wifi" : "WifiOff"} />
        {node.reserveMode ? <Pill theme={theme} label="Reserve mode" tone="statusWarning" lit icon="Pause" /> : null}
      </View>
      <View style={{ flexDirection: "row", gap: SPACING[4], flexWrap: "wrap" }}>
        <Text style={text(theme, "meta")}>slots {Math.max(node.slotsInUse, node.activeBurnRuns)}/{node.slotCeiling}</Text>
        <Text style={text(theme, "meta")}>agents {node.activeAgents} · runs {node.activeBurnRuns}</Text>
      </View>
      {node.meterSummary !== null ? (
        <Text style={text(theme, "meta")} numberOfLines={2}>
          meters{" "}
          {Object.entries(node.meterSummary)
            .map(([key, value]) => `${key} ${typeof value === "number" ? Math.round(value * 100) / 100 : value}`)
            .join(" · ")}
        </Text>
      ) : null}
      {node.lastError !== null ? <Text style={text(theme, "label", "statusWarning")} numberOfLines={2}>{node.lastError}</Text> : null}
      <View style={{ flexDirection: "row", gap: SPACING[2], flexWrap: "wrap" }}>
        <Btn
          theme={theme}
          small
          label={node.reserveMode ? "Release (accept work)" : "Reserve (pause work)"}
          icon={node.reserveMode ? "Play" : "Pause"}
          tone={node.reserveMode ? "statusSuccess" : "statusWarning"}
          disabled={busy}
          onPress={onToggleReserve}
        />
        <Btn theme={theme} small label="Edit" icon="Pencil" disabled={busy} onPress={onEdit} />
        {node.local ? null : (
          <Btn theme={theme} small label="Remove" icon="Trash2" tone="statusDanger" disabled={busy} onPress={onRemove} />
        )}
      </View>
    </Card>
  );
}

/** One row of the `Synced Fleet Runs & Fleet Refs` list. */
function HandoffRow({
  theme,
  record,
  busy,
  dir,
  onLand,
  onViewLog,
}: {
  theme: PluginTheme;
  record: HandoffRecordView;
  busy: boolean;
  dir?: string;
  onLand: () => void;
  onViewLog: () => void;
}) {
  const tone =
    record.status === "failed" ? "statusDanger" : record.status === "completed" ? "statusSuccess" : record.status === "running" ? "accent" : "foregroundMuted";
  return (
    <Card theme={theme} gap={SPACING[1.5]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2], flexWrap: "wrap" }}>
        <Text style={text(theme, "rowTitle")}>{record.runOrTaskId}</Text>
        <Pill theme={theme} label={record.status} tone={tone} lit={record.status !== "dispatched"} />
        <Pill theme={theme} label={record.direction} />
        <Pill theme={theme} label={`${record.sourceNodeId} → ${record.targetNodeId}`} mono />
      </View>
      <Text style={text(theme, "code")} numberOfLines={1}>{record.expectedFleetRef}</Text>
      {record.playbook !== null ? <Text style={text(theme, "meta")}>playbook {record.playbook}</Text> : null}
      {record.error !== null ? <Text style={text(theme, "label", "statusWarning")} numberOfLines={2}>{record.error}</Text> : null}
      <View style={{ flexDirection: "row", gap: SPACING[2], flexWrap: "wrap" }}>
        <Btn theme={theme} small label="Land Branch" icon="GitBranch" disabled={busy} onPress={onLand} />
        <Btn theme={theme} small label="View Log" icon="FileText" disabled={busy} onPress={onViewLog} />
        {dir !== undefined ? <Text style={text(theme, "meta")}>lands into {dir}</Text> : null}
      </View>
    </Card>
  );
}

/** The on-demand log/report viewer modal (spec.md §Solution 4). */
function LogDialog({
  theme,
  record,
  log,
  onClose,
}: {
  theme: PluginTheme;
  record: HandoffRecordView;
  log: HandoffLogView;
  onClose: () => void;
}) {
  return (
    <Modal title={`Log ${record.runOrTaskId}`} icon="FileText" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        {log.logTail !== null ? (
          <>
            <Text style={text(theme, "meta")}>{log.logPath}</Text>
            <ScrollView style={{ maxHeight: 320 }} nestedScrollEnabled>
              <Text style={text(theme, "code")}>{log.logTail}</Text>
            </ScrollView>
          </>
        ) : (
          <Text style={text(theme, "meta")}>No log on this Node (the run executes on its Host node{log.logPath === null ? "" : `, expected at ${log.logPath}`}).</Text>
        )}
        {log.report !== null ? (
          <>
            <Text style={text(theme, "section")}>Gossip-synced report</Text>
            <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>
              <Text style={text(theme, "code")}>{log.report}</Text>
            </ScrollView>
          </>
        ) : (
          <Text style={text(theme, "meta")}>No synced report.md for this run yet.</Text>
        )}
        <View style={{ flexDirection: "row", gap: SPACING[2], paddingTop: SPACING[2] }}>
          <Btn theme={theme} label="Close" tone="foregroundMuted" onPress={onClose} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** The `Node` registration/editor modal, with the Tailscale discovery helper. */
function NodeEditor({
  theme,
  draft,
  peers,
  busy,
  onChange,
  onDiscover,
  onSave,
  onClose,
}: {
  theme: PluginTheme;
  draft: NodeDraft;
  peers: { id: string; name: string; tailscaleIp: string; online: boolean; os: string }[] | null;
  busy: boolean;
  onChange: (next: NodeDraft) => void;
  onDiscover: () => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const field = (patch: Partial<NodeDraft>) => onChange({ ...draft, ...patch });
  return (
    <Modal title={draft.id === "" ? "Register Node" : `Edit Node ${draft.id}`} icon="Network" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <SettingsInput label="Node id" initialValue={draft.id} onChangeText={(id) => field({ id })} placeholder="studio-a" />
        <SettingsInput label="Name" initialValue={draft.name} onChangeText={(name) => field({ name })} placeholder="Studio A" />
        <SettingsSelect label="Posture" value={draft.posture} options={postures} onValueChange={(posture) => field({ posture })} />
        <SettingsSelect label="Transport" value={draft.transport} options={transports} onValueChange={(transport) => field({ transport })} />
        {draft.transport === "ssh" ? (
          <>
            <SettingsInput
              label="Tailscale SSH target"
              initialValue={draft.sshTarget}
              onChangeText={(sshTarget) => field({ sshTarget })}
              placeholder="ssh://user@100.x.y.z?daemonPort=6767"
            />
            <SettingsInput label="Remote paseo home" initialValue={draft.remotePaseoHome} onChangeText={(remotePaseoHome) => field({ remotePaseoHome })} placeholder="~/.paseo-factory" />
          </>
        ) : null}
        <SettingsInput label="Slot ceiling" initialValue={draft.slotCeiling} onChangeText={(slotCeiling) => field({ slotCeiling })} placeholder="2" />
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2], flexWrap: "wrap", paddingTop: SPACING[2] }}>
          <Btn theme={theme} small label="Discover Tailscale peers" icon="Search" disabled={busy} onPress={onDiscover} />
          {peers !== null ? <Text style={text(theme, "meta")}>{peers.length} peer(s) found</Text> : null}
        </View>
        {peers !== null
          ? peers.map((peer) => (
              <Btn
                key={peer.id}
                theme={theme}
                small
                tone={peer.online ? "accent" : "foregroundMuted"}
                label={`${peer.name} · ${peer.tailscaleIp}${peer.online ? "" : " (offline)"}`}
                onPress={() =>
                  field({
                    id: peer.id,
                    name: peer.name,
                    transport: "ssh",
                    // No user in the prefill: SSH then uses the local default,
                    // and the operator edits in the right user per peer (e.g.
                    // the Windows WSL2 Node) instead of inheriting one baked in.
                    sshTarget: `ssh://${peer.tailscaleIp}?daemonPort=6767`,
                  })
                }
              />
            ))
          : null}
        <View style={{ flexDirection: "row", gap: SPACING[2], paddingTop: SPACING[2] }}>
          <Btn theme={theme} label="Save Node" icon="Check" solid disabled={busy} onPress={onSave} />
          <Btn theme={theme} label="Cancel" tone="foregroundMuted" disabled={busy} onPress={onClose} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** The 1-click `Handoff` launcher modal. */
function HandoffLauncher({
  theme,
  form,
  nodes,
  busy,
  onChange,
  onLaunch,
  onClose,
}: {
  theme: PluginTheme;
  form: HandoffDraft;
  nodes: FleetNodeView[];
  busy: boolean;
  onChange: (next: HandoffDraft) => void;
  onLaunch: () => void;
  onClose: () => void;
}) {
  const field = (patch: Partial<HandoffDraft>) => onChange({ ...form, ...patch });
  return (
    <Modal title="Handoff Run" icon="Rocket" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <SettingsInput label="Project path" initialValue={form.projectPath} onChangeText={(projectPath) => field({ projectPath })} placeholder="/path/to/project" />
        <SettingsInput label="Base (exclusive start of the bundle range)" initialValue={form.base} onChangeText={(base) => field({ base })} placeholder="HEAD~1" />
        <SettingsInput label="Canonical slug (names the Mirror repo)" initialValue={form.canonicalSlug} onChangeText={(canonicalSlug) => field({ canonicalSlug })} placeholder="my-proj" />
        <SettingsSelect label="Kind" value={form.kind} options={handoffKinds} onValueChange={(kind) => field({ kind })} />
        <SettingsInput label="Run / task id" initialValue={form.runOrTaskId} onChangeText={(runOrTaskId) => field({ runOrTaskId })} placeholder="run-42" />
        <SettingsInput
          label="Command (the detached run on the Host node)"
          initialValue={form.command}
          onChangeText={(command) => field({ command })}
          placeholder="npx burn run --playbook probe"
        />
        <SettingsInput label="Playbook (optional)" initialValue={form.playbook} onChangeText={(playbook) => field({ playbook })} placeholder="probe" />
        <SettingsInput label="Prompt (optional)" initialValue={form.prompt} onChangeText={(prompt) => field({ prompt })} placeholder="find the best model" />
        <SettingsSelect
          label="Target Node"
          value={form.targetNodeId}
          options={[
            { label: "Auto Stationary Node", value: "auto-stationary" },
            ...nodes.map((node) => ({ label: `${node.name}${node.online ? "" : " (offline)"}`, value: node.id })),
          ]}
          onValueChange={(targetNodeId) => field({ targetNodeId })}
        />
        <View style={{ flexDirection: "row", gap: SPACING[2], paddingTop: SPACING[2] }}>
          <Btn theme={theme} label="Transfer ownership" icon="Rocket" solid disabled={busy} onPress={onLaunch} />
          <Btn theme={theme} label="Cancel" tone="foregroundMuted" disabled={busy} onPress={onClose} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** The `Land Branch` modal — applies a staged `Fleet ref` on explicit request. */
function LandDialog({
  theme,
  target,
  busy,
  onChange,
  onLand,
  onClose,
}: {
  theme: PluginTheme;
  target: { nodeId: string; runOrTaskId: string; repoPath: string; mode: "checkout" | "merge" };
  busy: boolean;
  onChange: (next: { nodeId: string; runOrTaskId: string; repoPath: string; mode: "checkout" | "merge" }) => void;
  onLand: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={`Land ${target.nodeId}/${target.runOrTaskId}`} icon="GitBranch" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <SettingsInput
          label="Repository path (where the Fleet ref is staged)"
          initialValue={target.repoPath}
          onChangeText={(repoPath) => onChange({ ...target, repoPath })}
          placeholder="/path/to/project"
        />
        <SettingsSelect label="Mode" value={target.mode} options={landModes} onValueChange={(mode) => onChange({ ...target, mode })} />
        <View style={{ flexDirection: "row", gap: SPACING[2], paddingTop: SPACING[2] }}>
          <Btn theme={theme} label="Land" icon="GitBranch" solid disabled={busy} onPress={onLand} />
          <Btn theme={theme} label="Cancel" tone="foregroundMuted" disabled={busy} onPress={onClose} />
        </View>
      </Modal.Content>
    </Modal>
  );
}
