import { memo } from "react";
import { View } from "react-native";
import { useBackgroundOnly, useRunsElsewhere, useThreadState, type ThreadState } from "@ret/components/StatusDot";

const FILL: Record<ThreadState, string> = {
  attention: "bg-amber",
  running: "bg-green",
  error: "bg-red",
  unread: "bg-accent",
  idle: "bg-text-3 opacity-40",
};

const RING: Partial<Record<ThreadState, string>> = { attention: "border-amber", running: "border-green" };

/**
 * The desktop's status dot (components/StatusDot.tsx, whose state logic this uses): amber wants
 * you, green works (with a ping), red failed, accent is new. A dashed ring: running in another app.
 */
export const StatusDot = memo(function StatusDot({ threadId, size = 8 }: { threadId: string; size?: number }) {
  const state = useThreadState(threadId);
  const elsewhere = useRunsElsewhere(threadId);
  const background = useBackgroundOnly(threadId);
  const ring = RING[state];
  return (
    <View style={{ width: size, height: size }} className="items-center justify-center">
      {ring && (
        <View
          style={{ width: size + 8, height: size + 8, borderRadius: size }}
          className={`absolute border-[1.5px] ${ring} ${elsewhere ? "border-dashed" : ""} ${background ? "opacity-50" : "animate-ping"}`}
        />
      )}
      <View style={{ width: size, height: size, borderRadius: size / 2 }} className={FILL[state]} />
    </View>
  );
});
