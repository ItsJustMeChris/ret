import { useEffect } from "react";
import { useUI, activeBoard, isDraft } from "./state/ui";
import { useConn } from "./state/conn";
import { useThreads } from "./state/threads";
import { closePane, closeTab, closeWindow, focusWindow, forkThread, newThreadNear } from "./state/actions";
import { Titlebar } from "./components/Titlebar";
import { SidebarShell } from "./components/SidebarShell";
import { FocusView } from "./components/FocusView";
import { CanvasView } from "./components/canvas/CanvasView";
import { CommandPalette, currentThreadId } from "./components/CommandPalette";
import { SettingsModal } from "./components/Settings";
import { LoginGate } from "./components/LoginGate";
import { Toasts } from "./components/Toasts";
import { DialogHost } from "./components/ui/Dialog";
import { TooltipHost } from "./components/ui/Tooltip";
import { ContextMenuHost } from "./components/ContextMenuHost";
import { fitAll, toggleMaximize, viewport } from "./components/canvas/viewport";
import { bridge } from "./bridge";

function useTheme() {
  const theme = useUI((s) => s.theme);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const t = theme === "system" ? (mq.matches ? "light" : "dark") : theme;
      document.documentElement.dataset.theme = t;
      bridge.setTheme(t);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
}

/** Swap in a freshly downloaded codex once nothing is running, so updates never interrupt work. */
function useAutoApplyUpdates() {
  const staged = useConn((s) => s.updater?.staged);
  const busy = useThreads((s) => Object.values(s.live).some((l) => l.activeTurnId) || Object.keys(s.requests).length > 0);
  useEffect(() => {
    if (!staged || busy) return;
    const t = setTimeout(() => void bridge.updater.apply(), 4000);
    return () => clearTimeout(t);
  }, [staged, busy]);
}

function cycle(dir: 1 | -1) {
  const ui = useUI.getState();
  if (ui.mode === "focus") {
    if (!ui.tabs.length) return;
    const i = ui.activeTab ? ui.tabs.indexOf(ui.activeTab) : -1;
    useUI.setState({ activeTab: ui.tabs[(i + dir + ui.tabs.length) % ui.tabs.length] });
  } else {
    const wins = activeBoard(ui).windows.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    if (!wins.length) return;
    const i = wins.findIndex((w) => w.id === ui.focusedWindow);
    focusWindow(wins[(i + dir + wins.length) % wins.length].id, true);
  }
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const ui = useUI.getState();
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        useUI.setState({ paletteOpen: !ui.paletteOpen });
      } else if (k === "\\") {
        e.preventDefault();
        useUI.setState({ mode: ui.mode === "focus" ? "canvas" : "focus" });
      } else if (k === "b" && !e.shiftKey) {
        e.preventDefault();
        useUI.setState({ sidebarOpen: !ui.sidebarOpen });
      } else if (k === "n" && !e.shiftKey) {
        e.preventDefault();
        newThreadNear(currentThreadId());
      } else if (k === "f" && e.shiftKey) {
        e.preventDefault();
        const id = currentThreadId();
        if (id && !isDraft(id)) void forkThread(id);
      } else if (k === "w") {
        e.preventDefault();
        if (ui.mode === "focus" && ui.activeTab) {
          // In a split, Ctrl+W closes the focused pane; otherwise the tab.
          if (ui.splits[ui.activeTab]) closePane(ui.focusedSide);
          else closeTab(ui.activeTab);
        }
        else if (ui.mode === "canvas" && ui.focusedWindow) closeWindow(ui.focusedWindow);
      } else if (k === "tab") {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const n = Number(e.key) - 1;
        if (ui.mode === "focus") {
          const id = ui.tabs[n];
          if (id) useUI.setState({ activeTab: id });
        } else {
          const wins = activeBoard(ui).windows.slice().sort((a, b) => a.y - b.y || a.x - b.x);
          if (wins[n]) focusWindow(wins[n].id, true);
        }
      } else if (ui.mode === "canvas" && (k === "0" || k === "=" || k === "+" || k === "-")) {
        e.preventDefault();
        if (k === "0") fitAll();
        else {
          const el = document.querySelector<HTMLElement>(".canvas-viewport");
          const f = k === "-" ? 1 / 1.25 : 1.25;
          viewport.zoomAt(f, (el?.clientWidth ?? 0) / 2, (el?.clientHeight ?? 0) / 2);
        }
      } else if (ui.mode === "canvas" && k === "m" && e.shiftKey && ui.focusedWindow) {
        e.preventDefault();
        toggleMaximize(ui.focusedWindow);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function App() {
  const mode = useUI((s) => s.mode);
  useTheme();
  useShortcuts();
  useAutoApplyUpdates();

  return (
    <div className={`app mode-${mode}`}>
      <Titlebar />
      <div className="app-body">
        <SidebarShell />
        <main className="main">{mode === "focus" ? <FocusView /> : <CanvasView />}</main>
      </div>
      <CommandPalette />
      <SettingsModal />
      <LoginGate />
      <Toasts />
      <DialogHost />
      <TooltipHost />
      <ContextMenuHost />
    </div>
  );
}
