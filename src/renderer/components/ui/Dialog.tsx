import { useEffect, useRef, useState } from "react";
import { create } from "zustand";

interface PromptRequest {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  resolve: (value: string | null) => void;
}

const usePrompt = create<{ request: PromptRequest | null }>(() => ({ request: null }));

/** Styled replacement for window.prompt. Resolves to the entered text, or null if cancelled. */
export function promptText(opts: Omit<PromptRequest, "resolve">): Promise<string | null> {
  return new Promise((resolve) => {
    usePrompt.getState().request?.resolve(null);
    usePrompt.setState({ request: { ...opts, resolve } });
  });
}

export function DialogHost() {
  const request = usePrompt((s) => s.request);
  if (!request) return null;
  return <PromptDialog key={request.title + (request.initial ?? "")} request={request} />;
}

function PromptDialog({ request }: { request: PromptRequest }) {
  const [value, setValue] = useState(request.initial ?? "");
  const input = useRef<HTMLInputElement>(null);
  const finish = (v: string | null) => {
    usePrompt.setState({ request: null });
    request.resolve(v);
  };

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  return (
    <div className="overlay" onPointerDown={() => finish(null)}>
      <form
        className="modal dialog"
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          finish(value.trim() ? value.trim() : null);
        }}
      >
        <div className="dialog-body">
          <h3>{request.title}</h3>
          {request.label && <label className="dialog-label">{request.label}</label>}
          <input
            ref={input}
            className="input"
            value={value}
            placeholder={request.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && finish(null)}
          />
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={() => finish(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!value.trim()}>
            {request.confirmLabel ?? "OK"}
          </button>
        </div>
      </form>
    </div>
  );
}
