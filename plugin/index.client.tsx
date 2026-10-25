/**
 * factory-connector's client entry — the `Fleet surface`. Three contributions,
 * one `<FleetShell />`: the global screen + sidebar header item, and the
 * workspace panel (explorer + workspace locations). The daemon discovers this
 * file by filename convention (`index.client.tsx`) — the manifest declares no
 * client entry. The bundle boundary (no node built-ins, no class syntax —
 * Hermes) is enforced by `scripts/check-bundle.mjs`.
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FleetPanel, FleetScreen, FleetSidebarItem, SCREEN_ID } from "./client/fleet/entries.tsx";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({ id: SCREEN_ID, title: "Fleet Connector", Component: FleetScreen }),
    client.addSidebarHeaderItem({ id: "factory-connector", title: "Fleet Connector", Component: FleetSidebarItem }),
    client.addWorkspacePanel({
      id: "factory-connector",
      title: "Fleet",
      icon: "Network",
      locations: ["explorer", "workspace"],
      Component: FleetPanel,
    }),
  ];
  return () => {
    for (const off of cleanups) off();
  };
}
