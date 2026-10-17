/**
 * The `Fleet surface`'s hosts: the global screen, the workspace panel (scoped
 * to the active workspace's directory via `useWorkspace`, which prefills the
 * `Handoff` launcher and `Land` dialogs), and the sidebar header item that
 * opens the screen.
 */
import type { PluginSidebarItemProps, PluginSurfaceProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useWorkspace } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { FleetShell } from "./shell.tsx";

export const SCREEN_ID = "factory-connector";

/** The global screen: the whole `Fleet` on one unified view. */
export function FleetScreen({ theme, navigation, host }: PluginSurfaceProps) {
  return <FleetShell theme={theme} navigation={navigation} serverId={host.id} />;
}

/** The workspace panel: the shell with the Handoff/Land paths pre-scoped to this workspace. */
export function FleetPanel({ theme, navigation, host, workspaceId }: PluginWorkspacePanelProps) {
  const dir = useWorkspace(workspaceId, (workspace) => workspace.directory);
  return <FleetShell theme={theme} dir={dir ?? undefined} navigation={navigation} serverId={host.id} />;
}

/** The sidebar header item: one row, opens the global screen. */
export function FleetSidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Network" label="Fleet Connector" active={currentScreen?.screenId === SCREEN_ID} onPress={() => openScreen({ screenId: SCREEN_ID })} />;
}
