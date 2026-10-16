import { router } from "expo-router";
import { composerDrafts } from "@ret/state/composerDrafts";
import { newId, useUI } from "@ret/state/ui";

// New threads: a draft (the desktop's, in its UI store) in a project, which its first message
// starts on the computer the project is on (sendMessage does that, as on the desktop).

/** Start a new thread in a project and open it. */
export function startThread(projectKey: string, cwd: string) {
  const id = `draft:${newId()}`;
  useUI.setState((s) => ({ drafts: { ...s.drafts, [id]: { cwd, projectKey, createdAt: Date.now() } } }));
  router.push({ pathname: "/thread/[id]", params: { id } });
}

/** Left without sending anything: the draft goes (the desktop drops a closed tab's draft the same way). */
export function dropDraftIfUnused(id: string) {
  if (composerDrafts.get(id)?.trim()) return;
  useUI.setState((s) => {
    if (!s.drafts[id]) return s;
    const drafts = { ...s.drafts };
    delete drafts[id];
    return { drafts };
  });
}
