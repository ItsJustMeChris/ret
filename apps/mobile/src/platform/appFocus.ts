import { AppState } from "react-native";

// The desktop's src/renderer/lib/appFocus.ts, for the phone (metro.config.js swaps it in): the
// app has focus while it's in front.

export function appHasFocus(): boolean {
  return AppState.currentState === "active";
}

export function onAppFocus(cb: () => void): () => void {
  let last = AppState.currentState;
  const sub = AppState.addEventListener("change", (state) => {
    if (state === "active" && last !== "active") cb();
    last = state;
  });
  return () => sub.remove();
}
