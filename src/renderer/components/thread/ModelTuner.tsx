import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronLeft, ChevronRight, Gauge, RotateCcw, Rocket, Zap } from "lucide-react";
import { fillDelay, heatOf, useFillFrom, useRoll } from "../../lib/effortMeter";
import type { ComposerSettings } from "../../state/composerSettings";
import { OptionList } from "../ui/Select";

// The composer's model, reasoning effort and speed, in one chip. Its popover sets effort on a
// staircase of bars that light up as it gets deeper, speed on a segmented switch, and swaps to the
// model list in place. The phone's (apps/mobile/src/thread/ModelTuner.tsx) is a sheet that looks
// and moves the same, from the same lib/effortMeter: change both.

const SPEED_ICON: Record<string, React.ReactNode> = {
  default: <Gauge size={12} />,
  priority: <Zap size={12} />,
  ultrafast: <Rocket size={12} />,
};
const speedIcon = (tier: string) => SPEED_ICON[tier] ?? <Zap size={12} />;

const PANEL_WIDTH = 300;

/** n bars rising left to right, lit up to `level`: the effort, at a glance. */
function PowerGlyph({ level, of }: { level: number; of: number }) {
  return (
    <span className="power-glyph" aria-hidden style={{ "--n": of } as React.CSSProperties}>
      {Array.from({ length: of }, (_, k) => (
        <i key={k} className={k <= level ? "on" : ""} style={{ "--k": k } as React.CSSProperties} />
      ))}
    </span>
  );
}

export function ModelTuner({ settings }: { settings: ComposerSettings }) {
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const { effortOptions: efforts, speedOptions, speed } = settings;
  const level = efforts.findIndex((o) => o.value === settings.effort);
  const tier = speed !== "default" ? speedOptions.find((o) => o.value === speed) : undefined;
  const title = [
    settings.modelLabel,
    level >= 0 && `${efforts[level].label} effort`,
    tier?.label,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <button
        ref={chip}
        type="button"
        className={`sel sel-pill tune-chip ${open ? "open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
      >
        {tier && <span className={`sel-icon tune-speed speed-${tier.value}`}>{speedIcon(tier.value)}</span>}
        <span className="sel-label">{settings.modelLabel ?? "Model"}</span>
        {efforts.length > 1 && <PowerGlyph level={level} of={efforts.length} />}
        <ChevronDown className="sel-chev" size={12} />
      </button>
      {open && chip.current && <TunerPanel anchor={chip.current} settings={settings} onClose={() => setOpen(false)} />}
    </>
  );
}

function TunerPanel({ anchor, settings, onClose }: { anchor: HTMLElement; settings: ComposerSettings; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<"tune" | "models">("tune");
  /** Back from the model list: the tuning page slides in from the other side. */
  const [returned, setReturned] = useState(false);
  const toTune = () => {
    setPage("tune");
    setReturned(true);
  };
  const [place] = useState(() => {
    const r = anchor.getBoundingClientRect();
    const roomAbove = r.top - 14;
    const roomBelow = window.innerHeight - r.bottom - 14;
    const above = roomAbove >= 260 || roomAbove > roomBelow;
    return {
      left: Math.max(8, Math.min(r.left - 2, window.innerWidth - PANEL_WIDTH - 8)),
      // Above the chip it hangs from its bottom edge, so it grows upward.
      top: above ? undefined : r.bottom + 6,
      bottom: above ? window.innerHeight - r.top + 6 : undefined,
      room: Math.min(420, above ? roomAbove : roomBelow),
      above,
    };
  });

  const close = (refocus: boolean) => {
    onClose();
    if (refocus) anchor.focus();
  };

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    // On the models page the list has the keyboard (its Escape comes back here).
    const onKey = (e: KeyboardEvent) => {
      if (page === "tune" && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  });

  // Its height follows what it shows (a page, a description that wraps), eased rather than jumped.
  useLayoutEffect(() => {
    const el = panel.current;
    const inner = body.current;
    if (!el || !inner || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const chrome = el.offsetHeight - inner.offsetHeight;
    let last = inner.offsetHeight;
    let anim: Animation | null = null;
    const ro = new ResizeObserver(() => {
      const h = inner.offsetHeight;
      if (h === last) return;
      // Mid-way through the last change, carry on from where it's got to.
      const from = anim?.playState === "running" ? el.offsetHeight : last + chrome;
      anim?.cancel();
      anim = el.animate([{ height: `${from}px` }, { height: `${h + chrome}px` }], { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
      last = h;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label="Model, effort and speed"
      className={`sel-menu tuner ${place.above ? "above" : ""}`}
      style={{ left: place.left, top: place.top, bottom: place.bottom, width: PANEL_WIDTH }}
    >
      <div ref={body}>
        {page === "tune" ? (
          <TunePage key="tune" settings={settings} onModels={() => setPage("models")} back={returned} />
        ) : (
          <div key="models" className="tuner-page" data-from="right">
            <div className="tuner-head">
              <button type="button" className="tuner-back" onClick={toTune}>
                <ChevronLeft size={14} />
                <span>{settings.modelsGrouped ? "Model and agent" : `${settings.agent.name} models`}</span>
              </button>
            </div>
            <OptionList
              className="tuner-models"
              options={settings.modelOptions}
              value={settings.model}
              maxHeight={place.room - 44}
              onPick={(v) => {
                if (v !== settings.model) settings.pickModel(v);
                toTune();
              }}
              onClose={toTune}
            />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function TunePage({ settings, onModels, back }: { settings: ComposerSettings; onModels: () => void; back: boolean }) {
  const { effortOptions: efforts, speedOptions, speed, setPrefs } = settings;
  const n = efforts.length;
  const level = efforts.findIndex((o) => o.value === settings.effort);
  const meter = useRef<HTMLDivElement>(null);
  const modelBtn = useRef<HTMLButtonElement>(null);
  /** The bar under the pointer, previewed in the readout until it's clicked. */
  const [peek, setPeek] = useState<number | null>(null);
  const dragging = useRef(false);
  const shown = peek ?? level;
  const dir = useRoll(shown);
  const from = useFillFrom(level);

  useEffect(() => {
    (meter.current ?? modelBtn.current)?.focus({ preventScroll: true });
  }, []);

  const pick = (k: number) => {
    const o = efforts[Math.max(0, Math.min(n - 1, k))];
    if (o && o.value !== settings.effort) setPrefs({ effort: o.value });
  };
  const barAt = (clientX: number) => {
    const r = meter.current!.getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.floor(((clientX - r.left) / r.width) * n)));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, PageUp: 1, ArrowLeft: -1, ArrowDown: -1, PageDown: -1 };
    let to: number | null = null;
    if (e.key in step) to = level + step[e.key];
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = n - 1;
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) to = Number(e.key) - 1;
    if (to === null) return;
    e.preventDefault();
    setPeek(null);
    pick(to);
  };

  const defaultIndex = efforts.findIndex((o) => o.value === settings.defaultEffort);
  const current = shown >= 0 ? efforts[shown] : undefined;
  const heat = heatOf(shown, n);
  const top = n > 1 && level === n - 1;
  const speedIndex = Math.max(0, speedOptions.findIndex((o) => o.value === speed));
  const tier = speedOptions[speedIndex];

  return (
    <div className="tuner-page" data-from={back ? "left" : undefined}>
      <div className="tuner-head">
        <button ref={modelBtn} type="button" className="tuner-model" onClick={onModels} title={settings.modelsGrouped ? "Choose the model, and the agent that runs it" : "Choose the model"}>
          <span className="tuner-model-name">{settings.modelLabel ?? "Model"}</span>
          <span className="tuner-agent">{settings.agent.name}</span>
          <ChevronRight size={13} className="tuner-model-chev" />
        </button>
        {defaultIndex >= 0 && level >= 0 && level !== defaultIndex && (
          <button type="button" className="icon-btn tuner-reset" title={`Back to ${efforts[defaultIndex].label}, this model's default`} onClick={() => pick(defaultIndex)}>
            <RotateCcw size={12} />
          </button>
        )}
      </div>

      {n > 0 ? (
        <div className={`tuner-effort ${top ? "top" : ""}`} style={{ "--heat": heat } as React.CSSProperties}>
          <div className={`tuner-readout ${peek !== null && peek !== level ? "peeking" : ""}`}>
            <span className="tuner-name">
              <span key={current?.value ?? ""} className="tuner-roll" data-dir={dir}>
                {current?.label ?? "Effort"}
              </span>
            </span>
            {shown >= 0 && shown === defaultIndex && <span className="tuner-tag">Default</span>}
            {shown >= 0 && n > 1 && (
              <span className="tuner-count">
                {shown + 1}
                <span>/{n}</span>
              </span>
            )}
          </div>
          <div className="tuner-desc" title={current?.description}>
            {current?.description ?? "Reasoning effort"}
          </div>
          {n > 1 && (
            <div
              ref={meter}
              className="tuner-meter"
              data-speed={speed}
              role="slider"
              tabIndex={0}
              aria-label="Reasoning effort"
              aria-valuemin={1}
              aria-valuemax={n}
              aria-valuenow={level + 1}
              aria-valuetext={efforts[level]?.label}
              style={{ "--n": n } as React.CSSProperties}
              onKeyDown={onKeyDown}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                dragging.current = true;
                setPeek(null);
                pick(barAt(e.clientX));
              }}
              onPointerMove={(e) => {
                const k = barAt(e.clientX);
                if (dragging.current) pick(k);
                else setPeek(k);
              }}
              onPointerUp={() => (dragging.current = false)}
              onPointerCancel={() => (dragging.current = false)}
              onPointerLeave={() => setPeek(null)}
            >
              {efforts.map((o, k) => {
                const on = k <= level;
                const delay = fillDelay(k, level, from);
                // Hovering previews: bars it would light, and lit ones it would put out.
                const ghost = peek !== null && ((k > level && k <= peek) || (k <= level && k > peek));
                return (
                  <span
                    key={o.value}
                    className={`tuner-bar ${on ? "on" : ""} ${k === level ? "cur" : ""} ${ghost ? (on ? "shed" : "ghost") : ""} ${k === defaultIndex ? "default" : ""}`}
                    style={{ "--k": k, "--d": `${delay}ms` } as React.CSSProperties}
                  >
                    <span className="tuner-cell">
                      <span className="tuner-fill" />
                    </span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="tuner-none">This model doesn't take a reasoning effort.</div>
      )}

      {speedOptions.length > 0 && (
        <div className="tuner-speed-wrap">
          <div className="tuner-speed" role="radiogroup" aria-label="Speed" data-speed={speed} style={{ "--i": speedIndex, "--n": speedOptions.length } as React.CSSProperties}>
            <span className="tuner-speed-thumb" aria-hidden />
            {speedOptions.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={o.value === speed}
                className={`tuner-speed-opt speed-${o.value} ${o.value === speed ? "on" : ""}`}
                onClick={() => o.value !== speed && setPrefs({ speed: o.value })}
                title={o.description}
              >
                {speedIcon(o.value)}
                <span>{o.label}</span>
              </button>
            ))}
          </div>
          {tier?.description && <div className="tuner-speed-desc">{tier.description}</div>}
        </div>
      )}
    </div>
  );
}
