import { Inbox } from "lucide-react";
import { InboxView } from "../components/inbox/InboxView";
import { useInboxCount } from "../state/inbox";
import { isFile, useUI } from "../state/ui";
import type { RetApp } from "./app";

function InboxBadge() {
  const count = useInboxCount();
  return count > 0 ? <span className="seg-badge">{count}</span> : null;
}

function InboxCard() {
  const count = useInboxCount();
  return (
    <>
      <div className="tcard-body">{count ? `${count} thing${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} you` : "All clear"}</div>
      <div className="tcard-state" />
    </>
  );
}

/** The Inbox: every thread that wants something from you, across all projects, with one to read beside them. */
export const inbox: RetApp<"inbox"> = {
  kind: "inbox",
  name: "Inbox",
  icon: Inbox,
  instances: "one",
  size: { w: 980, h: 680 },
  View: InboxView,
  Card: InboxCard,
  Badge: InboxBadge,
  mode: {
    hint: "Inbox — everything that needs you, across projects",
    command: "Open the Inbox",
    // A thread goes in the reading pane.
    openThread: (id) => {
      if (isFile(id)) return false;
      useUI.setState((s) => ({ inbox: { ...s.inbox, selected: id } }));
      return true;
    },
    currentThread: () => useUI.getState().inbox.selected,
  },
};
