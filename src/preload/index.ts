import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { IPC, type ProviderId, type RetBridge } from "../shared/bridge";

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
    send: (provider, line) => ipcRenderer.send(IPC.agentSend, provider, line),
    onMessages: (cb) => subscribe<{ provider: ProviderId; lines: string[] }>(IPC.agentMessages, (m) => cb(m.provider, m.lines)),
    onStatus: (cb) => subscribe(IPC.agentStatus, cb),
    getStatus: (provider) => ipcRenderer.invoke(IPC.agentGetStatus, provider),
    restart: (provider) => ipcRenderer.invoke(IPC.agentRestart, provider),
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
    openPath: (p) => ipcRenderer.invoke(IPC.openPath, p),
    reveal: (p) => ipcRenderer.invoke(IPC.reveal, p),
  },
  editor: {
    available: () => ipcRenderer.invoke(IPC.editorAvailable),
    open: (p, line, col) => ipcRenderer.invoke(IPC.editorOpen, p, line, col),
  },
  git: {
    info: (p) => ipcRenderer.invoke(IPC.gitInfo, p),
    createWorktree: (cwd, label) => ipcRenderer.invoke(IPC.gitWorktree, cwd, label),
  },
  files: {
    saveImage: (data, ext) => ipcRenderer.invoke(IPC.saveImage, data, ext),
    stat: (p) => ipcRenderer.invoke(IPC.stat, p),
    pathFor: (file) => {
      try {
        return webUtils.getPathForFile(file) || null;
      } catch {
        return null;
      }
    },
  },
  copy: (text) => ipcRenderer.invoke(IPC.copy, text),
  edit: (command, arg) => ipcRenderer.send(IPC.edit, command, arg),
  onSpelling: (cb) => subscribe(IPC.spelling, cb),
  notify: (title, body) => ipcRenderer.send(IPC.notify, title, body),
  setTheme: (theme) => ipcRenderer.send(IPC.setTheme, theme),
};

contextBridge.exposeInMainWorld("ret", bridge);
