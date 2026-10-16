// Whether Ret has the user's attention, and when it gets it back. The mobile app swaps this
// module for its own (apps/mobile/src/platform/appFocus.ts), where there's no window to focus.

/** The window has focus (a notification for a finished turn would be noise). */
export function appHasFocus(): boolean {
  return document.hasFocus();
}

/** Calls `cb` each time the window gets focus back; returns the way to stop. */
export function onAppFocus(cb: () => void): () => void {
  window.addEventListener("focus", cb);
  return () => window.removeEventListener("focus", cb);
}
