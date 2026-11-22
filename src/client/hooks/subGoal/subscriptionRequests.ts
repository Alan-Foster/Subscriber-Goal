import type {
  ErrorResponse,
  RefreshResponse,
  SubGoalState,
} from "../../../shared/types/api";

import { logDiagnostic } from "../../../shared/diagnostics";
import {
  isMessageKey,
  translate,
  type MessageKey,
  type MessageValues,
} from "../../../shared/i18n/catalog";
import { isRefreshResponse } from "./stateValidation";

type RequestResult<T> = {
  data: T | null;
  error: string | null;
  errorMessageKey?: MessageKey;
  errorMessageParams?: MessageValues;
  errorKind:
    "api" | "gateway" | "network" | "protocol" | "timeout" | "aborted" | null;
  status: number | null;
};

type SubscriptionReconciliationResult =
  | { outcome: "confirmed"; state: SubGoalState }
  | { outcome: "timeout" | "aborted"; state: null };

const subscriptionReconciliationTimeoutMs = 30000;

const subscriptionReconciliationOffsetsMs = [
  0, 1000, 2000, 3000, 4000, 5000, 10000, 15000, 20000, 25000,
] as const;

const safeSubscribeRequestError = translate("en", "errors.join.transport");

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
    const res = await fetch(input, {
      ...(init ?? {}),
      signal: controller.signal,
    });
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
      const errorPayload = payload as ErrorResponse;
      const message =
        typeof errorPayload.message === "string"
          ? errorPayload.message
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
        ...(isMessageKey(errorPayload.messageKey)
          ? {
              errorMessageKey: errorPayload.messageKey,
              errorMessageParams: errorPayload.messageParams ?? {},
            }
          : {}),
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
          {
            workflow: "subscribe",
            phase: "mutation",
            timeoutMs: options.timeoutMs,
          },
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

export const createSubscriptionAttemptId = (): string => {
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
