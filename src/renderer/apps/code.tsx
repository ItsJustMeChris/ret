import { Code2 } from "lucide-react";
import { CodeView } from "../components/code/CodeView";
import { closeCodeTab } from "../state/actions";
import { filePath, isFile, useUI } from "../state/ui";
import type { RetApp } from "./app";

function CodeCard() {
  const active = useUI((s) => s.code.active);
  const tabs = useUI((s) => s.code.tabs.length);
  return (
    <>
      <div className="tcard-body">{active ? filePath(active).split(/[\\/]/).pop() : "No file open"}</div>
      <div className="tcard-state">{tabs ? `${tabs} open` : ""}</div>
    </>
  );
}

const setActive = (id: string) => useUI.setState((s) => ({ code: { ...s.code, active: id } }));

/** Code: the project's files, open files in an editor, and one of its threads to talk to. */
export const code: RetApp<"code"> = {
  kind: "code",
  name: "Code",
  icon: Code2,
  instances: "one",
  size: { w: 1240, h: 760 },
  View: CodeView,
  Card: CodeCard,
  mode: {
    hint: "Code mode — the project's files beside a thread",
    command: "Switch to Code mode",
    // A thread goes in the chat column, a file in an editor tab.
    openThread: (id) => {
      if (isFile(id)) {
        useUI.setState((s) => ({ code: { ...s.code, tabs: s.code.tabs.includes(id) ? s.code.tabs : [...s.code.tabs, id], active: id } }));
      } else {
        useUI.setState((s) => ({ code: { ...s.code, chat: id, project: null } }));
      }
      return true;
    },
    currentThread: () => useUI.getState().code.chat,
    // Its tabs are the open files.
    tabs: {
      cycle(dir) {
        const { tabs, active } = useUI.getState().code;
        if (!tabs.length) return;
        const i = active ? tabs.indexOf(active) : -1;
        setActive(tabs[(i + dir + tabs.length) % tabs.length]);
      },
      close() {
        const { active } = useUI.getState().code;
        if (active) closeCodeTab(active);
      },
      go(n) {
        const id = useUI.getState().code.tabs[n];
        if (id) setActive(id);
      },
    },
  },
};
