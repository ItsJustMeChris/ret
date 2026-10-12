import { create } from "zustand";

export interface Toast {
  id: number;
  message: string;
  kind: "error" | "info";
}

export const useToasts = create<{ toasts: Toast[] }>(() => ({ toasts: [] }));

let nextId = 1;

export function toast(message: string, kind: Toast["kind"] = "info", ttl = kind === "error" ? 8000 : 3500) {
  const id = nextId++;
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, message, kind }] }));
  setTimeout(() => dismissToast(id), ttl);
}

export function dismissToast(id: number) {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/** Wraps a fire-and-forget action so failures surface as a toast instead of an unhandled rejection. */
export function guarded<A extends unknown[], R>(label: string, fn: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R | undefined> => {
    try {
      return await fn(...args);
    } catch (err) {
      toast(`${label}: ${(err as Error).message}`, "error");
      return undefined;
    }
  };
}
