import { create } from "zustand";
import { PROVIDER_IDS, engineId, hostOf, providerOf, type EngineId } from "@shared/bridge";
import type { RemoteHost } from "@shared/remote";
import { bridge, isDesktop } from "../bridge";
import { PROVIDERS } from "../agents";
import { setEngineNames } from "../rpc/client";

/**
 * The devices this one is paired with, by host key. Their engines join this computer's (as
 * "codex@<host>"), so their threads, projects and requests show up alongside its own.
 */
export const useHosts = create<{ hosts: Record<string, RemoteHost>; loaded: boolean }>(() => ({ hosts: {}, loaded: !isDesktop }));

export function hostName(host: string | null | undefined): string {
  return host ? (useHosts.getState().hosts[host]?.name ?? "another device") : "This computer";
}

/** "Codex", or "Codex on Studio" for a paired device's. */
export function engineName(engine: EngineId): string {
  const host = hostOf(engine);
  const agent = PROVIDERS[providerOf(engine)].name;
  return host ? `${agent} on ${hostName(host)}` : agent;
}
setEngineNames(engineName);

/** A paired device's engines (whether or not they're on there). */
export function hostEngines(host: string): EngineId[] {
  return PROVIDER_IDS.map((p) => engineId(p, host));
}

/** The operating system a device's paths come from (this computer's, or as the device last said). */
export function hostPlatform(host: string | null | undefined): string {
  return host ? (useHosts.getState().hosts[host]?.platform ?? "unknown") : bridge.platform;
}

/** Follow the paired devices; `changed` hears which came and went. */
export function watchHosts(changed: (added: string[], removed: string[]) => void) {
  if (!isDesktop) return;
  let last = "";
  const apply = (list: RemoteHost[]) => {
    const json = JSON.stringify(list);
    if (json === last) return;
    last = json;
    const prev = useHosts.getState().hosts;
    const hosts = Object.fromEntries(list.map((h) => [h.key, h]));
    const added = Object.keys(hosts).filter((k) => !prev[k]);
    const removed = Object.keys(prev).filter((k) => !hosts[k]);
    useHosts.setState({ hosts, loaded: true });
    if (added.length || removed.length) changed(added, removed);
  };
  bridge.remoteAccess.onState((s) => apply(s.hosts));
  void bridge.remoteAccess.getState().then((s) => apply(s.hosts));
}
