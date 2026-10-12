import { memo } from "react";
import { LoaderCircle } from "lucide-react";
import { useThreadState } from "./StatusDot";
import { timeAgo } from "../lib/format";

/** Relative time for a thread row, with a spinner while a turn is in progress. */
export const ThreadTime = memo(function ThreadTime({ threadId, seconds, className = "row-time" }: { threadId: string; seconds: number; className?: string }) {
  const state = useThreadState(threadId);
  return (
    <span className={`${className} time-${state}`}>
      {state === "running" && <LoaderCircle className="spin time-spinner" size={11} />}
      {timeAgo(seconds)}
    </span>
  );
});
