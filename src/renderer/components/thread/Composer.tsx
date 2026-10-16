import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ListChecks, LoaderCircle, LogIn, Paperclip, Settings2, Shield, ShieldAlert, ShieldCheck, Square, X } from "lucide-react";
import { useThread } from "../../state/useThread";
import { isDraft } from "../../state/ui";
import { hostName } from "../../state/hosts";
import { interrupt, isWritingFinalAnswer, loadOlder, sendMessage, startLogin, type Attachment } from "../../state/actions";
import { sentMessages } from "../../state/composerHistory";
import { bridge, isDesktop } from "../../bridge";
import { toast } from "../../state/toasts";
import { Select } from "../ui/Select";
import { DynamicIsland } from "./DynamicIsland";
import { ModelTuner } from "./ModelTuner";
import { composerDrafts as drafts, composerFocus, takeAttachments } from "../../state/composerDrafts";
import { addFilesToThread } from "../../state/attach";
import { QuestionDock } from "./QuestionDock";
import { useQuestionFlow, type QuestionFlow } from "../../state/questionFlow";
import { useComposerSettings } from "../../state/composerSettings";
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

/** Focus a textarea with the caret after its text, ready to keep typing. */
function focusAtEnd(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
  el.scrollTop = el.scrollHeight;
}

/** Going back through what you've sent with ↑/↓: the messages (newest first) and which one's in the box. */
interface Recall {
  list: string[];
  /** Older turns not loaded yet could add to it. */
  more: boolean;
  at: number;
  /** Which way the last step went: 1 back in time, -1 forward. */
  dir: 1 | -1;
  /** Steps that hit the oldest (each nudges the pill). */
  bumps: number;
  /** Stepped out of it (the pill is on its way out). */
  leaving?: boolean;
}

/** Where you are in what you've sent, on the box's top edge: the number rolls as you step, and it nudges at the oldest. */
function RecallPill({ recall, onGone }: { recall: Recall; onGone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (recall.bumps) ref.current?.animate([{ transform: "none" }, { transform: "translateY(-3px)" }, { transform: "none" }], { duration: 200, easing: "ease-out" });
  }, [recall.bumps]);
  const n = recall.list.length;
  return (
    <div
      ref={ref}
      className={`recall-pill ${recall.leaving ? "leaving" : ""}`}
      title="↑ older · ↓ newer · Esc puts back an empty box"
      aria-live="polite"
      onAnimationEnd={(e) => e.animationName === "recall-out" && onGone()}
    >
      <span className="recall-track" style={{ "--p": n > 1 ? recall.at / (n - 1) : 1 } as React.CSSProperties}>
        <span className="recall-thumb" />
      </span>
      <span className="recall-num">
        <span key={recall.at} className="recall-pos" data-dir={recall.dir}>
          {recall.at + 1}
        </span>
      </span>
      <span className="recall-of">
        of {n}
        {recall.more ? "+" : ""}
      </span>
    </div>
  );
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
  agentsListed,
}: {
  threadId: string;
  autoFocus?: boolean;
  compact?: boolean;
  /** The thread's subagents are on screen already (the details panel), so the Dynamic Island leaves them out. */
  agentsListed?: boolean;
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
  const settings = useComposerSettings(threadId);
  const { host, provider, agent, needsSignIn, hasModes, planning, togglePlan, setPrefs, effectiveOverrides } = settings;

  useEffect(() => {
    drafts.set(threadId, text);
  }, [threadId, text]);

  // ↑ in an empty box brings back what you sent last; more ↑ go further back, ↓ comes forward again.
  const [recall, setRecall] = useState<Recall | null>(null);
  const recalling = recall && !recall.leaving && text === recall.list[recall.at] ? recall : null;
  // Edited, sent or cleared: it's yours now, and the pill goes.
  useEffect(() => {
    if (recall && !recall.leaving && !recalling) setRecall({ ...recall, leaving: true });
  }, [recall, recalling]);
  /** Once the box shows a recalled message, the caret goes after it, ready to add to it. */
  const caretToEnd = useRef(false);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el || !caretToEnd.current) return;
    caretToEnd.current = false;
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollTop = el.scrollHeight;
  }, [text, recall]);
  const showRecalled = (next: Recall) => {
    caretToEnd.current = true;
    setText(next.list[next.at]);
    setRecall(next);
  };
  /** One step back (1) or forward (-1) through what you've sent. False when the key should move the caret as usual. */
  const stepRecall = (dir: 1 | -1, el: HTMLTextAreaElement): boolean => {
    if (el.selectionStart !== el.selectionEnd) return false;
    if (!recalling) {
      // Only from an empty box: in something you're writing, ↑ moves the caret.
      if (dir === -1 || text !== "") return false;
      const { list, more } = sentMessages(threadId);
      if (!list.length) return false;
      showRecalled({ list, more, at: 0, dir, bumps: 0 });
      return true;
    }
    // With the caret where recalling left it (the end), ↑ goes on back; moved into a message of
    // several lines, the arrows go through its lines first.
    const parked = el.selectionStart === text.length;
    if (dir === 1 ? !parked && text.slice(0, el.selectionStart).includes("\n") : text.slice(el.selectionEnd).includes("\n")) return false;
    const at = recalling.at + dir;
    if (at < 0) setText("");
    else if (at < recalling.list.length) showRecalled({ ...recalling, at, dir });
    else {
      setRecall({ ...recalling, bumps: recalling.bumps + 1 });
      // The oldest loaded: fetch older turns, and the next ↑ goes on into them.
      if (recalling.more) {
        void loadOlder(threadId).then(() => {
          const { list, more } = sentMessages(threadId);
          setRecall((r) => (r && !r.leaving ? { ...r, list, more } : r));
        });
      }
    }
    return true;
  };

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
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.nativeEvent.isComposing) {
      if (stepRecall(e.key === "ArrowUp" ? 1 : -1, e.currentTarget)) {
        e.preventDefault();
        return;
      }
    }
    if (e.key === "Escape" && recalling) {
      // Back to the empty box you started from (before Esc would stop a running turn).
      e.preventDefault();
      setText("");
      return;
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

  return (
    <>
    {/* Another thread's is another island, not this one changing. */}
    <DynamicIsland key={threadId} threadId={threadId} compact={compact} agentsListed={agentsListed} />
    <div
      className={`composer ${running ? "running" : ""} ${elsewhere ? "elsewhere" : ""} ${compact ? "compact" : ""} ${planning ? "planning" : ""} ${ask ? "asking" : ""}`}
    >
      {recall && (
        <div className="recall-anchor">
          <RecallPill recall={recall} onGone={() => setRecall((r) => (r?.leaving ? null : r))} />
        </div>
      )}
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
          {host ? (
            // Signing in happens where the agent runs.
            <span>
              Sign in to {agent.name} on {hostName(host)} to send this.
            </span>
          ) : (
            <>
              <span>Sign in to {agent.name} to send this.</span>
              <button className="link small" onClick={() => void startLogin(provider)}>
                Sign in
              </button>
            </>
          )}
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
        // Gone elsewhere: what's recalled stays in the box, as a draft. The pill goes at once, as the
        // view may be going hidden, where an exit animation would never end.
        onBlur={() => setRecall(null)}
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
          {/* Plan mode is Shift+Tab; the pill only shows while it's on, to say so and to turn it off. */}
          {planning && (
            <button
              className="plan-toggle on"
              title={`Plan mode is on: ${agent.name} plans, asks you questions, then proposes a plan. Click or Shift+Tab to turn it off`}
              aria-pressed
              onClick={togglePlan}
            >
              <ListChecks size={13} />
              <span>Plan</span>
            </button>
          )}
          {settings.modelOptions.length > 0 && <ModelTuner settings={settings} />}
          <Select
            value={settings.access}
            options={settings.accessOptions.map((o) => ({ ...o, icon: ACCESS_ICON[o.value] ?? <Shield size={13} /> }))}
            onChange={(v) => setPrefs({ access: v })}
            title={agent.accessLabel}
            menuMinWidth={280}
            className={`collapsible access-${settings.access}`}
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
