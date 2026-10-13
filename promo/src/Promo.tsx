import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { C } from "./theme";
import { Grain, SceneFade, Vignette } from "./ui";
import { Chaos } from "./scenes/Chaos";
import { Logo } from "./scenes/Logo";
import { CanvasScene } from "./scenes/Canvas";
import { Approve } from "./scenes/Approve";
import { InboxScene } from "./scenes/InboxScene";
import { Fork } from "./scenes/Fork";
import { Agents } from "./scenes/Agents";
import { Modes } from "./scenes/Modes";
import { Outro } from "./scenes/Outro";

/** Scenes overlap by OVERLAP frames and cross-fade. */
const OVERLAP = 10;
export const SCENES = [
  { C: Chaos, dur: 160, fadeIn: 0 },
  { C: Logo, dur: 120 },
  { C: CanvasScene, dur: 300 },
  { C: Approve, dur: 230 },
  { C: InboxScene, dur: 210 },
  { C: Fork, dur: 190 },
  { C: Agents, dur: 190 },
  { C: Modes, dur: 170 },
  { C: Outro, dur: 200, fadeOut: 24 },
];

export const TOTAL = SCENES.reduce((a, s) => a + s.dur, 0) - OVERLAP * (SCENES.length - 1);

export function Promo() {
  let at = 0;
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      {SCENES.map((s, i) => {
        const from = at;
        at += s.dur - OVERLAP;
        return (
          <Sequence key={i} from={from} durationInFrames={s.dur}>
            <SceneFade dur={s.dur} inFrames={s.fadeIn ?? OVERLAP} outFrames={s.fadeOut ?? OVERLAP}>
              <s.C />
            </SceneFade>
          </Sequence>
        );
      })}
      <Audio src={staticFile("soundtrack.wav")} />
      <Vignette />
      <Grain />
    </AbsoluteFill>
  );
}
