import { memo, useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, LoaderCircle, RotateCw, TriangleAlert } from "lucide-react";
import { bridge } from "../../bridge";
import type { VisualizationRef } from "../../lib/visualize";

const STATE_PLACEHOLDER =
  '<script type="application/json" id="codex-visualization-widget-state">__CODEX_VISUALIZATION_WIDGET_STATE__</script>';
const MAX_STATE_BYTES = 16 * 1024;
const stateKey = (path: string, host: string | null) => `ret:viz-state:${host ?? ""}:${path}`;

function loadState(path: string, host: string | null): unknown {
  try {
    const raw = localStorage.getItem(stateKey(path, host));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** The frame document with the widget's saved state in it: the runtime reads it once, as it starts. */
function withState(html: string, path: string, host: string | null): string {
  const globals = { widgetState: loadState(path, host), statePersistence: "local" };
  const state = JSON.stringify(globals).replaceAll("<", "\\u003c");
  return html.replace(STATE_PLACEHOLDER, () => STATE_PLACEHOLDER.replace("__CODEX_VISUALIZATION_WIDGET_STATE__", state));
}

/**
 * An inline Codex visualization: the fragment runs in an opaque-origin sandboxed frame under the
 * skill's CSP, and talks to us only over the MessagePort handed to it on load (height, links,
 * widget state) — the same contract as Codex's standalone shell.
 */
export const Visualization = memo(function Visualization({ viz, host }: { viz: VisualizationRef; host: string | null }) {
  const [doc, setDoc] = useState<{ html: string } | { error: string } | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [rev, setRev] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  /** The document as read, the one the frame has, and whether the widget saved state since it was made. */
  const loaded = useRef<{ template: string; html: string; stale: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    setDoc(null);
    loaded.current = null;
    void bridge.files.visualization(viz.path, viz.title, host).then(
      (res) => {
        if (!alive) return;
        if ("error" in res) return setDoc(res);
        const html = withState(res.html, viz.path, host);
        loaded.current = { template: res.html, html, stale: false };
        setDoc({ html });
      },
      (err: Error) => alive && setDoc({ error: err.message }),
    );
    return () => {
      alive = false;
    };
  }, [viz.path, viz.title, host, rev]);

  useEffect(() => () => port.current?.close(), []);

  const onLoad = useCallback(() => {
    // A frame that leaves the document (its window culled, its view put away) loses its page, and
    // back in it loads the document it was given again: give it one with the state saved since.
    const l = loaded.current;
    if (l?.stale) {
      l.stale = false;
      const html = withState(l.template, viz.path, host);
      if (html !== l.html) {
        l.html = html;
        setDoc({ html });
        return;
      }
    }
    port.current?.close();
    const channel = new MessageChannel();
    port.current = channel.port1;
    channel.port1.onmessage = (e: MessageEvent) => {
      const data = e.data;
      if (typeof data !== "object" || data == null) return;
      switch (data.type) {
        case "height":
          if (typeof data.height === "number" && Number.isFinite(data.height) && data.height >= 0) {
            setHeight(Math.min(Math.ceil(data.height), 10_000));
          }
          break;
        case "open-external":
          if (typeof data.href === "string" && /^https:/i.test(data.href)) void bridge.shell.openExternal(data.href);
          break;
        case "scroll-to": {
          const el = frame.current;
          const scroller = el?.closest(".transcript");
          if (el && scroller && typeof data.top === "number" && Number.isFinite(data.top)) {
            scroller.scrollBy({ top: el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + data.top, behavior: "smooth" });
          }
          break;
        }
        case "widget-state-write": {
          if (!Number.isSafeInteger(data.id) || data.id <= 0) return;
          let ok = false;
          try {
            if (typeof data.state === "string" && new TextEncoder().encode(data.state).length <= MAX_STATE_BYTES) {
              const parsed = JSON.parse(data.state);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                localStorage.setItem(stateKey(viz.path, host), JSON.stringify(parsed));
                if (loaded.current) loaded.current.stale = true;
                ok = true;
              }
            }
          } catch {
            /* quota or bad JSON: report failure */
          }
          channel.port1.postMessage({ type: "widget-state-result", id: data.id, ok });
          break;
        }
        // "follow-up" (ask Codex about a selection) has no composer hook yet; ignore it.
      }
    };
    frame.current?.contentWindow?.postMessage({ type: "codex-visualization-initialize" }, "*", [channel.port2]);
  }, [viz.path, host]);

  const name = viz.title || viz.path.split(/[\\/]/).pop();
  const tools = (
    <div className="viz-tools">
      <button className="icon-btn tiny" title="Reload" onClick={() => setRev((r) => r + 1)}>
        <RotateCw size={12} />
      </button>
      {!host && (
        <button className="icon-btn tiny" title="Show in folder" onClick={() => void bridge.shell.reveal(viz.path)}>
          <FolderOpen size={12} />
        </button>
      )}
    </div>
  );

  if (doc && "error" in doc) {
    return (
      <div className="viz viz-error">
        <TriangleAlert size={14} />
        <span>
          Couldn't show visualization <code>{name}</code>: {doc.error}
        </span>
        {tools}
      </div>
    );
  }
  return (
    <div className={`viz ${viz.wide ? "wide" : ""}`}>
      {doc ? (
        <iframe
          ref={frame}
          className="viz-frame"
          title={name}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={doc.html}
          onLoad={onLoad}
          style={height != null ? { height } : undefined}
        />
      ) : (
        <VisualizationPending />
      )}
      {tools}
    </div>
  );
});

export function VisualizationPending() {
  return (
    <div className="viz viz-pending">
      <LoaderCircle className="spin" size={14} /> Preparing visualization…
    </div>
  );
}
