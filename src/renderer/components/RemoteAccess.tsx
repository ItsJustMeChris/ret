import { useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, Monitor, Plus } from "lucide-react";
import { REMOTE_DEFAULT_PORT, shortDeviceId, type RemoteHost, type RemoteState } from "@shared/remote";
import { bridge } from "../bridge";
import { toast } from "../state/toasts";
import { promptText } from "./ui/Dialog";
import { Switch } from "./ui/Toggle";

type Target = { address: string; port: number };

function useRemoteState(): RemoteState | null {
  const [state, setState] = useState<RemoteState | null>(null);
  useEffect(() => {
    let live = true;
    void bridge.remoteAccess.getState().then((s) => live && setState(s));
    const off = bridge.remoteAccess.onState(setState);
    // Settings is where people look for devices: ask the network now rather than at the next sweep.
    bridge.remoteAccess.discover();
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

/** An error from the main process, without Electron's "Error invoking remote method…" wrapping. */
const messageOf = (err: unknown) =>
  String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    toast(messageOf(err), "error");
    return undefined;
  }
}

/** "192.168.1.20", "192.168.1.20:47821", "studio.local", "[fe80::1]:47821". */
function parseAddress(text: string): Target | null {
  const s = text.trim();
  const v6 = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(s);
  const plain = /^([^\s:/]+)(?::(\d{1,5}))?$/.exec(s);
  const m = v6 ?? plain;
  return m ? { address: m[1], port: m[2] ? Number(m[2]) : REMOTE_DEFAULT_PORT } : null;
}

async function pairWith(target: Target, name?: string) {
  const who = name ?? target.address;
  const code = await promptText({
    title: `Pair with ${who}`,
    label: `The code ${name ?? "it"} shows under Settings → Remote access → Pair a device`,
    placeholder: "123 456",
    confirmLabel: "Pair",
  });
  if (!code?.trim()) return;
  const host = await attempt(() => bridge.remoteAccess.pair(target, code));
  if (!host) return;
  toast(`Paired with ${host.name}: its projects and threads are in the sidebar now`);
}

async function connectByAddress(hosts: RemoteHost[]) {
  const text = await promptText({
    title: "Connect by address",
    label: "The other computer's address (Settings → Remote access there shows it)",
    placeholder: `192.168.1.20:${REMOTE_DEFAULT_PORT}`,
    confirmLabel: "Next",
  });
  if (!text?.trim()) return;
  const target = parseAddress(text);
  if (!target) return toast("That doesn't look like an address", "error");
  const known = hosts.find((h) => h.address === target.address && h.port === target.port);
  if (known) return toast(`Already paired with ${known.name}`);
  await pairWith(target);
}

function ago(at: number | null): string {
  if (!at) return "never";
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}

/** Settings → Remote access: let paired devices in, and open theirs. */
export function RemoteAccessSection() {
  const state = useRemoteState();
  const [switching, setSwitching] = useState(false);
  if (!state) return null;

  const setHosting = async (on: boolean) => {
    setSwitching(true);
    await attempt(() => bridge.remoteAccess.setHosting(on));
    setSwitching(false);
  };

  return (
    <section>
      <h4>Remote access</h4>
      <div className="setting-row">
        <div>
          <div>
            Let my other devices use this Ret {switching && <LoaderCircle size={12} className="spin" />}
          </div>
          <div className="muted small">
            Devices you pair, on this network, can run agents, read and change files and use git here, as you. The connection is end-to-end encrypted.
          </div>
        </div>
        <Switch checked={state.hosting} onChange={(v) => void setHosting(v)} />
      </div>
      {state.error && (
        <div className="setting-error">
          <CircleAlert size={13} /> {state.error}
        </div>
      )}
      {state.hosting && <Hosting state={state} />}
      <OtherDevices state={state} />
    </section>
  );
}

function Hosting({ state }: { state: RemoteState }) {
  const rename = async () => {
    const name = await promptText({ title: "Rename this device", label: "What your other devices see it as", initial: state.name, confirmLabel: "Rename" });
    if (name?.trim()) await attempt(() => bridge.remoteAccess.setName(name));
  };
  const where = state.port ? state.addresses.map((a) => `${a}:${state.port}`).join(" · ") : "";
  return (
    <>
      <div className="setting-row">
        <div>
          <div>
            {state.name}{" "}
            <button className="link small" onClick={() => void rename()}>
              Rename
            </button>
          </div>
          <div className="muted small mono" title={where ? `${where} · device ${state.deviceId}` : state.deviceId}>
            device {shortDeviceId(state.deviceId)}
            {where ? ` · ${where}` : ""}
          </div>
        </div>
        {state.pairing ? (
          <button className="btn ghost" onClick={() => void attempt(() => bridge.remoteAccess.stopPairing())}>
            Cancel
          </button>
        ) : (
          <button className="btn" disabled={!state.port} onClick={() => void attempt(() => bridge.remoteAccess.startPairing())}>
            <Plus size={13} /> Pair a device
          </button>
        )}
      </div>
      {state.pairing && <PairingCode code={state.pairing.code} expiresAt={state.pairing.expiresAt} />}
      {!state.pairing && state.pairingResult && (
        <div className={state.pairingResult.ok ? "muted small" : "setting-error"}>
          {!state.pairingResult.ok && <CircleAlert size={13} />} {state.pairingResult.message}
        </div>
      )}
      {state.clients.map((c) => (
        <div key={c.id} className="setting-row remote-device">
          <div>
            <div>
              {c.name} {c.connected && <span className="badge ok">connected</span>}
            </div>
            <div className="muted small">
              {c.connected ? `From ${c.address}` : `Last connected ${ago(c.lastSeen)}`} · device {shortDeviceId(c.id)}
              {c.notifications && " · notified while away"}
            </div>
          </div>
          <button className="btn ghost" title={`Stop letting ${c.name} in`} onClick={() => void attempt(() => bridge.remoteAccess.revoke(c.id))}>
            Remove
          </button>
        </div>
      ))}
    </>
  );
}

function PairingCode({ code, expiresAt }: { code: string; expiresAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return (
    <div className="pair-code">
      <div className="pair-code-digits" aria-label={`Pairing code ${code.split("").join(" ")}`}>
        {code.slice(0, 3)}
        <span />
        {code.slice(3)}
      </div>
      <div className="muted small">
        On the other device, open Settings → Remote access, choose this one (or connect by address) and enter the code. It works once, for the next{" "}
        {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}.
      </div>
    </div>
  );
}

function OtherDevices({ state }: { state: RemoteState }) {
  const unpaired = state.nearby.filter((n) => !n.paired);
  return (
    <>
      <div className="setting-subhead">Other devices</div>
      {state.hosts.map((h) => (
        <div key={h.id} className="setting-row remote-device">
          <div>
            <div>
              <Monitor size={12} className="remote-device-icon" /> {h.name}{" "}
              <span className={`badge ${h.connected ? "ok" : h.online ? "" : "warn"}`}>{h.connected ? "connected" : h.online ? "connecting" : "offline"}</span>
            </div>
            <div className="muted small mono">
              device {shortDeviceId(h.id)} · {h.address}:{h.port}
            </div>
          </div>
          <button
            className="btn ghost"
            title={`Unpair ${h.name} on this side: its threads leave the sidebar`}
            onClick={() => void attempt(() => bridge.remoteAccess.forget(h.id))}
          >
            Forget
          </button>
        </div>
      ))}
      {unpaired.map((n) => (
        <div key={n.id} className="setting-row remote-device">
          <div>
            <div>
              <Monitor size={12} className="remote-device-icon" /> {n.name} <span className="badge">nearby</span>
            </div>
            <div className="muted small mono">
              device {shortDeviceId(n.id)} · {n.address}:{n.port}
            </div>
          </div>
          <button className="btn" onClick={() => void pairWith({ address: n.address, port: n.port }, n.name)}>
            Pair
          </button>
        </div>
      ))}
      {!state.hosts.length && !unpaired.length && (
        <div className="muted small">Turn on remote access in Ret on another computer on this network and it shows up here.</div>
      )}
      <div>
        <button className="link small" onClick={() => void connectByAddress(state.hosts)}>
          Connect by address…
        </button>
      </div>
    </>
  );
}
