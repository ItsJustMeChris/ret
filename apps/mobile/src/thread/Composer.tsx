import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import {
  ArrowUp,
  Brain,
  Camera,
  ChevronDown,
  ChevronLeft,
  Gauge,
  Images,
  ListChecks,
  ListPlus,
  LogIn,
  MessageCircleQuestion,
  Plus,
  Rocket,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Square,
  Trash2,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { bridge } from "@ret/bridge";
import { shallowEqual } from "@ret/lib/shallow";
import { discardQueued, interrupt, isWritingFinalAnswer, sendMessage, steerQueued, type Attachment } from "@ret/state/actions";
import { composerDrafts, composerFocus } from "@ret/state/composerDrafts";
import { useComposerSettings, type ComposerSettings, type SettingOption } from "@ret/state/composerSettings";
import { hostName } from "@ret/state/hosts";
import { useQuestionFlow, type QuestionFlow } from "@ret/state/questionFlow";
import { takesDirectInput } from "@ret/state/projects";
import { toast } from "@ret/state/toasts";
import { useThread } from "@ret/state/useThread";
import { fromBase64 } from "../remote/bytes";
import { Markdown } from "../ui/Markdown";
import { Icon, Spinner } from "../ui/primitives";
import { OptionSheet, type SheetOption } from "../ui/Sheet";

const NO_QUEUE: never[] = [];

/** Access choices escalate: default, careful, in-between, everything (the desktop's icons). */
const ACCESS_ICON: Record<string, LucideIcon> = {
  config: Settings2,
  "read-only": ShieldCheck,
  default: ShieldCheck,
  auto: Shield,
  acceptEdits: Shield,
  full: ShieldAlert,
  bypassPermissions: ShieldAlert,
};
const SPEED_ICON: Record<string, LucideIcon> = { default: Gauge, priority: Zap, ultrafast: Rocket };

/** What the model is shown, and sent: the image types the agents take. */
const IMAGE_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

/** An image on its way to the thread: its preview here, and once saved on the computer, its path there. */
type Pending = Attachment & { previewUrl: string; uploading: boolean };

/**
 * The message box, as the desktop's Composer: while the agent works, what you send steers its turn
 * (or waits for the next, if it's writing its final answer); its questions dock on top, picked with
 * a tap, with the box for a written answer. Model, effort, speed, access and Plan mode are the
 * desktop composer's (useComposerSettings); images go to the computer the thread runs on.
 * A new thread (a draft) starts with its first message: `onStarted` hears its id.
 */
export function Composer({ threadId, onStarted }: { threadId: string; onStarted?: (threadId: string) => void }) {
  const input = useRef<TextInput>(null);
  const [text, setText] = useState(() => composerDrafts.get(threadId) ?? "");
  const [images, setImages] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const s = useComposerSettings(threadId);
  const running = useThread(threadId, (st) => !!st.live[threadId]?.activeTurnId);
  const finishing = useThread(threadId, (st) => !!st.live[threadId] && isWritingFinalAnswer(st.live[threadId]));
  const elsewhere = useThread(threadId, (st) => !!st.external[threadId]);
  const direct = useThread(threadId, (st) => takesDirectInput(st.threads[threadId]));
  const queued = useThread(threadId, (st) => st.queued[threadId] ?? NO_QUEUE, shallowEqual);

  // Unsent text survives leaving the thread.
  useEffect(() => {
    if (text) composerDrafts.set(threadId, text);
    else composerDrafts.delete(threadId);
  }, [threadId, text]);

  // Text and focus handed over from elsewhere (editing a queued follow-up, "Keep planning", a resend).
  useEffect(() => {
    const onFill = (e: Event) => {
      const d = (e as CustomEvent<{ threadId: string }>).detail;
      if (d.threadId === threadId) setText(composerDrafts.get(threadId) ?? "");
    };
    const onFocus = (e: Event) => {
      if ((e as CustomEvent<{ threadId: string }>).detail.threadId === threadId) input.current?.focus();
    };
    window.addEventListener("ret:composer-fill", onFill);
    window.addEventListener("ret:composer-focus", onFocus);
    if (composerFocus.delete(threadId)) input.current?.focus();
    return () => {
      window.removeEventListener("ret:composer-fill", onFill);
      window.removeEventListener("ret:composer-focus", onFocus);
    };
  }, [threadId]);

  // Answers and plan actions go out from here, with the settings picked here (as on the desktop).
  useEffect(() => {
    const onSend = (e: Event) => {
      const d = (e as CustomEvent<{ threadId: string; text: string; mode?: "plan" | "default"; handled: boolean }>).detail;
      if (d.threadId !== threadId || d.handled) return;
      d.handled = true;
      if (d.mode) s.setPrefs({ mode: d.mode });
      const prefs = { ...s.effectiveOverrides(), ...(d.mode ? { mode: d.mode } : {}) };
      void sendMessage(threadId, d.text, [], prefs, "auto").catch((err) => toast(`Couldn't send: ${(err as Error).message}`, "error"));
    };
    window.addEventListener("ret:composer-send", onSend);
    return () => window.removeEventListener("ret:composer-send", onSend);
  });

  const ask = useQuestionFlow(threadId, {
    send: (answer) =>
      sendMessage(threadId, answer, [], s.effectiveOverrides(), "steer").catch((err) => {
        toast(`Couldn't send: ${(err as Error).message}`, "error");
        throw err;
      }),
    focusInput: () => input.current?.focus(),
  });

  /** Pictures from the library or the camera, saved on the thread's computer (the agent reads them there). */
  const attach = async (from: "library" | "camera") => {
    const host = s.host;
    if (!host) return;
    const options: ImagePicker.ImagePickerOptions = {
      mediaTypes: ["images"],
      base64: true,
      quality: 0.85,
      exif: false,
      // HEIC comes out as JPEG, which the agents take.
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    };
    let result: ImagePicker.ImagePickerResult;
    if (from === "camera") {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return toast("Ret needs the camera for that: allow it in Settings", "error");
      result = await ImagePicker.launchCameraAsync(options);
    } else {
      result = await ImagePicker.launchImageLibraryAsync({ ...options, allowsMultipleSelection: true, selectionLimit: 6 });
    }
    if (result.canceled) return;
    for (const asset of result.assets) {
      const ext = IMAGE_EXT[asset.mimeType ?? ""] ?? (asset.uri.match(/\.(png|gif|webp)$/i)?.[1]?.toLowerCase() || "jpg");
      const name = asset.fileName ?? `image.${ext}`;
      if (!asset.base64) continue;
      const pending: Pending = { path: "", name, previewUrl: asset.uri, uploading: true };
      setImages((cur) => [...cur, pending]);
      const bytes = fromBase64(asset.base64);
      bridge.files.saveImage(bytes.buffer as ArrayBuffer, ext, host).then(
        (path) => setImages((cur) => cur.map((i) => (i === pending ? { ...i, path, uploading: false } : i))),
        (err: Error) => {
          setImages((cur) => cur.filter((i) => i !== pending));
          toast(`Couldn't send ${name} to ${hostName(host)}: ${err.message}`, "error");
        },
      );
    }
  };

  const submit = async () => {
    const value = text.trim();
    if ((!value && !images.length) || sending || elsewhere || images.some((i) => i.uploading)) return;
    // An open question that takes a written answer: what's typed answers it.
    if (ask?.takesText && value && !images.length) {
      ask.answerText(value);
      setText("");
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const attachments: Attachment[] = images.map(({ path, name }) => ({ path, name }));
    setSending(true);
    setText("");
    setImages([]);
    composerDrafts.delete(threadId);
    try {
      // While a turn runs, a message steers it (or, as it's finishing, waits for the next turn).
      const id = await sendMessage(threadId, value, attachments, s.effectiveOverrides(), running ? "steer" : "auto");
      if (id !== threadId) onStarted?.(id);
    } catch (err) {
      toast(`Couldn't send: ${(err as Error).message}`, "error");
      setText(value);
      setImages(images);
    } finally {
      setSending(false);
    }
  };

  if (!direct) {
    return (
      <View className="mx-3 mb-2 rounded-xl border border-line bg-bg-1 px-4 py-3">
        <Text className="text-[14px] text-text-3">This agent takes its instructions from the thread that started it.</Text>
      </View>
    );
  }

  const uploading = images.some((i) => i.uploading);
  const canSend = (!!text.trim() || images.length > 0) && !sending && !elsewhere && !s.needsSignIn && !uploading;
  const placeholder = elsewhere
    ? "Waiting for the other app to finish…"
    : ask
      ? ask.takesText
        ? "Or type your answer…"
        : "Reply…"
      : finishing
        ? "Wrapping up — sends right after this summary"
        : running
          ? `Steer ${s.agent.name}…`
          : s.planning
            ? `Plan it with ${s.agent.name}…`
            : s.draft
              ? `Describe a task for ${s.agent.name}…`
              : "Reply…";
  const accessLabel = s.accessOptions.find((o) => o.value === s.access)?.label ?? "Access";
  const effortLabel = s.effortOptions.find((o) => o.value === s.effort)?.label;

  return (
    <View className="gap-1.5 px-3 pb-2 pt-1.5">
      {queued.length > 0 && (
        <View className="gap-1">
          {queued.map((q) => (
            <View key={q.id} className="flex-row items-center gap-2 rounded-lg border border-line bg-bg-1 px-3 py-2">
              <Icon icon={ListPlus} size={13} colorClassName="accent-text-3" />
              <Text numberOfLines={2} className="flex-1 text-[13px] text-text-2">
                {q.text}
              </Text>
              <Pressable hitSlop={8} onPress={() => steerQueued(threadId, q.id)} accessibilityLabel="Send now">
                <Icon icon={Zap} size={15} colorClassName="accent-accent" />
              </Pressable>
              <Pressable hitSlop={8} onPress={() => discardQueued(threadId, q.id)} accessibilityLabel="Discard">
                <Icon icon={Trash2} size={15} colorClassName="accent-text-3" />
              </Pressable>
            </View>
          ))}
        </View>
      )}
      <View
        className={`overflow-hidden rounded-[18px] border bg-bg-2 ${ask || s.planning ? "border-accent/50" : running || elsewhere ? "border-green/35" : "border-line-2"}`}
      >
        {ask && <QuestionDock flow={ask} />}
        {s.needsSignIn && (
          <View className="flex-row items-center gap-2 border-b border-line px-4 py-2.5">
            <Icon icon={LogIn} size={13} colorClassName="accent-amber" />
            <Text className="flex-1 text-[13px] text-amber">
              Sign in to {s.agent.name}
              {s.host ? ` on ${hostName(s.host)}` : ""} to send this.
            </Text>
          </View>
        )}
        {images.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 px-3 pt-3">
            {images.map((img, i) => (
              <View key={img.previewUrl + i}>
                <Image source={{ uri: img.previewUrl }} className="h-16 w-16 rounded-lg border border-line-2" />
                {img.uploading && (
                  <View className="absolute inset-0 items-center justify-center rounded-lg bg-black/40">
                    <Spinner size="small" colorClassName="accent-white" />
                  </View>
                )}
                <Pressable
                  onPress={() => setImages((cur) => cur.filter((x) => x !== img))}
                  hitSlop={8}
                  accessibilityLabel="Remove image"
                  className="absolute -right-1.5 -top-1.5 h-5 w-5 items-center justify-center rounded-full border border-line-2 bg-bg-3"
                >
                  <Icon icon={X} size={11} colorClassName="accent-text" />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}
        <TextInput
          ref={input}
          multiline
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColorClassName="accent-text-3"
          editable={!elsewhere}
          className="max-h-36 min-h-[40px] px-4 pb-1 pt-2.5 text-[16px] leading-[21px] text-text"
          selectionColorClassName="accent-accent"
          textAlignVertical="top"
        />
        <View className="flex-row items-center gap-1.5 pb-1.5 pl-1.5 pr-1.5">
          <Pressable onPress={() => setSheet("attach")} accessibilityLabel="Add an image" hitSlop={6} className="h-8 w-8 items-center justify-center rounded-full active:bg-bg-4">
            <Icon icon={Plus} size={19} colorClassName="accent-text-2" />
          </Pressable>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-1" contentContainerClassName="items-center gap-1.5 pr-1">
            {/* As on the desktop, Plan only shows while it's on: to say so, and to turn it off. */}
            {s.planning && <Chip icon={ListChecks} label="Plan" on onPress={s.togglePlan} />}
            {s.modelOptions.length > 0 && <Chip label={[s.modelLabel, effortLabel].filter(Boolean).join(" · ") || "Model"} onPress={() => setSheet("model")} menu />}
            {s.speedOptions.length > 0 && s.speed !== "default" && (
              <Chip icon={SPEED_ICON[s.speed] ?? Zap} label={s.speedOptions.find((o) => o.value === s.speed)?.label ?? s.speed} onPress={() => setSheet("speed")} menu />
            )}
            <Chip icon={ACCESS_ICON[s.access] ?? Shield} label={accessLabel} onPress={() => setSheet("access")} menu tone={s.access === "full" || s.access === "bypassPermissions" ? "danger" : undefined} />
          </ScrollView>
          {running && !text.trim() && !images.length ? (
            <Pressable
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                void interrupt(threadId);
              }}
              accessibilityLabel="Stop"
              className="h-9 w-9 items-center justify-center rounded-full bg-text active:opacity-80"
            >
              <Icon icon={Square} size={13} colorClassName="accent-bg" />
            </Pressable>
          ) : (
            <Pressable
              onPress={() => void submit()}
              disabled={!canSend}
              accessibilityLabel={ask?.takesText ? "Answer" : running ? "Steer" : "Send"}
              className={`h-9 w-9 items-center justify-center rounded-full ${canSend ? "bg-accent active:bg-accent-strong" : "bg-bg-4"}`}
            >
              <Icon icon={ArrowUp} size={18} strokeWidth={2.5} colorClassName={canSend ? "accent-[#0b0b18]" : "accent-text-3"} />
            </Pressable>
          )}
        </View>
      </View>
      <SettingSheets which={sheet} setWhich={setSheet} s={s} attach={(from) => void attach(from)} />
    </View>
  );
}

/** A setting in the composer's bar: what it is now; tap to change it. */
function Chip({ icon, label, onPress, on, menu, tone }: { icon?: LucideIcon; label: string; onPress: () => void; on?: boolean; menu?: boolean; tone?: "danger" }) {
  const fg = on ? "text-accent" : tone === "danger" ? "text-red" : "text-text-2";
  const accent = on ? "accent-accent" : tone === "danger" ? "accent-red" : "accent-text-2";
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      className={`h-8 flex-row items-center gap-1 rounded-full border px-2.5 active:bg-bg-4 ${on ? "border-accent/50 bg-accent-soft" : "border-line bg-bg-3"}`}
    >
      {icon && <Icon icon={icon} size={13} colorClassName={accent} />}
      <Text numberOfLines={1} className={`max-w-[150px] text-[13px] ${fg}`}>
        {label}
      </Text>
      {menu && <Icon icon={ChevronDown} size={12} colorClassName="accent-text-3" />}
    </Pressable>
  );
}

const asSheet = (o: SettingOption, icon?: LucideIcon): SheetOption => ({ value: o.value, label: o.label, description: o.description, group: o.group, icon });

type SheetName = "attach" | "model" | "effort" | "speed" | "access";

function SettingSheets({ which, setWhich, s, attach }: { which: SheetName | null; setWhich: (w: SheetName | null) => void; s: ComposerSettings; attach: (from: "library" | "camera") => void }) {
  const close = () => setWhich(null);
  // One sheet at a time: the next opens once the last has slid away.
  const then = (next: SheetName) => setTimeout(() => setWhich(next), 400);
  return (
    <>
      <OptionSheet
        open={which === "attach"}
        onClose={close}
        title="Add an image"
        options={[
          { value: "library", label: "Photo library", icon: Images },
          { value: "camera", label: "Take a photo", icon: Camera },
        ]}
        // The picker can only come up once this sheet has gone.
        onPick={(v) => setTimeout(() => attach(v as "library" | "camera"), 450)}
      />
      <OptionSheet
        open={which === "model"}
        onClose={close}
        title={s.modelsGrouped ? "Model and agent" : `${s.agent.name} model`}
        options={[
          ...s.modelOptions.map((o) => asSheet(o)),
          // Effort and speed live with the model they're for.
          ...(s.effortOptions.length ? [{ value: "::effort", label: "Reasoning effort", description: s.effortOptions.find((o) => o.value === s.effort)?.label, icon: Brain, tone: "accent" as const, group: "More" }] : []),
          ...(s.speedOptions.length ? [{ value: "::speed", label: "Speed", description: s.speedOptions.find((o) => o.value === s.speed)?.label, icon: Zap, tone: "accent" as const, group: "More" }] : []),
        ]}
        value={s.model}
        onPick={(v) => {
          if (v === "::effort") then("effort");
          else if (v === "::speed") then("speed");
          else s.pickModel(v);
        }}
      />
      <OptionSheet open={which === "effort"} onClose={close} title="Reasoning effort" options={s.effortOptions.map((o) => asSheet(o))} value={s.effort} onPick={(v) => s.setPrefs({ effort: v })} />
      <OptionSheet open={which === "speed"} onClose={close} title="Speed" options={s.speedOptions.map((o) => asSheet(o, SPEED_ICON[o.value] ?? Zap))} value={s.speed} onPick={(v) => s.setPrefs({ speed: v })} />
      <OptionSheet open={which === "access"} onClose={close} title={s.agent.accessLabel} options={s.accessOptions.map((o) => asSheet(o, ACCESS_ICON[o.value] ?? Shield))} value={s.access} onPick={(v) => s.setPrefs({ access: v })} />
    </>
  );
}

/** The agent's question, docked on top of the box: tap a choice, or "Other…" to write one. */
function QuestionDock({ flow }: { flow: QuestionFlow }) {
  const { ask, q, step, total, agent: name } = flow;
  const meanwhile = ask.kind === "request" ? !ask.blocking : flow.running;
  return (
    <View className="gap-2 border-b border-line bg-accent-soft px-3.5 pb-3 pt-2.5">
      <View className="flex-row items-center gap-1.5">
        <Icon icon={MessageCircleQuestion} size={14} colorClassName="accent-accent" />
        <Text className="text-[13px] font-semibold text-accent">{name} is asking</Text>
        {total > 1 && (
          <Text className="text-[12px] text-text-3">
            {step + 1} of {total}
          </Text>
        )}
        {q.header ? (
          <View className="rounded bg-bg-3 px-1.5">
            <Text className="text-[11px] text-text-2">{q.header}</Text>
          </View>
        ) : null}
        <View className="flex-1" />
        {step > 0 && (
          <Pressable onPress={flow.back} hitSlop={8} className="flex-row items-center">
            <Icon icon={ChevronLeft} size={13} colorClassName="accent-text-2" />
            <Text className="text-[13px] text-text-2">Back</Text>
          </Pressable>
        )}
        <Pressable onPress={flow.skip} hitSlop={10} className="pl-2" accessibilityLabel={ask.kind === "request" ? "Skip" : "Close"}>
          {ask.kind === "request" ? <Text className="text-[13px] text-text-2">Skip</Text> : <Icon icon={X} size={15} colorClassName="accent-text-2" />}
        </Pressable>
      </View>
      {meanwhile && <Text className="text-[12px] text-text-3">{name} keeps working meanwhile.</Text>}
      <Markdown text={q.text} />
      {q.options.length > 0 && (
        <View className="gap-1.5">
          {q.options.map((o, i) => (
            <Pressable
              key={i}
              onPress={() => {
                void Haptics.selectionAsync();
                flow.pick(i);
              }}
              className={`min-h-[44px] flex-row items-center gap-2.5 rounded-[10px] border px-2.5 py-2 active:border-accent/55 active:bg-accent-soft ${flow.previous === o.label ? "border-accent/40 bg-bg-2" : "border-line bg-bg-2"}`}
            >
              <View className="h-[22px] min-w-[22px] items-center justify-center rounded-md border border-line-2 bg-bg-3">
                <Text className="text-[11px] text-text-2">{i + 1}</Text>
              </View>
              <View className="flex-1 gap-0.5">
                <Text className="text-[15px] text-text">{o.label}</Text>
                {o.description ? <Text className="text-[12.5px] text-text-3">{o.description}</Text> : null}
              </View>
            </Pressable>
          ))}
          {flow.otherRow && (
            <Pressable
              onPress={() => flow.pick(q.options.length)}
              className={`min-h-[44px] flex-row items-center gap-2.5 rounded-[10px] border px-2.5 py-2 ${flow.other ? "border-dashed border-accent/55 bg-bg-2" : "border-line bg-bg-2"}`}
            >
              <View className="h-[22px] min-w-[22px] items-center justify-center rounded-md border border-line-2 bg-bg-3">
                <Text className="text-[11px] text-text-2">{q.options.length + 1}</Text>
              </View>
              <Text className={`flex-1 text-[15px] ${flow.other ? "text-accent" : "text-text-2"}`}>{flow.other ? "Type your answer below" : "Other…"}</Text>
            </Pressable>
          )}
        </View>
      )}
      {q.secret && <SecretAnswer key={q.id} onSubmit={flow.answerText} />}
    </View>
  );
}

/** Secret answers stay out of the composer (and its saved drafts). */
function SecretAnswer({ onSubmit }: { onSubmit: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <TextInput
      secureTextEntry
      autoFocus
      value={value}
      onChangeText={setValue}
      onSubmitEditing={() => value && onSubmit(value)}
      placeholder="Your answer (hidden)"
      placeholderTextColorClassName="accent-text-3"
      returnKeyType="send"
      className="h-11 rounded-lg border border-line bg-bg-2 px-3 text-[16px] text-text"
    />
  );
}
