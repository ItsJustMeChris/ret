// The phone's bridge for tests that run the desktop's shared stores: the app's own
// createMobileBridge, with whatever deps the test put in globalThis.__retTestBridge first.
import { createMobileBridge, type MobileBridgeDeps } from "../../src/platform/createBridge";

const made = createMobileBridge((globalThis as { __retTestBridge?: MobileBridgeDeps }).__retTestBridge!);

export const bridge = made.bridge;
export const access = made.access;
export const isDesktop = true;
