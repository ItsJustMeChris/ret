import { useState } from "react";
import { create } from "zustand";
import { ChevronLeft, CornerDownLeft, MessageCircleQuestion, X } from "lucide-react";
import { ownerOf, type ThreadsState } from "../../state/threads";
import { useThread } from "../../state/useThread";
import { shallowEqual } from "../../lib/shallow";
import { agentOf } from "../../agents";
import { respondToRequest } from "../../state/actions";
import { Markdown } from "../Markdown";

/** One question as the dock shows it, whichever way the agent asked it. */
interface DockQuestion {
  id: string;
  header: string | null;
  text: string;
  options: { label: string; description: string | null }[];
  /** A written answer is allowed (typed in the composer, or in the secret field). */
  other: boolean;
  secret: boolean;
  /** How Codex names a request_user_input_async question when it's answered; null for others. */
  replyId: string | null;
}

/**
 * What Codex is waiting on: a request_user_input call (Plan mode; the turn may be blocked on it),
 * or questions on a message (request_user_input_async, or a reply that ended with questions),
 * which are answered with your next message.
 */
type Ask =
  | { kind: "request"; source: string; key: string; blocking: boolean; questions: DockQuestion[] }
  | { kind: "reply"; source: string; itemIds: string[]; questions: DockQuestion[] };

/** Message questions you closed without answering, by item id. They stay in the transcript. */
const useDismissed = create<Record<string, true>>(() => ({}));

export function reopenQuestion(itemId: string) {
  useDismissed.setState((s) => {
    const next = { ...s };
    delete next[itemId];
    return next;
  }, true);
}

export const useQuestionDismissed = (itemId: string) => useDismissed((s) => !!s[itemId]);

/**
 * Messages with questions still waiting for you: in the latest turn, with nothing from you since.
 * Async questions arrive while the turn keeps running, so a running turn doesn't close them; your
 * next message does (sent or steered, it lands after them).
 */
export function openQuestionItems(s: ThreadsState, threadId: string): string[] {
  const lt = s.live[threadId];
  if (!lt || s.external[threadId]) return [];
  const turn = lt.turns[lt.turnOrder[lt.turnOrder.length - 1]];
  const ids: string[] = [];
  for (const id of turn?.itemIds ?? []) {
    const it = lt.items[id];
    if (it?.type === "userMessage") ids.length = 0;
    else if (it?.type === "agentMessage" && it.questions?.length) ids.push(id);
  }
  return ids;
}

function useOpenAsk(threadId: string): Ask | null {
  const req = useThread(threadId, (s) => Object.values(s.requests).find((r) => r.threadId === threadId && r.method === "item/tool/requestUserInput"));
  const dismissed = useDismissed();
  const ids = useThread(threadId, (s) => openQuestionItems(s, threadId), shallowEqual).filter((id) => !dismissed[id]);
  const items = useThread(threadId, (s) => ids.map((id) => s.live[threadId]?.items[id]), shallowEqual);

  if (req) {
    const qs: { id: string; header: string; question: string; isOther: boolean; isSecret: boolean; options: { label: string; description: string }[] | null }[] =
      req.params.questions ?? [];
    if (qs.length) {
      return {
        kind: "request",
        source: req.key,
        key: req.key,
        blocking: req.params.isBlocking !== false,
        questions: qs.map((q) => ({
          id: q.id,
          header: q.header || null,
          text: q.question,
          options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description || null })),
          other: q.isOther || !q.options?.length,
          secret: q.isSecret,
          replyId: null,
        })),
      };
    }
  }
  const questions = items.flatMap((it) =>
    it?.type === "agentMessage"
      ? (it.questions ?? []).map((q, i) => ({
          id: `${it.id}:${i}`,
          header: null,
          text: q.title,
          options: (q.options ?? []).map((label) => ({ label, description: null })),
          other: true,
          secret: false,
          // The message is the tool call itself (its id is the call's).
          replyId: it.delivery === "async" ? JSON.stringify(["request_user_input_async", it.id, i]) : null,
        }))
      : [],
  );
  if (!questions.length) return null;
  return { kind: "reply", source: ids.join(","), itemIds: ids, questions };
}

interface FlowState {
  source: string | null;
  step: number;
  answers: string[];
  /** Option row picked out with the arrow keys (Enter takes it). */
  hl: number | null;
  /** "Other" chosen: digits type again, and the box is where the answer goes. */
  other: boolean;
  /** Answer on its way; the dock steps aside until your message lands. */
  sent: boolean;
}

const fresh = (source: string | null): FlowState => ({ source, step: 0, answers: [], hl: null, other: false, sent: false });

export type QuestionFlow = NonNullable<ReturnType<typeof useQuestionFlow>>;

/**
 * Walks through what the agent asked, one question at a time: a pick (click, or its number key) or a
 * written answer moves to the next, and the last sends them all. Message questions go back as your
 * next message (steering the turn if it's still running), request questions as the tool's answer.
 */
export function useQuestionFlow(
  threadId: string,
  io: { send: (text: string) => Promise<unknown>; focusInput: () => void },
) {
  const ask = useOpenAsk(threadId);
  const running = useThread(threadId, (s) => !!s.live[threadId]?.activeTurnId);
  const [flow, setFlow] = useState<FlowState>(() => fresh(null));
  // A different question starts over.
  const source = ask?.source ?? null;
  const state = flow.source === source ? flow : fresh(source);
  if (state !== flow) setFlow(state);
  if (!ask || state.sent) return null;

  const total = ask.questions.length;
  const step = Math.min(state.step, total - 1);
  const q = ask.questions[step];
  // "Other" is a row only next to options; a question without options is just answered in the box.
  const otherRow = q.other && !q.secret && q.options.length > 0;
  const rows = q.options.length + (otherRow ? 1 : 0);

  const finish = (answers: string[]) => {
    if (ask.kind === "request") {
      respondToRequest(ask.key, {
        answers: Object.fromEntries(ask.questions.map((q, i) => [q.id, { answers: answers[i]?.trim() ? [answers[i].trim()] : [] }])),
      });
      return;
    }
    const text = ask.questions.every((q) => q.replyId)
      ? questionReply(ask.questions, answers)
      : total === 1
        ? answers[0]
        : ask.questions
            .map((q, i) => (answers[i]?.trim() ? `${q.text}\n${answers[i].trim()}` : ""))
            .filter(Boolean)
            .join("\n\n");
    if (!text?.trim()) return;
    setFlow({ ...state, answers, sent: true });
    io.send(text.startsWith("<send_user_message_question_reply>") ? text : text.trim()).catch(() => setFlow((f) => (f.source === source ? { ...f, sent: false } : f)));
  };

  const answer = (value: string) => {
    const answers = [...state.answers];
    answers[step] = value;
    if (step < total - 1) setFlow({ ...state, step: step + 1, answers, hl: null, other: false });
    else {
      setFlow({ ...state, answers });
      finish(answers);
    }
    io.focusInput();
  };

  return {
    ask,
    q,
    step,
    total,
    running,
    rows,
    otherRow,
    /** Who's asking ("Codex", "Claude Code"). */
    agent: agentOf(ownerOf(threadId)).name,
    hl: state.hl,
    other: state.other,
    previous: state.answers[step] as string | undefined,
    /** Take option `i` (0-based); the row after the options is "Other". False if there's no such row. */
    pick(i: number): boolean {
      if (i < 0 || i >= rows) return false;
      if (i < q.options.length) answer(q.options[i].label);
      else {
        setFlow({ ...state, other: true, hl: null });
        io.focusInput();
      }
      return true;
    },
    move(delta: 1 | -1) {
      if (!rows) return;
      const at = state.hl == null ? (delta > 0 ? 0 : rows - 1) : (state.hl + delta + rows) % rows;
      setFlow({ ...state, hl: at });
    },
    /** Leave "Other" (or the arrow-key highlight); true if there was anything to leave. */
    unpick(): boolean {
      if (!state.other && state.hl == null) return false;
      setFlow({ ...state, other: false, hl: null });
      return true;
    },
    back() {
      if (step > 0) setFlow({ ...state, step: step - 1, hl: null, other: false });
    },
    /** Requests: tell Codex you'd rather not say. Message questions: just close the dock. */
    skip() {
      if (ask.kind === "request") respondToRequest(ask.key, { answers: Object.fromEntries(ask.questions.map((q) => [q.id, { answers: [] }])) });
      else useDismissed.setState(Object.fromEntries(ask.itemIds.map((id) => [id, true as const])));
    },
    /**
     * Whether text typed in the box answers the current question. A single question on a reply is
     * answered by simply sending your message, so the composer sends it as usual then; an async
     * one is answered the way Codex expects.
     */
    takesText: q.other && !q.secret && (ask.kind === "request" || total > 1 || !!q.replyId),
    answerText: answer,
  };
}

/**
 * Answers to request_user_input_async, as the Codex app and CLI send them: Codex starts the turn as
 * an answer, and its reviewer takes them as answers to those questions rather than a loose reply.
 */
function questionReply(questions: DockQuestion[], answers: string[]): string {
  const replies = questions
    .map((q, i) => ({ questionItemId: q.replyId, question: q.text, answer: answers[i]?.trim() ?? "" }))
    .filter((r) => r.answer);
  return replies.length ? `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>\n` : "";
}

/** The question, docked at the top of the composer: numbered picks, with the box below for "Other". */
export function QuestionDock({ flow, compact }: { flow: QuestionFlow; compact?: boolean }) {
  const { ask, q, step, total, agent: name } = flow;
  const meanwhile = ask.kind === "request" ? !ask.blocking : flow.running;
  return (
    <div className="ask-dock" role="group" aria-label={`${name} is asking`}>
      <div className="ask-head">
        <MessageCircleQuestion size={13} />
        <span>{name} is asking</span>
        {total > 1 && (
          <span className="ask-step">
            {step + 1} of {total}
          </span>
        )}
        {q.header && <span className="ask-tag">{q.header}</span>}
        {meanwhile && !compact && <span className="ask-note">· still working meanwhile</span>}
        <span className="ask-head-actions">
          {step > 0 && (
            <button onClick={flow.back} title="Previous question">
              <ChevronLeft size={12} /> Back
            </button>
          )}
          {ask.kind === "request" ? (
            <button onClick={flow.skip} title={`Let ${name} carry on without an answer`}>
              Skip
            </button>
          ) : (
            <button onClick={flow.skip} title="Close without answering (it stays in the conversation)">
              <X size={12} />
            </button>
          )}
        </span>
      </div>
      <Markdown text={q.text} className="ask-q" />
      {q.options.length > 0 && (
        <div className="ask-options">
          {q.options.map((o, i) => (
            <button
              key={i}
              className={`ask-opt ${flow.hl === i ? "hl" : ""} ${flow.previous === o.label ? "picked" : ""}`}
              onClick={() => flow.pick(i)}
            >
              <kbd>{i < 9 ? i + 1 : "·"}</kbd>
              <span className="ask-opt-label">
                <span>{o.label}</span>
                {o.description && !compact && <small>{o.description}</small>}
              </span>
              <CornerDownLeft size={12} className="ask-opt-enter" />
            </button>
          ))}
          {flow.otherRow && (
            <button
              className={`ask-opt other ${flow.hl === q.options.length ? "hl" : ""} ${flow.other ? "on" : ""}`}
              onClick={() => flow.pick(q.options.length)}
            >
              <kbd>{q.options.length < 9 ? q.options.length + 1 : "·"}</kbd>
              <span className="ask-opt-label">
                <span>{flow.other ? "Type your answer below, then Enter" : "Other…"}</span>
              </span>
            </button>
          )}
        </div>
      )}
      {q.secret && <SecretAnswer key={q.id} onSubmit={flow.answerText} />}
    </div>
  );
}

/** Secret answers stay out of the composer (and out of its saved drafts). */
function SecretAnswer({ onSubmit }: { onSubmit: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <input
      className="input ask-secret"
      type="password"
      autoFocus
      placeholder="Your answer (hidden)"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing && value) onSubmit(value);
      }}
    />
  );
}
