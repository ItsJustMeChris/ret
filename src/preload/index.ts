import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { IPC, type EngineId, type RetBridge } from "../shared/bridge";

function subscribe<T>(channel: string, cb: (payload: T) => void) {
  const handler = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const bridge: RetBridge = {
  platform: process.platform,
  appVersion: process.argv.find((a) => a.startsWith("--ret-version="))?.slice(14) ?? "0.0.0",
  agents: {
    send: (engine, line) => ipcRenderer.send(IPC.agentSend, engine, line),
    onMessages: (cb) => subscribe<{ engine: EngineId; lines: string[] }>(IPC.agentMessages, (m) => cb(m.engine, m.lines)),
    onStatus: (cb) => subscribe(IPC.agentStatus, cb),
    getStatus: (engine) => ipcRenderer.invoke(IPC.agentGetStatus, engine),
    restart: (engine) => ipcRenderer.invoke(IPC.agentRestart, engine),
    getSettings: () => ipcRenderer.invoke(IPC.providersGet),
    onSettings: (cb) => subscribe(IPC.providersState, cb),
    setSettings: (patch) => ipcRenderer.invoke(IPC.providersSet, patch),
    openLogin: (provider) => ipcRenderer.invoke(IPC.agentLogin, provider),
    update: (provider) => ipcRenderer.invoke(IPC.agentUpdate, provider),
  },
  updater: {
    getState: () => ipcRenderer.invoke(IPC.updaterGet),
    onState: (cb) => subscribe(IPC.updaterState, cb),
    check: () => ipcRenderer.invoke(IPC.updaterCheck),
    apply: () => ipcRenderer.invoke(IPC.updaterApply),
    setSettings: (patch) => ipcRenderer.invoke(IPC.updaterSettings, patch),
  },
  appUpdate: {
    getState: () => ipcRenderer.invoke(IPC.appUpdateGet),
    onState: (cb) => subscribe(IPC.appUpdateState, cb),
    check: () => ipcRenderer.invoke(IPC.appUpdateCheck),
    install: () => ipcRenderer.invoke(IPC.appUpdateInstall),
  },
  dialog: {
    pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
    pickFile: (filters) => ipcRenderer.invoke(IPC.pickFile, filters),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
    openPath: (p, host) => ipcRenderer.invoke(IPC.openPath, p, host ?? null),
    reveal: (p, host) => ipcRenderer.invoke(IPC.reveal, p, host ?? null),
  },
  editor: {
    available: (host) => ipcRenderer.invoke(IPC.editorAvailable, host ?? null),
    open: (p, line, col, host) => ipcRenderer.invoke(IPC.editorOpen, p, line, col, host ?? null),
  },
  git: {
    info: (p, host) => ipcRenderer.invoke(IPC.gitInfo, p, host ?? null),
    createWorktree: (cwd, label, host) => ipcRenderer.invoke(IPC.gitWorktree, cwd, label, host ?? null),
    mainCheckouts: (cwds, host) => ipcRenderer.invoke(IPC.gitCheckouts, cwds, host ?? null),
  },
  files: {
    saveImage: (data, ext, host) => ipcRenderer.invoke(IPC.saveImage, data, ext, host ?? null),
    stat: (p, host) => ipcRenderer.invoke(IPC.stat, p, host ?? null),
    pathFor: (file) => {
      try {
        return webUtils.getPathForFile(file) || null;
      } catch {
        return null;
      }
    },
  },
  apps: {
    info: (appId, host) => ipcRenderer.invoke(IPC.appInfo, appId, host ?? null),
  },
  copy: (text) => ipcRenderer.invoke(IPC.copy, text),
  edit: (command, arg) => ipcRenderer.send(IPC.edit, command, arg),
  onSpelling: (cb) => subscribe(IPC.spelling, cb),
  notify: (title, body) => ipcRenderer.send(IPC.notify, title, body),
  setTheme: (theme) => ipcRenderer.send(IPC.setTheme, theme),
  remoteAccess: {
    getState: () => ipcRenderer.invoke(IPC.remoteGet),
    onState: (cb) => subscribe(IPC.remoteState, cb),
    setHosting: (on) => ipcRenderer.invoke(IPC.remoteSetHosting, on),
    setName: (name) => ipcRenderer.invoke(IPC.remoteSetName, name),
    startPairing: () => ipcRenderer.invoke(IPC.remotePairStart),
    stopPairing: () => ipcRenderer.invoke(IPC.remotePairStop),
    revoke: (id) => ipcRenderer.invoke(IPC.remoteRevoke, id),
    pair: (target, code) => ipcRenderer.invoke(IPC.remotePair, target, code),
    forget: (id) => ipcRenderer.invoke(IPC.remoteForget, id),
    discover: () => ipcRenderer.send(IPC.remoteDiscover),
  },
};

contextBridge.exposeInMainWorld("ret", bridge);
