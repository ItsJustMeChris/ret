import { MessageCircleQuestion, Play } from "lucide-react";
import { useThreads } from "../../state/threads";
import { focusComposer, sendFromComposer } from "../../state/composerDrafts";
import { openQuestionItems, reopenQuestion, useQuestionDismissed } from "./QuestionDock";

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
 * Questions on a Codex message (asked while it keeps working, or at the end of a reply). They're
 * answered in the dock on top of the composer; here they leave a pointer to it while open, and
 * afterwards a record, unless the message already lists the options itself (it usually does).
 */
export function ReplyQuestions({ threadId, itemId, text, questions }: { threadId: string; itemId: string; text: string; questions: Async[] }) {
  const open = useThreads((s) => openQuestionItems(s, threadId).includes(itemId));
  const dismissed = useQuestionDismissed(itemId);
  if (open) {
    return (
      <button
        className="ask-pointer"
        onClick={() => {
          reopenQuestion(itemId);
          focusComposer(threadId);
        }}
      >
        <MessageCircleQuestion size={12} />
        {dismissed ? "Answer this" : "Waiting for your answer below"}
      </button>
    );
  }
  if (questions.every((q) => text.includes(q.title) && (q.options ?? []).every((o) => text.includes(o)))) return null;
  return (
    <div className="questions past">
      <div className="questions-head">
        <MessageCircleQuestion size={13} /> Codex asked
      </div>
      {questions.map((q, i) => (
        <div key={i} className="question">
          <div className="q-text">{q.title}</div>
          {q.options?.length ? (
            <div className="q-options">
              {q.options.map((o) => (
                <button key={o} className="q-option" disabled>
                  {o}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
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
