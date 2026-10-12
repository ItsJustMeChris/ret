import { useState } from "react";
import { MessageCircleQuestion, Play, Send } from "lucide-react";
import { useThreads } from "../../state/threads";
import { focusComposer, sendFromComposer } from "../../state/composerDrafts";

/** True while `itemId` is in the thread's latest turn and nothing is running: the moment to answer. */
function useAnswerable(threadId: string, itemId: string): boolean {
  return useThreads((s) => {
    const lt = s.live[threadId];
    if (!lt || lt.activeTurnId || s.external[threadId]) return false;
    const last = lt.turnOrder[lt.turnOrder.length - 1];
    return !!last && !!lt.turns[last]?.itemIds.includes(itemId);
  });
}

type Async = { title: string; options: string[] | null };

/**
 * Questions Codex asked at the end of a reply (it stopped to let you answer). Pick an option, or
 * type, and the answers go back as your next message. Once the conversation has moved on they
 * stay as a record, no longer clickable.
 */
export function ReplyQuestions({ threadId, itemId, questions }: { threadId: string; itemId: string; questions: Async[] }) {
  const live = useAnswerable(threadId, itemId);
  const [picked, setPicked] = useState<Record<number, string>>({});
  const single = questions.length === 1;

  const send = (answers: Record<number, string>) => {
    const text = single
      ? answers[0]
      : questions
          .map((q, i) => (answers[i] ? `${q.title}\n${answers[i]}` : ""))
          .filter(Boolean)
          .join("\n\n");
    if (text?.trim()) sendFromComposer(threadId, text.trim());
  };
  const ready = questions.every((_, i) => picked[i]?.trim());

  return (
    <div className={`questions ${live ? "live" : "past"}`}>
      <div className="questions-head">
        <MessageCircleQuestion size={13} />
        {live ? (single ? "Codex is asking" : `Codex is asking ${questions.length} things`) : "Codex asked"}
      </div>
      {questions.map((q, i) => (
        <div key={i} className="question">
          <div className="q-text">{q.title}</div>
          {q.options?.length ? (
            <div className="q-options">
              {q.options.map((o) => (
                <button
                  key={o}
                  className={`q-option ${picked[i] === o ? "selected" : ""}`}
                  disabled={!live}
                  onClick={() => {
                    const next = { ...picked, [i]: o };
                    setPicked(next);
                    if (single) send(next); // one question, one click
                  }}
                >
                  {o}
                </button>
              ))}
            </div>
          ) : null}
          {live && (!q.options?.length || !single) && (
            <input
              className="input q-free"
              placeholder={q.options?.length ? "Or answer in your own words…" : "Your answer…"}
              value={picked[i] && !q.options?.includes(picked[i]) ? picked[i] : ""}
              onChange={(e) => setPicked({ ...picked, [i]: e.target.value })}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                e.preventDefault();
                if (ready || single) send({ ...picked, [i]: e.currentTarget.value });
              }}
            />
          )}
        </div>
      ))}
      {live && (
        <div className="questions-actions">
          {!single && (
            <button className="btn primary" disabled={!ready} onClick={() => send(picked)}>
              <Send size={13} /> Send answers
            </button>
          )}
          <button className="btn ghost" onClick={() => focusComposer(threadId)}>
            Reply in the box instead
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Under a plan Codex proposed in Plan mode: carry it out (back in Default mode), or keep refining.
 */
export function PlanActions({ threadId, itemId }: { threadId: string; itemId: string }) {
  const live = useAnswerable(threadId, itemId);
  const planning = useThreads((s) => s.live[threadId]?.settings?.mode === "plan");
  if (!live || !planning) return null;
  return (
    <div className="plan-actions">
      <button className="btn primary" onClick={() => sendFromComposer(threadId, "Implement the plan.", { mode: "default" })}>
        <Play size={13} /> Implement this plan
      </button>
      <button className="btn ghost" onClick={() => focusComposer(threadId)}>
        Keep planning
      </button>
    </div>
  );
}
