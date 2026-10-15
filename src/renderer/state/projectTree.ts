import { useMemo } from "react";
import type { Thread } from "@shared/protocol";
import { useShallow } from "../lib/shallow";
import { hostPlatform, useHosts } from "./hosts";
import { buildProjects, hostOfKey, projectIndex, projectKeyFor, type ProjectIndex, type ProjectNode } from "./projects";
import { hostOfThread, useThreads } from "./threads";
import { fileHost, isApp, isDraft, isFile, useUI } from "./ui";

// The projects every view groups threads by, across this computer and its paired devices: the
// pure grouping in projects.ts, fed from the stores.

/** The project tree, kept current. */
export function useProjectTree(): ProjectNode[] {
  const { threads, owner, workspaces } = useThreads(useShallow((s) => ({ threads: s.threads, owner: s.owner, workspaces: s.workspaces })));
  const { projects, threadProject, checkouts } = useUI(useShallow((s) => ({ projects: s.projects, threadProject: s.threadProject, checkouts: s.checkouts })));
  const hosts = useHosts((s) => s.hosts);
  return useMemo(
    () => buildProjects(threads, projects, threadProject, workspaces, checkouts, owner, hostPlatform),
    // hosts: what hostPlatform reads.
    [threads, projects, threadProject, workspaces, checkouts, owner, hosts],
  );
}

/** The project tree as it is now (for event handlers). */
export function projectTreeNow(): ProjectNode[] {
  const { threads, owner, workspaces } = useThreads.getState();
  const ui = useUI.getState();
  return buildProjects(threads, ui.projects, ui.threadProject, workspaces, ui.checkouts, owner, hostPlatform);
}

export function projectIndexNow(): ProjectIndex {
  const { owner, workspaces } = useThreads.getState();
  const ui = useUI.getState();
  return projectIndex(ui.projects, workspaces, ui.checkouts, owner, hostPlatform);
}

/** The project a thread belongs to, as it is now. */
export function projectKeyNow(t: Thread): string {
  return projectKeyFor(t, useThreads.getState().threads, projectIndexNow(), useUI.getState().threadProject);
}

/**
 * The device a view's work happens on: a thread's engine's, a draft's project's, a file view's
 * own; null for this computer (and for the app views).
 */
export function hostOfView(id: string | null | undefined): string | null {
  if (!id || isApp(id)) return null;
  if (isFile(id)) return fileHost(id);
  if (isDraft(id)) {
    const draft = useUI.getState().drafts[id];
    return draft ? hostOfKey(draft.projectKey) : null;
  }
  return hostOfThread(id);
}
