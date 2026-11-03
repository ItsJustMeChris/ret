import { router } from "expo-router";
import { FolderGit2, GitFork } from "lucide-react-native";
import { createContext, useState } from "react";
import { FORK } from "@ret/lib/forks";
import { forkThread } from "@ret/state/actions";
import { useThread } from "@ret/state/useThread";
import { OptionSheet, type SheetOption } from "../ui/Sheet";

/** Where to fork a thread: all of it, or up to one of its turns. */
export interface ForkAt {
  turnId?: string;
}

/** The thread screen's fork sheet, for its turns' "Fork from here". */
export const ForkContext = createContext<((at: ForkAt) => void) | null>(null);

/**
 * Forking, in a sheet: the desktop's Fork menu in a thread's header (Fork conversation, Fork into
 * new worktree), or a turn's "Fork from here". The fork opens over the thread it came from, where
 * the desktop opens it beside it.
 */
export function ForkSheet({ threadId, at, onClose }: { threadId: string; at: ForkAt | null; onClose: () => void }) {
  const git = useThread(threadId, (s) => !!s.threads[threadId]?.gitInfo);
  // What it offered stays while it slides away.
  const [shown, setShown] = useState(at);
  if (at && at !== shown) setShown(at);
  const turnId = shown?.turnId;
  const options: SheetOption[] = [
    turnId ? { value: "fork", label: FORK.here, description: FORK.hereHint, icon: GitFork } : { value: "fork", label: FORK.conversation, icon: GitFork },
    ...(git ? [{ value: "worktree", label: FORK.worktree, icon: FolderGit2 }] : []),
  ];
  const pick = async (value: string) => {
    const id = await forkThread(threadId, { atTurnId: turnId, worktree: value === "worktree" });
    if (id) router.push({ pathname: "/thread/[id]", params: { id } });
  };
  return <OptionSheet open={!!at} onClose={onClose} title={FORK.button} options={options} onPick={(v) => void pick(v)} />;
}
