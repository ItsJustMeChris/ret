import { useState } from "react";
import { PROVIDER_IDS, engineId, hostOf, providerOf, type EngineId, type ProviderId } from "@shared/bridge";
import { PROVIDERS, accessFor, agentOf, pickProvider, type AgentProvider } from "../agents";
import { useShallow } from "../lib/shallow";
import { useConn, useEnabledProvidersOn } from "./conn";
import { hostOfKey } from "./projects";
import { useThread } from "./useThread";
import { isDraft, useUI, type ComposerPrefs } from "./ui";
import { setDraftProvider, type TurnOverrides } from "./actions";

// What a thread's next message is sent with: its agent (for a new thread, the one picked), model,
// reasoning effort, speed, access and Plan mode, from the thread's own settings, what was picked in
// its composer, and for new threads what was used last. The composer's settings, without the composer
// (components/thread/Composer.tsx on the desktop; the phone has its own).

/** One choice in a settings menu. Icons are the view's business: it maps them from `value`. */
export interface SettingOption {
  value: string;
  label: string;
  description?: string;
  /** Model menus listing several agents' models group them by agent. */
  group?: string;
}

/** Model menu values carry their agent, so one menu can list every agent's models. */
export const modelKey = (provider: ProviderId, model: string) => `${provider}::${model}`;
export function parseModelKey(value: string): { provider: ProviderId; model: string } {
  const at = value.indexOf("::");
  return { provider: value.slice(0, at) as ProviderId, model: value.slice(at + 2) };
}

/** Remember settings picked for a new thread with this provider, for the next one. */
function rememberPrefs(provider: ProviderId, patch: TurnOverrides) {
  useUI.setState((s) => {
    const prev = s.composerBy?.[provider] ?? (provider === "codex" ? s.composer : { model: null, effort: null, access: "config" });
    const merged = { ...prev, ...patch, access: patch.access ?? prev.access } as ComposerPrefs;
    return { composerBy: { ...s.composerBy, [provider]: merged }, ...(provider === "codex" ? { composer: merged } : {}) };
  });
}

/** Last-used settings for a new thread with this provider. */
function lastUsed(provider: ProviderId): TurnOverrides {
  const ui = useUI.getState();
  const prefs: ComposerPrefs | undefined = ui.composerBy?.[provider] ?? (provider === "codex" ? ui.composer : undefined);
  if (!prefs) return {};
  return { model: prefs.model, effort: prefs.effort, access: accessFor(provider, prefs.access), speed: prefs.speed };
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const effortLabel = (effort: string) => (effort === "xhigh" ? "Extra high" : titleCase(effort));

/** Per-thread setting overrides survive the composer going away (switching tabs, leaving the screen). */
const overrides = new Map<string, TurnOverrides>();

export interface ComposerSettings {
  draft: boolean;
  /** The paired device the thread runs on (a draft: its project's); null for this computer. */
  host: string | null;
  provider: ProviderId;
  engine: EngineId;
  agent: AgentProvider;
  /** Agents on that device, for a draft's agent menu. */
  enabled: ProviderId[];
  needsSignIn: boolean;
  /** The agent can plan first (Plan mode). */
  hasModes: boolean;
  planning: boolean;
  togglePlan(): void;
  setPrefs(patch: TurnOverrides): void;
  modelOptions: SettingOption[];
  /** The model menu lists several agents' models (a draft): picking one picks its agent. */
  modelsGrouped: boolean;
  /** Value in modelOptions, or "" while unknown. */
  model: string;
  /** The current model's name to show. */
  modelLabel: string | null;
  pickModel(value: string): void;
  /** Lightest to deepest, as the model lists them. */
  effortOptions: SettingOption[];
  effort: string | null;
  /** The effort the model uses when none is picked. */
  defaultEffort: string | null;
  /** Speed tiers beyond Standard, when the model has any. */
  speedOptions: SettingOption[];
  speed: string;
  accessOptions: SettingOption[];
  access: string;
  /** What gets sent: an unsupported speed becomes an explicit "standard" rather than being dropped. */
  effectiveOverrides(): TurnOverrides;
}

export function useComposerSettings(threadId: string): ComposerSettings {
  // The agent this thread runs on: its owner, or for a new thread the one picked in its composer.
  const draft = isDraft(threadId);
  const owner = useThread(threadId, (s) => s.owner[threadId]);
  const chosen = useUI((s) => s.drafts[threadId]?.provider);
  const draftProject = useUI((s) => s.drafts[threadId]?.projectKey);
  const lastAgent = useUI((s) => s.lastAgent);
  // The device it runs on: the draft's project's, or the thread's engine's. Its agents, models and sign-in are that device's.
  const host = draft ? (draftProject ? hostOfKey(draftProject) : null) : owner ? hostOf(owner) : null;
  const enabled = useEnabledProvidersOn(host);
  const provider: ProviderId = draft ? pickProvider(enabled, chosen, lastAgent) : providerOf(owner ?? "codex");
  const engine = engineId(provider, host);
  const agent = PROVIDERS[provider];
  const needsSignIn = useConn((s) => {
    const c = s.providers[engine];
    return !!c && c.status?.state === "running" && c.accountLoaded && !c.account?.account && !!c.account?.requiresOpenaiAuth;
  });
  // What the thread actually runs with, once its engine has said (see hydrateThread).
  const threadAccess = useThread(threadId, (s) => {
    const st = s.live[threadId]?.settings;
    return st ? (st.access ?? agentOf(s.owner[threadId] ?? "codex").accessOf?.(st.approvalPolicy, st.sandbox) ?? null) : null;
  });
  const threadModel = useThread(threadId, (s) => s.live[threadId]?.settings?.model ?? s.threads[threadId]?.model ?? null);
  const threadEffort = useThread(threadId, (s) => s.live[threadId]?.settings?.effort ?? s.threads[threadId]?.reasoningEffort ?? null);
  // Known once the thread is loaded in the app-server; undefined means "not known yet".
  const threadTier = useThread(threadId, (s) => {
    const st = s.live[threadId]?.settings;
    return st ? (st.serviceTier ?? "default") : undefined;
  });
  // Just each agent's models on this device: the providers map changes with every rate limit and usage total.
  const modelLists = useConn(useShallow((s) => PROVIDER_IDS.map((p) => s.providers[engineId(p, host)]?.models)));
  const modelsOf = (p: ProviderId) => modelLists[PROVIDER_IDS.indexOf(p)] ?? [];
  const models = modelsOf(provider);
  const hasModes = useConn((s) => !!s.providers[engine]?.modes.some((m) => m.mode === "plan"));
  const threadMode = useThread(threadId, (s) => s.live[threadId]?.settings?.mode ?? null);
  const configTier = useConn((s) => s.providers[engine]?.defaults.serviceTier ?? null);
  // New threads start from the last-used settings for their agent; existing threads from their own.
  const [over, setOver] = useState<TurnOverrides>(() => overrides.get(threadId) ?? (draft ? lastUsed(provider) : {}));
  const setPrefs = (patch: TurnOverrides) => {
    const next = { ...over, ...patch };
    setOver(next);
    overrides.set(threadId, next);
    if (draft) rememberPrefs(provider, patch);
  };
  /** A new thread picking another agent's model moves to that agent, with its last-used settings and the model picked. */
  const switchProvider = (next: ProviderId, model: string) => {
    setDraftProvider(threadId, next);
    rememberPrefs(next, { model, effort: null });
    const prefs = { ...lastUsed(next), mode: over.mode };
    setOver(prefs);
    overrides.set(threadId, prefs);
  };

  // Plan mode: the agent thinks it through, can ask you questions, and proposes a plan before changing anything.
  const planning = (over.mode ?? threadMode) === "plan";
  const togglePlan = () => setPrefs({ mode: planning ? "default" : "plan" });

  const defaultModel = models.find((m) => m.isDefault);
  const currentModel = over.model ?? threadModel ?? defaultModel?.id ?? null;
  const modelInfo = models.find((m) => m.id === currentModel || m.model === currentModel);
  const currentEffort = over.effort ?? threadEffort ?? modelInfo?.defaultReasoningEffort ?? null;
  const access = accessFor(provider, over.access ?? threadAccess ?? "config");

  // Speed tiers are per model (e.g. Fast + Ultrafast on some, Fast only or none on others).
  const tiers = modelInfo?.serviceTiers ?? [];
  const supports = (tier: string) => tier === "default" || tiers.some((t) => t.id === tier);
  const wantedSpeed = over.speed ?? threadTier ?? configTier ?? "default";
  const currentSpeed = supports(wantedSpeed) ? wantedSpeed : "default";

  // A new thread lists every agent's models (picking one picks the agent); a thread keeps to its own agent's.
  const pickable = draft ? enabled.filter((p) => p === provider || modelsOf(p).length) : [provider];
  const grouped = pickable.length > 1;
  const modelOptions: SettingOption[] = pickable.flatMap((p) => {
    const opts: SettingOption[] = modelsOf(p).map((m) => ({ value: modelKey(p, m.id), label: m.displayName || m.id, description: m.description || undefined }));
    if (p === provider && currentModel && !modelInfo) opts.unshift({ value: modelKey(p, currentModel), label: currentModel });
    return grouped ? opts.map((o) => ({ ...o, group: PROVIDERS[p].name })) : opts;
  });
  const pickModel = (value: string) => {
    const { provider: p, model } = parseModelKey(value);
    // New threads start on the last model picked, whichever agent runs it.
    if (draft) useUI.setState({ lastAgent: p });
    if (p !== provider) switchProvider(p, model);
    else setPrefs({ model, effort: null });
  };
  const effortOptions: SettingOption[] = (modelInfo?.supportedReasoningEfforts ?? []).map((e) => ({
    value: e.reasoningEffort,
    label: effortLabel(e.reasoningEffort),
    description: e.description || undefined,
  }));
  if (currentEffort && !effortOptions.some((o) => o.value === currentEffort)) {
    effortOptions.unshift({ value: currentEffort, label: effortLabel(currentEffort) });
  }
  const speedOptions: SettingOption[] = tiers.length
    ? [{ value: "default", label: "Standard", description: "Normal speed and usage" }, ...tiers.map((t) => ({ value: t.id, label: t.name, description: t.description }))]
    : [];
  const accessOptions: SettingOption[] = agent.access.map((o) => ({ value: o.id, label: o.id === "config" ? "Config default" : o.label, description: o.title }));

  return {
    draft,
    host,
    provider,
    engine,
    agent,
    enabled,
    needsSignIn,
    hasModes,
    planning,
    togglePlan,
    setPrefs,
    modelOptions,
    modelsGrouped: grouped,
    model: currentModel ? modelKey(provider, currentModel) : "",
    modelLabel: modelInfo ? modelInfo.displayName || modelInfo.id : currentModel,
    pickModel,
    effortOptions,
    effort: currentEffort,
    defaultEffort: modelInfo?.defaultReasoningEffort ?? null,
    speedOptions,
    speed: currentSpeed,
    accessOptions,
    access,
    effectiveOverrides: () => {
      const speed = over.speed === undefined ? undefined : supports(over.speed) ? over.speed : "default";
      return { ...over, speed };
    },
  };
}
