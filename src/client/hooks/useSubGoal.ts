import { connectRealtime } from "@devvit/web/client";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ErrorResponse,
  InitResponse,
  RealtimeMessage,
  RefreshResponse,
  SubGoalState,
  SubscribeRequest,
  SubscribeResponse,
} from "../../shared/types/api";
import { getSubGoalPostMessages } from "../../shared/subGoalPostI18n";
import { requestJsonWithRetry } from "../utils/fetchWithRetry";
import { prohibitedContentMessage } from "../../shared/contentPolicy";
import { goalJourneyAnalytics } from "../analytics/goalJourneyAnalytics";

type RequestResult<T> = {
  data: T | null;
  error: string | null;
  errorKind: "api" | "gateway" | "network" | "protocol" | null;
};

type SubscribeResult = {
  state: SubGoalState | null;
  error: string | null;
  journeyTelemetryHandled: boolean;
};

type SubscriptionReconciliationResult =
  | { outcome: "confirmed"; state: SubGoalState }
  | { outcome: "timeout" | "aborted"; state: null };

const initRetryOptions = {
  maxDurationMs: 8000,
  initialDelayMs: 200,
  delayMultiplier: 2,
  maxDelayMs: 1500,
  attemptTimeoutMs: 1500,
} as const;

const recoveryWindowMs = 30000;
const recoveryIntervalMs = 5000;
const regularRefreshIntervalMs = 30000;
const tinyRefreshIntervalMs = 60000;
const subscriptionReconciliationTimeoutMs = 30000;
const subscriptionReconciliationOffsetsMs = [
  0, 1000, 2000, 3000, 4000, 5000, 10000, 15000, 20000, 25000,
] as const;

const safeSubscribeRequestError =
  "Subscription request could not be completed.";

const classifyNonJsonResponse = (body: string): "gateway" | "protocol" =>
  body.trimStart().toLowerCase().startsWith("failed to call devvit application")
    ? "gateway"
    : "protocol";

export const requestSubscribeJson = async <T>(
  input: RequestInfo,
  init?: RequestInit,
): Promise<RequestResult<T>> => {
  try {
    const res = await fetch(input, init);
    const body = await res.text();
    let payload: T | ErrorResponse;
    try {
      payload = JSON.parse(body) as T | ErrorResponse;
    } catch {
      const errorKind = classifyNonJsonResponse(body);
      console.info("[subscribe] non_json_response", {
        status: res.status,
        contentType: res.headers.get("content-type") ?? "unknown",
        category: errorKind,
        bodyLength: body.length,
      });
      return {
        data: null,
        error: safeSubscribeRequestError,
        errorKind,
      };
    }
    if (!res.ok) {
      const message =
        typeof (payload as ErrorResponse).message === "string"
          ? (payload as ErrorResponse).message
          : `HTTP ${res.status}`;
      return { data: null, error: message, errorKind: "api" };
    }
    return { data: payload as T, error: null, errorKind: null };
  } catch (error) {
    console.info("[subscribe] network_error", {
      category: "network",
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return {
      data: null,
      error: safeSubscribeRequestError,
      errorKind: "network",
    };
  }
};

const waitForReconciliationOffset = (
  delayMs: number,
  signal: AbortSignal,
): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    if (delayMs <= 0) {
      resolve(true);
      return;
    }
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      window.clearTimeout(timeoutId);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export const reconcileSubscriptionStatus = async (
  externalSignal?: AbortSignal,
): Promise<SubscriptionReconciliationResult> => {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  if (externalSignal?.aborted) {
    controller.abort();
  }

  const startedAt = Date.now();
  let attempts = 0;
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, subscriptionReconciliationTimeoutMs);

  try {
    for (const [
      index,
      offsetMs,
    ] of subscriptionReconciliationOffsetsMs.entries()) {
      const delayMs = Math.max(0, startedAt + offsetMs - Date.now());
      if (!(await waitForReconciliationOffset(delayMs, controller.signal))) {
        break;
      }

      attempts = index + 1;
      const result = await requestSubscribeJson<RefreshResponse>(
        "/api/refresh",
        { signal: controller.signal },
      );
      if (controller.signal.aborted) {
        break;
      }

      const refreshedState = result.data?.state ?? null;
      const confirmed =
        refreshedState !== null &&
        "subscribed" in refreshedState &&
        refreshedState.subscribed;
      console.info("[subscribe-reconciliation] attempt", {
        attempt: index + 1,
        elapsedMs: Date.now() - startedAt,
        category: confirmed ? "confirmed" : (result.errorKind ?? "unconfirmed"),
        outcome: confirmed ? "success" : "continue",
      });
      if (confirmed) {
        console.info("[subscribe-reconciliation] terminal", {
          attempt: index + 1,
          elapsedMs: Date.now() - startedAt,
          outcome: "confirmed",
        });
        return { outcome: "confirmed", state: refreshedState };
      }
    }

    if (!controller.signal.aborted) {
      await waitForReconciliationOffset(
        Math.max(
          0,
          startedAt + subscriptionReconciliationTimeoutMs - Date.now(),
        ),
        controller.signal,
      );
    }
    const outcome = timedOut ? "timeout" : "aborted";
    console.info("[subscribe-reconciliation] terminal", {
      attempts,
      elapsedMs: Date.now() - startedAt,
      outcome,
    });
    return { outcome, state: null };
  } finally {
    window.clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
};

export const useSubGoal = () => {
  const [state, setState] = useState<SubGoalState | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const prohibited = error === prohibitedContentMessage;
  const realtimeConnectedRef = useRef(false);
  const noticeTimeoutRef = useRef<number | null>(null);
  const reconciliationAbortRef = useRef<AbortController | null>(null);
  const messages = getSubGoalPostMessages(state?.language);
  const postHeight = state?.postHeight;
  const recentSubscriber =
    postHeight === "tiny" || postHeight === "cta"
      ? null
      : state?.recentSubscriber;

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimeoutRef.current) {
      window.clearTimeout(noticeTimeoutRef.current);
    }
    noticeTimeoutRef.current = window.setTimeout(() => {
      setNotice(null);
    }, 2800);
  }, []);

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
      const noticeMessage = messages.subscriberNotice({
        username: recentSubscriber,
      });
      showNotice(noticeMessage);
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
    [messages, showNotice],
  );

  useEffect(
    () => () => {
      if (noticeTimeoutRef.current) {
        window.clearTimeout(noticeTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(
    () => () => {
      reconciliationAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (!recentSubscriber) {
      return;
    }
    showNotice(messages.subscriberNotice({ username: recentSubscriber }));
  }, [messages, recentSubscriber, showNotice]);

  const refresh = useCallback(async () => {
    const result = await requestJsonWithRetry<RefreshResponse>(
      "/api/refresh",
      undefined,
      {},
    );
    if (result.aborted) {
      return null;
    }
    if (result.error) {
      setError(result.error);
      return null;
    }
    setState(result.data?.state ?? null);
    setError(null);
    return result.data?.state ?? null;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let cancelled = false;

    const runInit = async () => {
      const result = await requestJsonWithRetry<InitResponse>(
        "/api/init",
        { signal },
        initRetryOptions,
      );
      if (cancelled || result.aborted) {
        return;
      }
      if (result.error) {
        setError(result.error);
        setLoading(false);
        return;
      }
      setState(result.data?.state ?? null);
      setError(null);
      setLoading(false);
    };

    void runInit();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (loading || state !== null || prohibited) {
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;
    const startedAt = Date.now();

    const runRecovery = async () => {
      if (cancelled || state !== null) {
        return;
      }

      const result = await requestJsonWithRetry<InitResponse>(
        "/api/init",
        undefined,
        {
          ...initRetryOptions,
          maxDurationMs: 3000,
        },
      );
      if (cancelled || result.aborted) {
        return;
      }
      if (result.error) {
        setError(result.error);
        const elapsed = Date.now() - startedAt;
        if (elapsed >= recoveryWindowMs) {
          return;
        }
        timeoutId = window.setTimeout(() => {
          void runRecovery();
        }, recoveryIntervalMs);
        return;
      }

      const nextState = result.data?.state ?? null;
      if (!nextState) {
        setError("Initialization returned no state.");
        const elapsed = Date.now() - startedAt;
        if (elapsed >= recoveryWindowMs) {
          return;
        }
        timeoutId = window.setTimeout(() => {
          void runRecovery();
        }, recoveryIntervalMs);
        return;
      }

      setState(nextState);
      setError(null);
    };

    timeoutId = window.setTimeout(() => {
      void runRecovery();
    }, recoveryIntervalMs);

    return () => {
      cancelled = true;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [loading, prohibited, state]);

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
    const connect = async () => {
      connection = await connectRealtime({
        channel: "subscriber_updates",
        onMessage: handleRealtimeMessage,
      });
    };
    void connect();

    return () => {
      if (connection) {
        void connection.disconnect();
      }
      realtimeConnectedRef.current = false;
    };
  }, [handleRealtimeMessage, postHeight]);

  useEffect(() => {
    if (!postHeight) {
      return;
    }
    const interval = window.setInterval(
      () => {
        void refresh();
      },
      postHeight === "tiny" || postHeight === "cta"
        ? tinyRefreshIntervalMs
        : regularRefreshIntervalMs,
    );
    return () => window.clearInterval(interval);
  }, [postHeight, refresh]);

  const subscribe = useCallback(
    async (payload?: SubscribeRequest): Promise<SubscribeResult> => {
      if (submitting) {
        return {
          state: null,
          error: null,
          journeyTelemetryHandled: false,
        };
      }
      setSubmitting(true);
      const result = await requestSubscribeJson<SubscribeResponse>(
        "/api/subscribe",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...goalJourneyAnalytics.journeyHeaders(),
          },
          body: JSON.stringify(payload ?? {}),
        },
      );
      if (result.error) {
        const reconciliationController = new AbortController();
        reconciliationAbortRef.current = reconciliationController;
        const reconciliation = await reconcileSubscriptionStatus(
          reconciliationController.signal,
        );
        if (reconciliationAbortRef.current === reconciliationController) {
          reconciliationAbortRef.current = null;
        }
        if (reconciliation.outcome === "aborted") {
          return {
            state: null,
            error: null,
            journeyTelemetryHandled: false,
          };
        }
        if (reconciliation.outcome === "confirmed") {
          setState(reconciliation.state);
          setError(null);
          setSubmitting(false);
          return {
            state: reconciliation.state,
            error: null,
            journeyTelemetryHandled: false,
          };
        }

        const userSafeError =
          result.errorKind === "api"
            ? result.error
            : messages.subscribeErrorToast;
        setError(userSafeError);
        setSubmitting(false);
        return {
          state: null,
          error: userSafeError,
          journeyTelemetryHandled: false,
        };
      }

      const nextState = result.data?.state ?? null;
      setState(nextState);
      setError(null);
      setSubmitting(false);
      return {
        state: nextState,
        error: null,
        journeyTelemetryHandled: result.data?.journeyTelemetryHandled === true,
      };
    },
    [messages.subscribeErrorToast, submitting],
  );

  return {
    state,
    loading,
    submitting,
    error,
    refresh,
    subscribe,
    setError,
    notice,
    showNotice,
    prohibited,
  } as const;
};
