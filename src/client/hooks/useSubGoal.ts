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
import { subGoalLanguages } from "../../shared/subGoalPostI18n";
import { isSubGoalColorTheme } from "../../shared/subGoalColorTheme";
import { requestJsonWithRetry } from "../utils/fetchWithRetry";
import { prohibitedContentMessage } from "../../shared/contentPolicy";
import { goalJourneyAnalytics } from "../analytics/goalJourneyAnalytics";
import { logDiagnostic } from "../../shared/diagnostics";

type RequestResult<T> = {
  data: T | null;
  error: string | null;
  errorKind:
    | "api"
    | "gateway"
    | "network"
    | "protocol"
    | "timeout"
    | "aborted"
    | null;
  status: number | null;
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
const subscriptionMutationTimeoutMs = 10000;
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
  validate?: (payload: unknown) => payload is T,
  options: { timeoutMs?: number } = {},
): Promise<RequestResult<T>> => {
  const externalSignal = init?.signal ?? undefined;
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  if (externalSignal?.aborted) controller.abort();
  const timeoutId =
    options.timeoutMs === undefined
      ? null
      : window.setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, options.timeoutMs);
  try {
    const res = await fetch(input, { ...(init ?? {}), signal: controller.signal });
    const body = await res.text();
    let payload: T | ErrorResponse;
    try {
      payload = JSON.parse(body) as T | ErrorResponse;
    } catch {
      const errorKind = classifyNonJsonResponse(body);
      logDiagnostic("warn", "subscribe_non_json_response", {
        workflow: "subscribe",
        status: res.status,
        contentType: res.headers.get("content-type") ?? "unknown",
        phase: errorKind,
        bodyLength: body.length,
      });
      return {
        data: null,
        error: safeSubscribeRequestError,
        errorKind,
        status: res.status,
      };
    }
    if (!res.ok) {
      const message =
        typeof (payload as ErrorResponse).message === "string"
          ? (payload as ErrorResponse).message
          : `HTTP ${res.status}`;
      logDiagnostic("warn", "subscribe_api_error", {
        workflow: "subscribe",
        phase: "http_error",
        status: res.status,
      });
      return {
        data: null,
        error: message,
        errorKind: "api",
        status: res.status,
      };
    }
    if (validate && !validate(payload)) {
      logDiagnostic("warn", "subscribe_invalid_success_payload", {
        workflow: "subscribe",
        status: res.status,
        contentType: res.headers.get("content-type") ?? "unknown",
        phase: "protocol",
      });
      return {
        data: null,
        error: safeSubscribeRequestError,
        errorKind: "protocol",
        status: res.status,
      };
    }
    return {
      data: payload as T,
      error: null,
      errorKind: null,
      status: res.status,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      if (timedOut) {
        logDiagnostic(
          "warn",
          "subscribe_request_timeout",
          { workflow: "subscribe", phase: "mutation", timeoutMs: options.timeoutMs },
          error,
        );
        return {
          data: null,
          error: safeSubscribeRequestError,
          errorKind: "timeout",
          status: null,
        };
      }
      logDiagnostic("info", "subscribe_request_aborted", {
        workflow: "subscribe",
        phase: "cancellation",
      });
      return {
        data: null,
        error: null,
        errorKind: "aborted",
        status: null,
      };
    }
    logDiagnostic(
      "error",
      "subscribe_network_error",
      { workflow: "subscribe", phase: "network" },
      error,
    );
    return {
      data: null,
      error: safeSubscribeRequestError,
      errorKind: "network",
      status: null,
    };
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNullableFiniteNumber = (value: unknown): boolean =>
  value === null || isFiniteNumber(value);

const isNullableString = (value: unknown): boolean =>
  value === null || typeof value === "string";

const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname.length > 0
    );
  } catch {
    // diagnostic-allow-silent: URL parsing is an expected validation probe.
    return false;
  }
};

const isAfterSubscribeAction = (value: unknown): boolean => {
  if (!isObject(value) || typeof value.type !== "string") return false;
  if (value.type === "disabled") return true;
  if (
    value.type !== "link" &&
    value.type !== "top-post-day" &&
    value.type !== "newest-post"
  ) {
    return false;
  }
  if (
    typeof value.buttonText !== "string" ||
    value.buttonText.length === 0 ||
    !isSubGoalColorTheme(value.colorTheme)
  ) {
    return false;
  }
  return value.type !== "link" || isHttpUrl(value.url);
};

const isCtaActivity = (value: unknown): boolean =>
  isObject(value) &&
  (value.kind === "posts" || value.kind === "clicks") &&
  isFiniteNumber(value.count) &&
  value.count >= 0 &&
  (value.period === "today" || value.period === "week");

const isCompactSubreddit = (value: unknown): boolean =>
  isObject(value) &&
  typeof value.name === "string" &&
  value.name.length > 0 &&
  isFiniteNumber(value.subscribers) &&
  value.subscribers >= 0 &&
  isObject(value.growth) &&
  isFiniteNumber(value.growth.count) &&
  (value.growth.period === "today" || value.growth.period === "week");

const hasValidSharedState = (value: Record<string, unknown>): boolean =>
  isSubGoalColorTheme(value.colorTheme) &&
  subGoalLanguages.includes(value.language as (typeof subGoalLanguages)[number]) &&
  isAfterSubscribeAction(value.afterSubscribeAction) &&
  (value.trackCtaClicks === undefined ||
    typeof value.trackCtaClicks === "boolean");

export const isSubGoalState = (value: unknown): value is SubGoalState => {
  if (!isObject(value) || !hasValidSharedState(value)) return false;
  if (value.postHeight === "tiny" || value.postHeight === "cta") {
    return (
      typeof value.promoSubreddit === "string" &&
      value.promoSubreddit.length > 0 &&
      isCompactSubreddit(value.subreddit) &&
      (value.ctaActivity === undefined || isCtaActivity(value.ctaActivity)) &&
      (value.postHeight === "cta" ||
        (typeof value.subscribed === "boolean" &&
          typeof value.authenticated === "boolean"))
    );
  }
  if (value.postHeight !== "short" && value.postHeight !== "regular") {
    return false;
  }
  const subreddit = value.subreddit;
  const user = value.user;
  const appSettings = value.appSettings;
  return (
    isObject(subreddit) &&
    typeof subreddit.id === "string" &&
    subreddit.id.length > 0 &&
    typeof subreddit.name === "string" &&
    subreddit.name.length > 0 &&
    typeof subreddit.icon === "string" &&
    isFiniteNumber(subreddit.subscribers) &&
    subreddit.subscribers >= 0 &&
    typeof subreddit.isNsfw === "boolean" &&
    typeof value.subscribed === "boolean" &&
    isNullableFiniteNumber(value.goal) &&
    (value.goal === null || (value.goal as number) > 0) &&
    isNullableString(value.recentSubscriber) &&
    isNullableFiniteNumber(value.completedTime) &&
    (value.completedTime === null || (value.completedTime as number) >= 0) &&
    isNullableString(value.headerText) &&
    (user === null ||
      (isObject(user) &&
        typeof user.id === "string" &&
        user.id.length > 0 &&
        typeof user.username === "string" &&
        user.username.length > 0)) &&
    isObject(appSettings) &&
    typeof appSettings.promoSubreddit === "string" &&
    appSettings.promoSubreddit.length > 0
  );
};

const isRefreshResponse = (value: unknown): value is RefreshResponse =>
  isObject(value) &&
  value.type === "refresh" &&
  typeof value.postId === "string" &&
  value.postId.length > 0 &&
  isSubGoalState(value.state) &&
  (value.subscriptionAttemptConfirmed === undefined ||
    typeof value.subscriptionAttemptConfirmed === "boolean");

const isInitResponse = (value: unknown): value is InitResponse =>
  isObject(value) &&
  value.type === "init" &&
  typeof value.postId === "string" &&
  value.postId.length > 0 &&
  isSubGoalState(value.state);

const isSubscribeResponse = (value: unknown): value is SubscribeResponse =>
  isObject(value) &&
  value.type === "subscribe" &&
  typeof value.postId === "string" &&
  value.postId.length > 0 &&
  isSubGoalState(value.state) &&
  (value.journeyTelemetryHandled === undefined ||
    typeof value.journeyTelemetryHandled === "boolean");

const createSubscriptionAttemptId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
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
  attemptId: string,
  externalSignal?: AbortSignal,
): Promise<SubscriptionReconciliationResult> => {
  const attemptRef = attemptId.slice(0, 8);
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
    let index = 0;
    while (index < subscriptionReconciliationOffsetsMs.length) {
      const offsetMs = subscriptionReconciliationOffsetsMs[index]!;
      const delayMs = Math.max(0, startedAt + offsetMs - Date.now());
      if (!(await waitForReconciliationOffset(delayMs, controller.signal))) {
        break;
      }
      if (Date.now() - startedAt >= subscriptionReconciliationTimeoutMs) {
        timedOut = true;
        break;
      }

      attempts += 1;
      const result = await requestSubscribeJson<RefreshResponse>(
        `/api/refresh?attemptId=${encodeURIComponent(attemptId)}`,
        { signal: controller.signal },
        isRefreshResponse,
      );
      if (controller.signal.aborted) {
        break;
      }
      if (Date.now() - startedAt >= subscriptionReconciliationTimeoutMs) {
        timedOut = true;
        controller.abort();
        break;
      }

      const refreshedState = result.data?.state ?? null;
      const confirmed =
        refreshedState !== null &&
        result.data?.subscriptionAttemptConfirmed === true;
      logDiagnostic("info", "subscription_reconciliation_attempt", {
        workflow: "subscribe",
        phase: "reconciliation",
        attemptRef,
        attempt: attempts,
        elapsedMs: Date.now() - startedAt,
        category: confirmed ? "confirmed" : (result.errorKind ?? "unconfirmed"),
        outcome: confirmed ? "success" : "continue",
      });
      if (confirmed) {
        logDiagnostic("info", "subscription_reconciliation_completed", {
          workflow: "subscribe",
          phase: "reconciliation",
          attemptRef,
          attempt: attempts,
          elapsedMs: Date.now() - startedAt,
          outcome: "confirmed",
        });
        return { outcome: "confirmed", state: refreshedState };
      }
      index += 1;
      const elapsedMs = Date.now() - startedAt;
      while (
        index < subscriptionReconciliationOffsetsMs.length &&
        subscriptionReconciliationOffsetsMs[index]! <= elapsedMs
      ) {
        index += 1;
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
    const outcome =
      timedOut || Date.now() - startedAt >= subscriptionReconciliationTimeoutMs
        ? "timeout"
        : "aborted";
    logDiagnostic(
      outcome === "timeout" ? "error" : "info",
      outcome === "timeout"
        ? "subscription_reconciliation_timeout"
        : "subscription_reconciliation_aborted",
      {
        workflow: "subscribe",
        phase: "reconciliation",
        attemptRef,
        attempts,
        elapsedMs: Date.now() - startedAt,
        outcome,
      },
    );
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
  const subscriptionAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      subscriptionAbortRef.current?.abort();
    };
  }, []);

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
      { validate: isRefreshResponse },
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
        { ...initRetryOptions, validate: isInitResponse },
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

    void runInit().catch((error: unknown) => {
      logDiagnostic(
        "error",
        "client_async_handler_failed",
        { workflow: "init", phase: "unhandled" },
        error,
      );
    });

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
          validate: isInitResponse,
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
          void runRecovery().catch((error: unknown) => {
            logDiagnostic(
              "error",
              "client_async_handler_failed",
              { workflow: "init_recovery", phase: "unhandled" },
              error,
            );
          });
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
          void runRecovery().catch((error: unknown) => {
            logDiagnostic(
              "error",
              "client_async_handler_failed",
              { workflow: "init_recovery", phase: "unhandled" },
              error,
            );
          });
        }, recoveryIntervalMs);
        return;
      }

      setState(nextState);
      setError(null);
    };

    timeoutId = window.setTimeout(() => {
      void runRecovery().catch((error: unknown) => {
        logDiagnostic(
          "error",
          "client_async_handler_failed",
          { workflow: "init_recovery", phase: "unhandled" },
          error,
        );
      });
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

  useEffect(() => {
    if (!postHeight) {
      return;
    }
    const interval = window.setInterval(
      () => {
        void refresh().catch((error: unknown) => {
          logDiagnostic(
            "error",
            "client_async_handler_failed",
            { workflow: "refresh", phase: "interval" },
            error,
          );
        });
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
      const attemptId = createSubscriptionAttemptId();
      const subscriptionController = new AbortController();
      subscriptionAbortRef.current = subscriptionController;
      try {
        const result = await requestSubscribeJson<SubscribeResponse>(
          "/api/subscribe",
          {
            method: "POST",
            signal: subscriptionController.signal,
            headers: {
              "Content-Type": "application/json",
              ...goalJourneyAnalytics.journeyHeaders(),
            },
            body: JSON.stringify({
              ...(payload ?? {}),
              attemptId,
            } satisfies SubscribeRequest),
          },
          isSubscribeResponse,
          { timeoutMs: subscriptionMutationTimeoutMs },
        );
        if (result.errorKind === "aborted") {
          return {
            state: null,
            error: null,
            journeyTelemetryHandled: false,
          };
        }
        if (result.error) {
          if (result.status === 400 || result.status === 401) {
            if (mountedRef.current) setError(result.error);
            return {
              state: null,
              error: result.error,
              journeyTelemetryHandled: false,
            };
          }
          const reconciliation = await reconcileSubscriptionStatus(
            attemptId,
            subscriptionController.signal,
          );
          if (reconciliation.outcome === "aborted") {
            return {
              state: null,
              error: null,
              journeyTelemetryHandled: false,
            };
          }
          if (reconciliation.outcome === "confirmed") {
            if (mountedRef.current) {
              setState(reconciliation.state);
              setError(null);
            }
            return {
              state: reconciliation.state,
              error: null,
              journeyTelemetryHandled: false,
            };
          }

          const userSafeError = messages.subscribeErrorToast;
          if (mountedRef.current) setError(userSafeError);
          return {
            state: null,
            error: userSafeError,
            journeyTelemetryHandled: false,
          };
        }

        const nextState = result.data?.state ?? null;
        if (mountedRef.current) {
          setState(nextState);
          setError(null);
        }
        return {
          state: nextState,
          error: null,
          journeyTelemetryHandled:
            result.data?.journeyTelemetryHandled === true,
        };
      } finally {
        if (subscriptionAbortRef.current === subscriptionController) {
          subscriptionAbortRef.current = null;
        }
        if (mountedRef.current) setSubmitting(false);
      }
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
