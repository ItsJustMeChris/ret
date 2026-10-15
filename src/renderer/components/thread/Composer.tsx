import { useEffect, useRef, useState } from "react";
import { ArrowUp, Gauge, ListChecks, LoaderCircle, LogIn, Paperclip, Rocket, Settings2, Shield, ShieldAlert, ShieldCheck, Square, X, Zap } from "lucide-react";
import type { ProviderId } from "@shared/bridge";
import { useThread } from "../../state/useThread";
import { useUI, isDraft, type ComposerPrefs } from "../../state/ui";
import { useConn, useEnabledProviders } from "../../state/conn";
import { interrupt, isWritingFinalAnswer, sendMessage, setDraftProvider, startLogin, type Attachment, type TurnOverrides } from "../../state/actions";
import { PROVIDERS, accessFor, pickProvider } from "../../agents";
import { bridge, isDesktop } from "../../bridge";
import { toast } from "../../state/toasts";
import { Select, type SelectOption } from "../ui/Select";
import { QueueTray } from "./QueueTray";
import { GoalBar } from "./GoalBar";
import { AgentTray } from "./Subagents";
import { composerDrafts as drafts, composerFocus, takeAttachments } from "../../state/composerDrafts";
import { addFilesToThread } from "../../state/attach";
import { QuestionDock, useQuestionFlow, type QuestionFlow } from "./QuestionDock";
import { useVisibility } from "../ui/Kept";

/** Access choices escalate: default, careful, in-between, everything. */
const ACCESS_ICON: Record<string, React.ReactNode> = {
  config: <Settings2 size={13} />,
  "read-only": <ShieldCheck size={13} />,
  default: <ShieldCheck size={13} />,
  auto: <Shield size={13} />,
  acceptEdits: <Shield size={13} />,
  full: <ShieldAlert size={13} />,
  bypassPermissions: <ShieldAlert size={13} />,
};

function accessOptions(provider: ProviderId): SelectOption[] {
  return PROVIDERS[provider].access.map((o) => ({
    value: o.id,
    label: o.id === "config" ? "Config default" : o.label,
    description: o.title,
    icon: ACCESS_ICON[o.id] ?? <Shield size={13} />,
  }));
}

/** Model menu values carry their agent, so one menu can list every agent's models. */
const modelKey = (provider: ProviderId, model: string) => `${provider}::${model}`;
function parseModelKey(value: string): { provider: ProviderId; model: string } {
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

const SPEED_ICON: Record<string, React.ReactNode> = {
  default: <Gauge size={13} />,
  priority: <Zap size={13} />,
  ultrafast: <Rocket size={13} />,
};

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Per-thread setting overrides survive switching tabs/windows (as does unsent text, in composerDrafts). */
const overrides = new Map<string, TurnOverrides>();

/** Focus a textarea with the caret after its text, ready to keep typing. */
function focusAtEnd(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
  el.scrollTop = el.scrollHeight;
}

/** What the box says while a question is open. */
function askHint(ask: QuestionFlow): string {
  if (ask.q.secret) return "Answer in the field above…";
  if (!ask.rows || ask.other) return "Type your answer…";
  const keys = ask.rows === 1 ? "1" : `1–${Math.min(ask.rows, 9)}`;
  return ask.otherRow ? `Press ${keys} to pick, or type your own answer…` : `Press ${keys} to pick…`;
}

export function Composer({
  threadId,
  autoFocus,
  compact,
  agentsElsewhere,
}: {
  threadId: string;
  autoFocus?: boolean;
  compact?: boolean;
  /** The thread's subagents are on screen already (the details panel), so the dock leaves them out. */
  agentsElsewhere?: boolean;
}) {
  const [text, setText] = useState(() => drafts.get(threadId) ?? "");
  const [attachments, setAttachments] = useState<Attachment[]>(() => takeAttachments(threadId));
  const [sending, setSending] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const running = useThread(threadId, (s) => !!s.live[threadId]?.activeTurnId);
  // Final summary streaming: Enter now means "send right after it finishes" (a steer would be dropped).
  const finishing = useThread(threadId, (s) => {
    const lt = s.live[threadId];
    return !!lt?.activeTurnId && isWritingFinalAnswer(lt);
  });
  // Another Codex process owns the current turn; writing to the same thread from here could corrupt it.
  const elsewhere = useThread(threadId, (s) => !!s.external[threadId]);
  // The agent this thread runs on: its owner, or for a new thread the one picked in this composer.
  const draft = isDraft(threadId);
  const owner = useThread(threadId, (s) => s.owner[threadId]);
  const chosen = useUI((s) => s.drafts[threadId]?.provider);
  const lastAgent = useUI((s) => s.lastAgent);
  const enabled = useEnabledProviders();
  const provider: ProviderId = draft ? pickProvider(enabled, chosen, lastAgent) : (owner ?? "codex");
  const agent = PROVIDERS[provider];
  const needsSignIn = useConn((s) => {
    const c = s.providers[provider];
    return c.status?.state === "running" && c.accountLoaded && !c.account?.account && !!c.account?.requiresOpenaiAuth;
  });
  // What the thread actually runs with, once its engine has said (see hydrateThread).
  const threadAccess = useThread(threadId, (s) => {
    const st = s.live[threadId]?.settings;
    return st ? (st.access ?? PROVIDERS[s.owner[threadId] ?? "codex"].accessOf?.(st.approvalPolicy, st.sandbox) ?? null) : null;
  });
  const threadModel = useThread(threadId, (s) => s.live[threadId]?.settings?.model ?? s.threads[threadId]?.model ?? null);
  const threadEffort = useThread(threadId, (s) => s.live[threadId]?.settings?.effort ?? s.threads[threadId]?.reasoningEffort ?? null);
  // Known once the thread is loaded in the app-server; undefined means "not known yet".
  const threadTier = useThread(threadId, (s) => {
    const st = s.live[threadId]?.settings;
    return st ? (st.serviceTier ?? "default") : undefined;
  });
  const conns = useConn((s) => s.providers);
  const models = conns[provider].models;
  const hasModes = useConn((s) => s.providers[provider].modes.some((m) => m.mode === "plan"));
  const threadMode = useThread(threadId, (s) => s.live[threadId]?.settings?.mode ?? null);
  const configTier = useConn((s) => s.providers[provider].defaults.serviceTier);
  // New threads start from the last-used settings for their agent; existing threads from their own.
  const [over, setOver] = useState<TurnOverrides>(() => overrides.get(threadId) ?? (draft ? lastUsed(provider) : {}));
  const setPrefs = (patch: TurnOverrides) => {
    const next = { ...over, ...patch };
    setOver(next);
    overrides.set(threadId, next);
    if (draft) rememberPrefs(provider, patch);
  };
  /**
   * A new thread picking another agent's model moves to that agent, with its last-used settings
   * and the model picked.
   */
  const switchProvider = (next: ProviderId, model: string) => {
    setDraftProvider(threadId, next);
    rememberPrefs(next, { model, effort: null });
    const prefs = { ...lastUsed(next), mode: over.mode };
    setOver(prefs);
    overrides.set(threadId, prefs);
  };

  useEffect(() => {
    drafts.set(threadId, text);
  }, [threadId, text]);

  // Kept built while another view shows (see Kept), it leaves what's handed to the thread's composer
  // to the one on screen, or picks it up when it's back, as one mounting would.
  const visibility = useVisibility();
  useEffect(() => {
    let was = visibility.shown;
    return visibility.subscribe(() => {
      const shown = visibility.shown;
      if (shown === was) return;
      was = shown;
      if (!shown) return;
      const draft = drafts.get(threadId) ?? "";
      setText((cur) => (cur === draft ? cur : draft));
      const more = takeAttachments(threadId);
      if (more.length) setAttachments((cur) => [...cur, ...more.filter((m) => !cur.some((c) => c.path === m.path))]);
      if (composerFocus.delete(threadId)) focusAtEnd(ta.current);
    });
  }, [visibility, threadId]);

  // Attachments and focus requests from elsewhere (files dropped on the pane).
  useEffect(() => {
    const onAttach = (e: Event) => {
      if ((e as CustomEvent<{ threadId: string }>).detail.threadId !== threadId || !visibility.shown) return;
      const more = takeAttachments(threadId);
      setAttachments((cur) => [...cur, ...more.filter((m) => !cur.some((c) => c.path === m.path))]);
    };
    const onFocus = (e: Event) => {
      if ((e as CustomEvent<{ threadId: string }>).detail.threadId !== threadId || !visibility.shown) return;
      composerFocus.delete(threadId);
      requestAnimationFrame(() => focusAtEnd(ta.current));
    };
    window.addEventListener("ret:composer-attach", onAttach);
    window.addEventListener("ret:composer-focus", onFocus);
    return () => {
      window.removeEventListener("ret:composer-attach", onAttach);
      window.removeEventListener("ret:composer-focus", onFocus);
    };
  }, [threadId]);

  // Text handed to this composer from elsewhere (editing a queued follow-up, forking with a quote).
  useEffect(() => {
    const onFill = (e: Event) => {
      const d = (e as CustomEvent<{ threadId: string; text: string }>).detail;
      if (d.threadId !== threadId || !visibility.shown) return;
      composerFocus.delete(threadId);
      setText((cur) => (cur.trim() ? `${cur}\n${d.text}` : d.text));
      requestAnimationFrame(() => focusAtEnd(ta.current));
    };
    window.addEventListener("ret:composer-fill", onFill);
    return () => window.removeEventListener("ret:composer-fill", onFill);
  }, [threadId]);

  useEffect(() => {
    if (composerFocus.delete(threadId)) focusAtEnd(ta.current);
    else if (autoFocus) ta.current?.focus();
  }, [threadId]); // on appear only, never when the pane merely regains focus

  const submit = async (how: "auto" | "steer" | "queue" = "auto") => {
    const value = text;
    if ((!value.trim() && !attachments.length) || sending || elsewhere) return;
    setSending(true);
    setText("");
    attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    setAttachments([]);
    drafts.delete(threadId);
    try {
      await sendMessage(threadId, value, attachments, effectiveOverrides(), how);
    } catch (err) {
      toast(`Couldn't send: ${(err as Error).message}`, "error");
      setText(value);
    } finally {
      setSending(false);
    }
  };

  // Plan mode: the agent thinks it through, can ask you questions, and proposes a plan before changing anything.
  const planning = (over.mode ?? threadMode) === "plan";
  const togglePlan = () => setPrefs({ mode: planning ? "default" : "plan" });

  // The agent's questions dock on top of the box: number keys pick, and what you type answers "Other".
  // An answer steers the running turn (async questions leave it running), or starts the next one.
  const ask = useQuestionFlow(threadId, {
    send: (answer) =>
      sendMessage(threadId, answer, [], effectiveOverrides(), "steer").catch((err) => {
        toast(`Couldn't send: ${(err as Error).message}`, "error");
        throw err;
      }),
    focusInput: () => requestAnimationFrame(() => focusAtEnd(ta.current)),
  });
  const askSource = ask?.ask.source;
  useEffect(() => {
    // A new question takes the keyboard in the pane you're in, unless you're typing somewhere else.
    const idle = !document.activeElement || document.activeElement === document.body;
    if (askSource && autoFocus && idle) ta.current?.focus();
  }, [askSource]);

  /** Send what's in the box, or, while a question takes a written answer, answer it. */
  const send = (how: "auto" | "steer" | "queue") => {
    if (ask?.takesText && how !== "queue" && text.trim() && !attachments.length) {
      ask.answerText(text.trim());
      setText("");
      return;
    }
    void submit(how);
  };

  // Answers to the agent's questions go out from here, with the settings picked in this composer.
  useEffect(() => {
    const onSend = (e: Event) => {
      const d = (e as CustomEvent<{ threadId: string; text: string; mode?: "plan" | "default"; handled: boolean }>).detail;
      if (d.threadId !== threadId || d.handled || !visibility.shown) return;
      d.handled = true;
      if (d.mode) setPrefs({ mode: d.mode });
      const prefs = { ...effectiveOverrides(), ...(d.mode ? { mode: d.mode } : {}) };
      void sendMessage(threadId, d.text, [], prefs, "auto").catch((err) => toast(`Couldn't send: ${(err as Error).message}`, "error"));
    };
    window.addEventListener("ret:composer-send", onSend);
    return () => window.removeEventListener("ret:composer-send", onSend);
  });

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // An open question: with the box empty, 1–9 pick (until you choose "Other"), arrows move, Enter takes.
    if (ask && !e.ctrlKey && !e.metaKey && !e.altKey && !e.nativeEvent.isComposing && text === "" && !attachments.length) {
      if (!ask.other && /^[1-9]$/.test(e.key) && ask.pick(Number(e.key) - 1)) {
        e.preventDefault();
        return;
      }
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && ask.rows) {
        e.preventDefault();
        ask.move(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && ask.hl != null) {
        e.preventDefault();
        ask.pick(ask.hl);
        return;
      }
      if (e.key === "Escape" && ask.unpick()) {
        e.preventDefault();
        return;
      }
    }
    if (e.key === "Tab" && e.shiftKey && hasModes) {
      // Same as Codex and Claude Code: Shift+Tab switches Plan mode.
      e.preventDefault();
      togglePlan();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // While a turn runs: Enter steers it, Ctrl+Enter queues the message for the next turn.
      send(e.ctrlKey || e.metaKey ? "queue" : running ? "steer" : "auto");
    } else if (e.key === "Escape" && running) {
      e.preventDefault();
      void interrupt(threadId);
    }
  };

  // Pasted files go the same way as dropped ones (dropping is handled by the whole pane).
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (!files.length) return;
    e.preventDefault();
    void addFilesToThread(threadId, files);
  };

  const pickImage = async () => {
    const path = await bridge.dialog.pickFile([{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }]);
    if (path) setAttachments((a) => [...a, { path, name: path.split(/[\\/]/).pop() ?? "image" }]);
  };

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

  /** What gets sent: an unsupported speed becomes an explicit "standard" rather than being dropped silently. */
  function effectiveOverrides(): TurnOverrides {
    const speed = over.speed === undefined ? undefined : supports(over.speed) ? over.speed : "default";
    return { ...over, speed };
  }

  // A new thread lists every agent's models (picking one picks the agent); a thread keeps to its own agent's.
  const pickable = draft ? enabled.filter((p) => p === provider || conns[p].models.length) : [provider];
  const grouped = pickable.length > 1;
  const modelOptions: SelectOption[] = pickable.flatMap((p) => {
    const opts: SelectOption[] = conns[p].models.map((m) => ({ value: modelKey(p, m.id), label: m.displayName || m.id, description: m.description || undefined }));
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
  const effortOptions: SelectOption[] = (modelInfo?.supportedReasoningEfforts ?? []).map((e) => ({
    value: e.reasoningEffort,
    label: titleCase(e.reasoningEffort),
    description: e.description || undefined,
  }));
  if (currentEffort && !effortOptions.some((o) => o.value === currentEffort)) {
    effortOptions.unshift({ value: currentEffort, label: titleCase(currentEffort) });
  }
  const speedOptions: SelectOption[] = [
    { value: "default", label: "Standard", description: "Normal speed and usage", icon: SPEED_ICON.default },
    ...tiers.map((t) => ({ value: t.id, label: t.name, description: t.description, icon: SPEED_ICON[t.id] ?? <Zap size={13} /> })),
  ];

  return (
    <>
    {/* Docked on top, longest-lived first and the next message nearest the box. */}
    <div className="composer-dock">
      <GoalBar threadId={threadId} />
      {!agentsElsewhere && <AgentTray threadId={threadId} />}
      <QueueTray threadId={threadId} />
    </div>
    <div
      className={`composer ${running ? "running" : ""} ${elsewhere ? "elsewhere" : ""} ${compact ? "compact" : ""} ${planning ? "planning" : ""} ${ask ? "asking" : ""}`}
    >
      {ask && <QuestionDock flow={ask} compact={compact} />}
      {elsewhere && (
        <div className="composer-elsewhere">
          <LoaderCircle size={12} className="spin" />
          <span>Running in another {agent.name} app (VS Code, CLI…). Watching live — you can reply once it finishes.</span>
        </div>
      )}
      {needsSignIn && (
        <div className="composer-elsewhere">
          <LogIn size={12} />
          <span>Sign in to {agent.name} to send this.</span>
          <button className="link small" onClick={() => void startLogin(provider)}>
            Sign in
          </button>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((a, i) => (
            <span key={a.path} className="attachment">
              {a.previewUrl ? <img src={a.previewUrl} alt="" /> : <Paperclip size={12} />}
              <span>{a.name}</span>
              <button
                onClick={() => {
                  if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
                  setAttachments(attachments.filter((_, j) => j !== i));
                }}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        rows={1}
        value={text}
        placeholder={
          elsewhere
            ? "Waiting for the other app to finish…"
            : ask
              ? askHint(ask)
            : finishing
              ? "Wrapping up — Enter sends right after this summary  (Esc stops)"
              : running
                ? "Steer the current turn…  (Ctrl+Enter queues for after · Esc stops)"
              : planning
                ? `Plan it with ${agent.name} — it can ask you questions before it changes anything…`
              : isDraft(threadId)
                ? "Describe a task…"
                : "Reply…"
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        spellCheck
      />
      <div className="composer-bar">
        <div className="composer-opts">
          {isDesktop && (
            <button className="icon-btn" title="Attach image" onClick={() => void pickImage()}>
              <Paperclip size={14} />
            </button>
          )}
          {hasModes && (
            <button
              className={`plan-toggle ${planning ? "on" : ""}`}
              title={planning ? `Plan mode is on: ${agent.name} plans, asks you questions, then proposes a plan (Shift+Tab to turn off)` : "Plan mode (Shift+Tab): think it through, ask questions, and propose a plan before changing anything"}
              aria-pressed={planning}
              onClick={togglePlan}
            >
              <ListChecks size={13} />
              <span>Plan</span>
            </button>
          )}
          {modelOptions.length > 0 && (
            <Select
              value={currentModel ? modelKey(provider, currentModel) : ""}
              options={modelOptions}
              onChange={pickModel}
              title={grouped ? "Model (and the agent that runs it)" : `${agent.name} model`}
              menuMinWidth={300}
              className="sel-model"
            />
          )}
          {effortOptions.length > 0 && (
            <Select value={currentEffort ?? ""} options={effortOptions} onChange={(v) => setPrefs({ effort: v })} title="Reasoning effort" menuMinWidth={240} />
          )}
          {tiers.length > 0 && (
            <Select
              value={currentSpeed}
              options={speedOptions}
              onChange={(v) => setPrefs({ speed: v })}
              title="Speed"
              menuMinWidth={260}
              className={`collapsible speed-${currentSpeed}`}
            />
          )}
          <Select
            value={access}
            options={accessOptions(provider)}
            onChange={(v) => setPrefs({ access: v })}
            title={agent.accessLabel}
            menuMinWidth={280}
            className={`collapsible access-${access}`}
          />
        </div>
        {running && !text.trim() ? (
          <button className="send stop" title="Stop (Esc)" onClick={() => void interrupt(threadId)}>
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button className="send" title={finishing ? "Send right after this summary (Enter)" : running ? "Steer the running turn (Enter) · Ctrl+Enter queues for after" : "Send (Enter)"} disabled={elsewhere || needsSignIn || (!text.trim() && !attachments.length)} onClick={(e) => send(e.ctrlKey || e.metaKey ? "queue" : running ? "steer" : "auto")}>
            <ArrowUp size={16} />
          </button>
        )}
      </div>
    </div>
    </>
  );
}
