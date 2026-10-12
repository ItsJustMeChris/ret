import { useEffect, useRef, useState } from "react";
import { ArrowUp, Gauge, LoaderCircle, Paperclip, Rocket, Settings2, Shield, ShieldAlert, ShieldCheck, Square, X, Zap } from "lucide-react";
import { useThreads } from "../../state/threads";
import { useUI, isDraft, type AccessPreset } from "../../state/ui";
import { useConn } from "../../state/conn";
import { interrupt, isWritingFinalAnswer, sendMessage, type Attachment, type TurnOverrides } from "../../state/actions";
import { bridge, isDesktop } from "../../bridge";
import { toast } from "../../state/toasts";
import { Select, type SelectOption } from "../ui/Select";
import { QueueTray } from "./QueueTray";

const ACCESS_OPTIONS: SelectOption<AccessPreset>[] = [
  { value: "config", label: "Config default", description: "Whatever your config.toml sets", icon: <Settings2 size={13} /> },
  { value: "read-only", label: "Read only", description: "Reads files; asks before changing anything", icon: <ShieldCheck size={13} /> },
  { value: "auto", label: "Workspace", description: "Edits inside the project; asks for anything else", icon: <Shield size={13} /> },
  { value: "full", label: "Full access", description: "No sandbox and no approval prompts", icon: <ShieldAlert size={13} /> },
];

const SPEED_ICON: Record<string, React.ReactNode> = {
  default: <Gauge size={13} />,
  priority: <Zap size={13} />,
  ultrafast: <Rocket size={13} />,
};

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Per-thread unsent text and setting overrides survive switching tabs/windows. */
const drafts = new Map<string, string>();
const overrides = new Map<string, TurnOverrides>();

export function Composer({ threadId, autoFocus, compact }: { threadId: string; autoFocus?: boolean; compact?: boolean }) {
  const [text, setText] = useState(() => drafts.get(threadId) ?? "");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const running = useThreads((s) => !!s.live[threadId]?.activeTurnId);
  // Final summary streaming: Enter now means "send right after it finishes" (a steer would be dropped).
  const finishing = useThreads((s) => {
    const lt = s.live[threadId];
    return !!lt?.activeTurnId && isWritingFinalAnswer(lt);
  });
  // Another Codex process owns the current turn; writing to the same thread from here could corrupt it.
  const elsewhere = useThreads((s) => !!s.external[threadId]);
  const threadModel = useThreads((s) => s.live[threadId]?.settings?.model ?? s.threads[threadId]?.model ?? null);
  const threadEffort = useThreads((s) => s.live[threadId]?.settings?.effort ?? s.threads[threadId]?.reasoningEffort ?? null);
  // Known once the thread is loaded in the app-server; undefined means "not known yet".
  const threadTier = useThreads((s) => {
    const st = s.live[threadId]?.settings;
    return st ? (st.serviceTier ?? "default") : undefined;
  });
  const defaults = useUI((s) => s.composer);
  const models = useConn((s) => s.models);
  const configTier = useConn((s) => s.defaults.serviceTier);
  // New threads start from the last-used defaults; existing threads from their own settings.
  const [over, setOver] = useState<TurnOverrides>(
    () =>
      overrides.get(threadId) ??
      (isDraft(threadId) ? { model: defaults.model, effort: defaults.effort, access: defaults.access, speed: defaults.speed } : {}),
  );
  const setPrefs = (patch: TurnOverrides) => {
    const next = { ...over, ...patch };
    setOver(next);
    overrides.set(threadId, next);
    if (isDraft(threadId)) useUI.setState((s) => ({ composer: { ...s.composer, ...patch } }));
  };

  useEffect(() => {
    drafts.set(threadId, text);
  }, [threadId, text]);

  // "Edit" on a queued follow-up hands its text back to this composer.
  useEffect(() => {
    const onFill = (e: Event) => {
      const d = (e as CustomEvent<{ threadId: string; text: string }>).detail;
      if (d.threadId !== threadId) return;
      setText((cur) => (cur.trim() ? `${cur}\n${d.text}` : d.text));
      ta.current?.focus();
    };
    window.addEventListener("ret:composer-fill", onFill);
    return () => window.removeEventListener("ret:composer-fill", onFill);
  }, [threadId]);

  useEffect(() => {
    if (autoFocus) ta.current?.focus();
  }, [threadId]); // on appear only, never when the pane merely regains focus

  // Auto-size the textarea.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [text]);

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

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // While a turn runs: Enter steers it, Ctrl+Enter queues the message for the next turn.
      void submit(e.ctrlKey || e.metaKey ? "queue" : running ? "steer" : "auto");
    } else if (e.key === "Escape" && running) {
      e.preventDefault();
      void interrupt(threadId);
    }
  };

  const addImage = async (file: File) => {
    if (!isDesktop) return;
    const ext = file.type.split("/")[1] || "png";
    const path = await bridge.files.saveImage(await file.arrayBuffer(), ext);
    setAttachments((a) => [...a, { path, name: file.name || `image.${ext}`, previewUrl: URL.createObjectURL(file) }]);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    files.forEach((f) => void addImage(f));
  };

  const onDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    files.forEach((f) => void addImage(f));
  };

  const pickImage = async () => {
    const path = await bridge.dialog.pickFile([{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }]);
    if (path) setAttachments((a) => [...a, { path, name: path.split(/[\\/]/).pop() ?? "image" }]);
  };

  const defaultModel = models.find((m) => m.isDefault);
  const currentModel = over.model ?? threadModel ?? defaultModel?.id ?? null;
  const modelInfo = models.find((m) => m.id === currentModel || m.model === currentModel);
  const currentEffort = over.effort ?? threadEffort ?? modelInfo?.defaultReasoningEffort ?? null;
  const access = over.access ?? "config";

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

  const modelOptions: SelectOption[] = models.map((m) => ({
    value: m.id,
    label: m.displayName || m.id,
    description: m.description || undefined,
  }));
  if (currentModel && !modelInfo) modelOptions.unshift({ value: currentModel, label: currentModel });
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
    <QueueTray threadId={threadId} />
    <div
      className={`composer ${running ? "running" : ""} ${elsewhere ? "elsewhere" : ""} ${compact ? "compact" : ""}`}
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      {elsewhere && (
        <div className="composer-elsewhere">
          <LoaderCircle size={12} className="spin" />
          <span>Running in another Codex app (VS Code, CLI…). Watching live — you can reply once it finishes.</span>
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
            : finishing
              ? "Wrapping up — Enter sends right after this summary  (Esc stops)"
              : running
                ? "Steer the current turn…  (Ctrl+Enter queues for after · Esc stops)"
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
          {modelOptions.length > 0 && (
            <Select
              value={currentModel ?? ""}
              options={modelOptions}
              onChange={(v) => setPrefs({ model: v, effort: null })}
              title="Model"
              menuMinWidth={280}
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
            options={ACCESS_OPTIONS}
            onChange={(v) => setPrefs({ access: v })}
            title="Sandbox & approvals"
            menuMinWidth={280}
            className={`collapsible access-${access}`}
          />
        </div>
        {running && !text.trim() ? (
          <button className="send stop" title="Stop (Esc)" onClick={() => void interrupt(threadId)}>
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button className="send" title={finishing ? "Send right after this summary (Enter)" : running ? "Steer the running turn (Enter) · Ctrl+Enter queues for after" : "Send (Enter)"} disabled={elsewhere || (!text.trim() && !attachments.length)} onClick={(e) => void submit(e.ctrlKey || e.metaKey ? "queue" : running ? "steer" : "auto")}>
            <ArrowUp size={16} />
          </button>
        )}
      </div>
    </div>
    </>
  );
}
