import { useState } from "react";
import { ChevronLeft, CornerDownLeft, MessageCircleQuestion, X } from "lucide-react";
import type { QuestionFlow } from "../../state/questionFlow";
import { Markdown } from "../Markdown";

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
