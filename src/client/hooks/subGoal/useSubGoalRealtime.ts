import { connectRealtime } from "@devvit/web/client";
import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { RealtimeMessage, SubGoalState } from "../../../shared/types/api";
import { logDiagnostic } from "../../../shared/diagnostics";

export function useSubGoalRealtime(
  postHeight: SubGoalState["postHeight"] | undefined,
  announceSubscriber: (
    username: string | null,
    subscriberCount: number,
  ) => void,
  setState: Dispatch<SetStateAction<SubGoalState | null>>,
): void {
  const realtimeConnectedRef = useRef(false);

  const handleRealtimeMessage = useCallback(
    (data: unknown) => {
      const message = data as Partial<RealtimeMessage>;
      if (
        !message ||
        message.type !== "sub" ||
        typeof message.newSubscriberCount !== "number"
      ) {
        return;
      }
      const newSubscriberCount = message.newSubscriberCount;
      const recentSubscriber =
        typeof message.recentSubscriber === "string" &&
        message.recentSubscriber.length > 0
          ? message.recentSubscriber
          : null;
      announceSubscriber(recentSubscriber, newSubscriberCount);
      setState((prev) => {
        if (!prev || prev.postHeight === "tiny" || prev.postHeight === "cta") {
          return prev;
        }
        const completedTime =
          prev.goal && newSubscriberCount >= prev.goal
            ? (prev.completedTime ?? Date.now())
            : prev.completedTime;
        return {
          ...prev,
          completedTime,
          recentSubscriber,
          subreddit: {
            ...prev.subreddit,
            subscribers: newSubscriberCount,
          },
        };
      });
    },
    [announceSubscriber, setState],
  );

  useEffect(() => {
    if (
      !postHeight ||
      postHeight === "tiny" ||
      postHeight === "cta" ||
      realtimeConnectedRef.current
    ) {
      return;
    }
    realtimeConnectedRef.current = true;

    let connection: { disconnect: () => Promise<void> } | null = null;
    let cancelled = false;
    const disconnect = (
      target: { disconnect: () => Promise<void> },
      phase: string,
    ) => {
      void target.disconnect().catch((error: unknown) => {
        logDiagnostic(
          "warn",
          "realtime_disconnect_failed",
          { workflow: "realtime", phase },
          error,
        );
      });
    };
    const connect = async () => {
      const connected = await connectRealtime({
        channel: "subscriber_updates",
        onMessage: handleRealtimeMessage,
      });
      if (cancelled) {
        disconnect(connected, "late_connect_cleanup");
        return;
      }
      connection = connected;
    };
    void connect().catch((error: unknown) => {
      realtimeConnectedRef.current = false;
      logDiagnostic(
        "error",
        "realtime_connection_failed",
        { workflow: "realtime", phase: "connect" },
        error,
      );
    });

    return () => {
      cancelled = true;
      if (connection) {
        disconnect(connection, "disconnect");
      }
      realtimeConnectedRef.current = false;
    };
  }, [handleRealtimeMessage, postHeight]);
}
