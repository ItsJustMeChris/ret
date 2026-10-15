// Remote access: other computers on the network running Ret, paired once and then used
// as if their agents, files and git were local. See src/main/remote.

import type { RetBridge } from "./bridge";

/** A device this one has paired with, either way round. Ids are SHA-256 hashes of device keys. */
export interface PairedDevice {
  id: string;
  name: string;
  pairedAt: number;
  lastSeen: number | null;
}

/** A device allowed to use this Ret. */
export interface RemoteClient extends PairedDevice {
  /** Connected right now (from this address). */
  connected: boolean;
  address: string | null;
}

/** A device whose Ret this one uses: its engines, threads and files show up here as its own. */
export interface RemoteHost extends PairedDevice {
  /** What engine ids, project keys and image URLs know it by (see hostKeyOf). */
  key: string;
  /** Where it was last reached. */
  address: string;
  port: number;
  /** Seen on the network lately, or connected. */
  online: boolean;
  connected: boolean;
  /** Its operating system (process.platform), once connected: how its paths are written. */
  platform: string | null;
}

/** A Ret found on the network that advertises itself. */
export interface NearbyHost {
  id: string;
  name: string;
  address: string;
  port: number;
  paired: boolean;
}

export interface RemoteState {
  /** Accepting connections from paired devices, and advertising on the network. */
  hosting: boolean;
  /** What other devices see this one as. */
  name: string;
  deviceId: string;
  /** Listening port, while hosting. */
  port: number | null;
  /** This computer's addresses on the network, for connecting by hand. */
  addresses: string[];
  error: string | null;
  /** A pairing code on show: a device that types it within the time pairs with this one. */
  pairing: { code: string; expiresAt: number } | null;
  /** How the last pairing ended (shown until the next one starts). */
  pairingResult: { ok: boolean; message: string } | null;
  clients: RemoteClient[];
  hosts: RemoteHost[];
  nearby: NearbyHost[];
}

export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_DEFAULT_PORT = 47821;

/** A device's short key: unique among paired devices, and fits in a URL's host name. */
export function hostKeyOf(deviceId: string): string {
  return deviceId.slice(0, 16).toLowerCase();
}

/** The short form of a device id people compare: ABCD-EF12-3456. */
export function shortDeviceId(id: string): string {
  return (id.slice(0, 12).toUpperCase().match(/.{4}/g) ?? []).join("-");
}

/** For bridges without remote access (the browser dev mode, the web demo): it says why. */
export function noRemoteAccess(reason: string): RetBridge["remoteAccess"] {
  const state: RemoteState = {
    hosting: false,
    name: "",
    deviceId: "",
    port: null,
    addresses: [],
    error: reason,
    pairing: null,
    pairingResult: null,
    clients: [],
    hosts: [],
    nearby: [],
  };
  const fail = async (): Promise<never> => {
    throw new Error(reason);
  };
  return {
    getState: async () => state,
    onState: () => () => {},
    setHosting: fail,
    setName: fail,
    startPairing: fail,
    stopPairing: async () => state,
    revoke: fail,
    pair: fail,
    forget: fail,
    discover: () => {},
  };
}
