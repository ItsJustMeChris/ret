import { Composition } from "remotion";
import { Promo, TOTAL } from "./Promo";
import { FPS, W, H } from "./theme";

export const Root = () => <Composition id="RetPromo" component={Promo} durationInFrames={TOTAL} fps={FPS} width={W} height={H} />;
