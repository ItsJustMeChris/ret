// Stands in for the desktop's screenshot decoder (src/renderer/state/shotWorker.ts, a web worker
// Vite builds): the phone shows no computer-use screens, so screenshots are never decoded here.
export default class ShotWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  postMessage(_job: unknown) {}
  terminate() {}
}
