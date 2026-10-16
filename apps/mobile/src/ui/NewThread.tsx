import { FolderGit2, SquarePen } from "lucide-react-native";
import { useState } from "react";
import { Pressable } from "react-native";
import { hostName } from "@ret/state/hosts";
import { useProjectTree } from "@ret/state/projectTree";
import { startThread } from "../drafts";
import { Icon } from "./primitives";
import { OptionSheet } from "./Sheet";

/** The header's "new thread": pick the project (most recently active first), then write the task. */
export function NewThreadButton() {
  const [open, setOpen] = useState(false);
  const tree = useProjectTree();
  const projects = tree.filter((p) => !p.conf?.hidden && p.host).sort((a, b) => b.recency - a.recency);
  if (!projects.length) return null;
  return (
    <>
      <Pressable hitSlop={10} onPress={() => setOpen(true)} accessibilityLabel="New thread" className="px-1">
        <Icon icon={SquarePen} size={20} colorClassName="accent-accent" />
      </Pressable>
      <OptionSheet
        open={open}
        onClose={() => setOpen(false)}
        title="New thread in"
        options={projects.map((p) => ({ value: p.key, label: p.conf?.name ?? p.name, description: `${p.path} · ${hostName(p.host)}`, icon: FolderGit2 }))}
        onPick={(key) => {
          const p = projects.find((x) => x.key === key);
          if (p) setTimeout(() => startThread(p.key, p.conf?.path ?? p.path), 300);
        }}
      />
    </>
  );
}
