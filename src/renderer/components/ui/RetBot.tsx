import { memo, useState } from "react";
import type { BotMood } from "../../lib/working";
import { botShape } from "../../lib/retBot";

/** 18 px tall, beside 12.5 px text. */
const S = botShape(18);

function Layer({ className, style, children }: { className?: string; style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <svg viewBox={S.box} className={className} style={style}>
      {children}
    </svg>
  );
}

/**
 * Ret's mascot as a status glyph: antennae, visor and eyes, moving to show what a thread is doing.
 * Each moving part is its own SVG layer the size of the glyph, so every motion is a transform or
 * opacity keyframe on an element, which the compositor runs. The phone's (apps/mobile/src/ui/RetBot)
 * is drawn from the same shapes and moves the same way.
 */
export const RetBot = memo(function RetBot({ mood }: { mood: BotMood }) {
  // Each one blinks on its own beat: a board of them doesn't blink in unison.
  const [beat] = useState(() => `${(-Math.random() * 4.4).toFixed(2)}s`);
  return (
    <span className={`retbot ${mood}`} aria-hidden>
      <span className="rb-body">
        {(["left", "right"] as const).map((side, i) => (
          <span key={side} className={`rb-ant ${side}`}>
            <Layer>
              <path d={S.stalks[i]} strokeWidth={S.stroke.stalk} />
              <circle cx={S.tips[i].x} cy={S.tips[i].y} r={S.tipR} />
            </Layer>
            <Layer className="rb-led">
              <circle cx={S.tips[i].x} cy={S.tips[i].y} r={S.ledR} />
            </Layer>
          </span>
        ))}
        <Layer>
          <path fillRule="evenodd" d={S.head} />
        </Layer>
        <Layer className="rb-pupils">
          {S.eyes.map((e, i) => (
            <circle key={i} cx={e.x} cy={e.y} r={S.pupilR} />
          ))}
        </Layer>
        <Layer className="rb-lids" style={{ animationDelay: beat }}>
          {S.eyes.map((e, i) => (
            <circle key={i} cx={e.x} cy={e.y} r={S.lidR} />
          ))}
        </Layer>
      </span>
      {mood === "think" &&
        S.puffR.map((r) => (
          <Layer key={r} className="rb-puff">
            <circle cx={S.puff.x} cy={S.puff.y} r={r} strokeWidth={S.stroke.puff} />
          </Layer>
        ))}
      {mood === "doze" &&
        [0, 1, 2].map((i) => (
          <Layer key={i} className="rb-z">
            <path d={S.z} strokeWidth={S.stroke.z} />
          </Layer>
        ))}
    </span>
  );
});
