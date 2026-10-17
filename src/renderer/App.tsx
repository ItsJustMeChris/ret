import { useEffect, useRef, type ComponentType, type ReactElement } from "react";
import { useUI, activeBoard, isThread, type ViewMode } from "./state/ui";
import { useConn } from "./state/conn";
import { useThreads } from "./state/threads";
import { closeCodeTab, closePane, closeTab, closeWindow, focusWindow, forkThread, newThreadNear } from "./state/actions";
import { toggleTerminal } from "./state/terminals";
import { Titlebar } from "./components/Titlebar";
import { SidebarShell } from "./components/SidebarShell";
import { FocusView } from "./components/FocusView";
import { CanvasView } from "./components/canvas/CanvasView";
import { CodeView } from "./components/code/CodeView";
import { InboxView } from "./components/inbox/InboxView";
import { CommandPalette, currentThreadId } from "./components/CommandPalette";
import { SettingsModal } from "./components/Settings";
import { LoginGate } from "./components/LoginGate";
import { Toasts } from "./components/Toasts";
import { DialogHost } from "./components/ui/Dialog";
import { TooltipHost } from "./components/ui/Tooltip";
import { HoverCardHost } from "./components/HoverCards";
import { ImageViewer } from "./components/ImageViewer";
import { ContextMenuHost } from "./components/ContextMenuHost";
import { Kept } from "./components/ui/Kept";
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
  if (ui.mode === "code") {
    const tabs = ui.code.tabs;
    if (!tabs.length) return;
    const i = ui.code.active ? tabs.indexOf(ui.code.active) : -1;
    useUI.setState((s) => ({ code: { ...s.code, active: tabs[(i + dir + tabs.length) % tabs.length] } }));
    return;
  }
  if (ui.mode === "inbox") return;
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
      // Alt+1…4: Focus, Canvas, Code, Inbox.
      if (e.altKey && !mod && !e.shiftKey && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        useUI.setState({ mode: (["focus", "canvas", "code", "inbox"] as const)[Number(e.key) - 1] });
        return;
      }
      if (!mod) return;
      const k = e.key.toLowerCase();
      // Ctrl+`: the current thread's terminal (Ctrl+Shift+`: another one). By key position, so it's the
      // key left of 1 whatever the layout.
      if (e.code === "Backquote" && !e.altKey) {
        e.preventDefault();
        toggleTerminal(currentThreadId(), { fresh: e.shiftKey });
        return;
      }
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
        if (id && isThread(id)) void forkThread(id);
      } else if (k === "w") {
        e.preventDefault();
        if (ui.mode === "focus" && ui.activeTab) {
          // In a split, Ctrl+W closes the focused pane; otherwise the tab.
          if (ui.splits[ui.activeTab]) closePane(ui.focusedSide);
          else closeTab(ui.activeTab);
        }
        else if (ui.mode === "canvas" && ui.focusedWindow) closeWindow(ui.focusedWindow);
        else if (ui.mode === "code" && ui.code.active) closeCodeTab(ui.code.active);
      } else if (k === "tab") {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const n = Number(e.key) - 1;
        if (ui.mode === "focus") {
          const id = ui.tabs[n];
          if (id) useUI.setState({ activeTab: id });
        } else if (ui.mode === "code") {
          const id = ui.code.tabs[n];
          if (id) useUI.setState((s) => ({ code: { ...s.code, active: id } }));
        } else if (ui.mode === "canvas") {
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

const VIEWS: Record<ViewMode, ComponentType> = { focus: FocusView, canvas: CanvasView, code: CodeView, inbox: InboxView };

/**
 * The mode's view. Each is built the first time you go to it and kept from then on, so switching
 * back is instant: leaving the canvas used to take down every window, and coming back build them all.
 */
function Views({ mode }: { mode: ViewMode }) {
  // The same element each time: switching shows and hides them without re-rendering any.
  const built = useRef(new Map<ViewMode, ReactElement>());
  if (!built.current.has(mode)) {
    const View = VIEWS[mode];
    built.current.set(mode, <View />);
  }
  return [...built.current].map(([m, view]) => (
    <Kept key={m} shown={m === mode}>
      {view}
    </Kept>
  ));
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
        <main className="main">
          <Views mode={mode} />
        </main>
      </div>
      <CommandPalette />
      <SettingsModal />
      <LoginGate />
      <Toasts />
      <DialogHost />
      <TooltipHost />
      <HoverCardHost />
      <ImageViewer />
      <ContextMenuHost />
    </div>
  );
}
