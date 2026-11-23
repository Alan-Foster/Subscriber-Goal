import type { ErrorResponse } from "../../shared/types/api";
import { logDiagnostic } from "../../shared/diagnostics";
import { translate } from "../../shared/i18n/catalog";
import { getRetryWaitMs } from "./fetchRetryDelay";
import {
  classifyNonJsonBody,
  classifyRetryResponse,
} from "./fetchRetryResponse";

const invalidResponseMessage = translate(
  "en",
  "errors.network.invalidResponse",
);
const requestTimeoutMessage = translate("en", "errors.network.timeout");
const requestFailedMessage = translate("en", "errors.network.failed");

export type JsonRequestResult<T> = {
  data: T | null;
  error: string | null;
  errorResponse?: ErrorResponse;
  aborted: boolean;
  status?: number;
};

export type RetryTerminalReason =
  | "success"
  | "aborted"
  | "timeout"
  | "non_retryable_status"
  | "exhausted_budget";

export type RetryEvent =
  | {
      event: "attempt";
      attempt: number;
      remainingMs: number;
    }
  | {
      event: "retry_wait";
      attempt: number;
      waitMs: number;
      remainingMs: number;
      reason: "http_retryable" | "network_error" | "timeout" | "protocol_error";
      status?: number;
      error?: string;
    }
  | {
      event: "terminal";
      attempt: number;
      remainingMs: number;
      reason: RetryTerminalReason;
      status?: number;
      error?: string;
    };

function buildFetchInit(init?: RequestInit): RequestInit {
  if (!init) {
    return {};
  }
  const { signal, ...rest } = init;
  const out: RequestInit = { ...rest };
  if (signal != null) {
    out.signal = signal;
  }
  return out;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const id = window.setTimeout(() => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      resolve();
    }, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(id);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });

export type RequestJsonWithRetryOptions = {
  maxDurationMs?: number;
  initialDelayMs?: number;
  delayMultiplier?: number;
  maxDelayMs?: number;
  attemptTimeoutMs?: number;
  jitterRatio?: number;
  onEvent?: (event: RetryEvent) => void;
  debugLabel?: string;
  validate?: (payload: unknown) => boolean;
};

type AttemptContext = {
  attempt: number;
  timeLeft: () => number;
  emit: (event: RetryEvent) => void;
  abortSignal: AbortSignal | undefined;
  requestLabel: string;
  nextDelay: number;
  jitterRatio: number;
};

type AttemptResult<T> = "continue" | JsonRequestResult<T>;
type RetryDetails = Pick<
  Extract<RetryEvent, { event: "retry_wait" }>,
  "reason" | "status" | "error"
>;

function emitRetryEvent(
  options: RequestJsonWithRetryOptions,
  requestLabel: string,
  event: RetryEvent,
): void {
  options.onEvent?.(event);
  if (options.debugLabel) {
    console.info(
      `[fetch-retry:${options.debugLabel}] ${JSON.stringify(event)}`,
    );
  }
  const retrying = event.event === "retry_wait";
  if (
    !retrying &&
    (event.event !== "terminal" ||
      event.reason === "success" ||
      event.reason === "aborted")
  )
    return;
  logDiagnostic(
    retrying ? "warn" : "error",
    retrying ? "client_request_retry" : "client_request_failed",
    {
      workflow: requestLabel,
      phase: event.reason,
      status: event.status,
      attempt: event.attempt,
      remainingMs: event.remainingMs,
    },
    event.error,
  );
}

function abortRequest(context: AttemptContext): JsonRequestResult<never> {
  context.emit({
    event: "terminal",
    attempt: context.attempt,
    remainingMs: context.timeLeft(),
    reason: "aborted",
  });
  return { data: null, error: null, aborted: true };
}

async function waitThenRetry(
  context: AttemptContext,
  remainingMs: number,
  details: RetryDetails,
  waitMs = getRetryWaitMs(context.nextDelay, context.jitterRatio, remainingMs),
): Promise<AttemptResult<never>> {
  context.emit({
    event: "retry_wait",
    attempt: context.attempt,
    waitMs,
    remainingMs,
    ...details,
  });
  try {
    await sleep(waitMs, context.abortSignal);
  } catch {
    // diagnostic-allow-silent: an abort during retry sleep is expected cancellation.
    return abortRequest(context);
  }
  return "continue";
}

function parseResponse(
  response: Response,
  body: string,
  options: RequestJsonWithRetryOptions,
  requestLabel: string,
) {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    logDiagnostic("warn", "client_non_json_response", {
      workflow: requestLabel,
      phase: classifyNonJsonBody(body),
      status: response.status,
      contentType: response.headers.get("content-type") ?? "unknown",
      bodyLength: body.length,
    });
    return classifyRetryResponse(response.ok, response.status, {}, false);
  }
  if (response.ok && options.validate && !options.validate(payload)) {
    logDiagnostic("warn", "client_invalid_success_payload", {
      workflow: requestLabel,
      phase: "protocol",
      status: response.status,
      contentType: response.headers.get("content-type") ?? "unknown",
      bodyLength: body.length,
    });
    return classifyRetryResponse(response.ok, response.status, payload, false);
  }
  return classifyRetryResponse(response.ok, response.status, payload, true);
}

function handleResponse<T>(
  response: Response,
  body: string,
  options: RequestJsonWithRetryOptions,
  context: AttemptContext,
): AttemptResult<T> | Promise<AttemptResult<T>> {
  const result = parseResponse(response, body, options, context.requestLabel);
  const { status } = response;
  const { emit, attempt, timeLeft } = context;
  const remainingMs = timeLeft();
  switch (result.kind) {
    case "success":
      emit({
        event: "terminal",
        attempt,
        remainingMs,
        reason: "success",
        status,
      });
      return { data: result.data as T, error: null, aborted: false, status };
    case "protocol_error":
      if (remainingMs <= 0) {
        emit({
          event: "terminal",
          attempt,
          remainingMs: 0,
          reason: "exhausted_budget",
          status,
          error: invalidResponseMessage,
        });
        return { data: null, error: invalidResponseMessage, aborted: false };
      }
      return waitThenRetry(context, remainingMs, {
        reason: "protocol_error",
        status,
        error: invalidResponseMessage,
      });
    case "http_error":
      if (!result.retryable || remainingMs <= 0) {
        emit({
          event: "terminal",
          attempt,
          remainingMs,
          reason: result.retryable
            ? "exhausted_budget"
            : "non_retryable_status",
          status,
          error: result.error,
        });
        return {
          data: null,
          error: result.error,
          ...(result.errorResponse
            ? { errorResponse: result.errorResponse }
            : {}),
          aborted: false,
          status,
        };
      }
      return waitThenRetry(context, remainingMs, {
        reason: "http_retryable",
        status,
        error: result.error,
      });
  }
}

function handleAttemptTimeout(
  context: AttemptContext,
): AttemptResult<never> | Promise<AttemptResult<never>> {
  const { attempt, emit, timeLeft } = context;
  const remainingMs = timeLeft();
  if (remainingMs <= 0) {
    emit({
      event: "terminal",
      attempt,
      remainingMs: 0,
      reason: "timeout",
      error: requestTimeoutMessage,
    });
    return { data: null, error: requestTimeoutMessage, aborted: false };
  }
  return waitThenRetry(context, remainingMs, {
    reason: "timeout",
    error: requestTimeoutMessage,
  });
}

function handleNetworkError(
  context: AttemptContext,
  error: unknown,
): AttemptResult<never> | Promise<AttemptResult<never>> {
  const { attempt, emit, timeLeft } = context;
  const message = error instanceof Error ? error.message : requestFailedMessage;
  const remainingMs = timeLeft();
  const waitMs =
    remainingMs <= 0
      ? 0
      : getRetryWaitMs(context.nextDelay, context.jitterRatio, remainingMs);
  if (waitMs <= 0) {
    emit({
      event: "terminal",
      attempt,
      remainingMs,
      reason: "exhausted_budget",
      error: message,
    });
    return { data: null, error: message, aborted: false };
  }
  return waitThenRetry(
    context,
    remainingMs,
    { reason: "network_error", error: message },
    waitMs,
  );
}

async function runRequestAttempt<T>(
  input: RequestInfo,
  init: RequestInit | undefined,
  options: RequestJsonWithRetryOptions,
  context: AttemptContext,
  attemptTimeoutMs: number,
): Promise<AttemptResult<T>> {
  const { abortSignal } = context;
  let didAttemptTimeout = false;
  const attemptController = new AbortController();
  const onExternalAbort = () => attemptController.abort();
  const timeoutId = window.setTimeout(() => {
    didAttemptTimeout = true;
    attemptController.abort();
  }, attemptTimeoutMs);
  abortSignal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const response = await fetch(
      input,
      buildFetchInit({ ...(init ?? {}), signal: attemptController.signal }),
    );
    const body = await response.text();
    return await handleResponse<T>(response, body, options, context);
  } catch (error) {
    if (
      !didAttemptTimeout &&
      error instanceof DOMException &&
      error.name === "AbortError" &&
      abortSignal?.aborted
    ) {
      return abortRequest(context);
    }
    logDiagnostic(
      "warn",
      didAttemptTimeout
        ? "client_request_attempt_timeout"
        : "client_request_attempt_failed",
      {
        workflow: context.requestLabel,
        phase: "attempt",
        attempt: context.attempt,
      },
      error,
    );
    return didAttemptTimeout
      ? await handleAttemptTimeout(context)
      : await handleNetworkError(context, error);
  } finally {
    window.clearTimeout(timeoutId);
    abortSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * GET/POST JSON with retries for transient failures (network errors, 5xx, 429)
 * within a wall-clock budget. Does not retry 4xx (except 429).
 */
export async function requestJsonWithRetry<T>(
  input: RequestInfo,
  init: RequestInit | undefined,
  options: RequestJsonWithRetryOptions = {},
): Promise<JsonRequestResult<T>> {
  const maxDurationMs = options.maxDurationMs ?? 5000;
  const initialDelayMs = options.initialDelayMs ?? 200;
  const delayMultiplier = options.delayMultiplier ?? 2;
  const maxDelayMs = options.maxDelayMs ?? 1500;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 1500;
  const jitterRatio = options.jitterRatio ?? 0.15;
  const abortSignal = init?.signal ?? undefined;
  const requestLabel =
    options.debugLabel ??
    (typeof input === "string"
      ? (input.split("?")[0] ?? "request")
      : "request");
  const start = Date.now();
  const timeLeft = () => Math.max(0, maxDurationMs - (Date.now() - start));
  const emit = (event: RetryEvent) =>
    emitRetryEvent(options, requestLabel, event);

  let nextDelay = initialDelayMs;
  for (let attempt = 1; ; attempt += 1) {
    const context = {
      attempt,
      timeLeft,
      emit,
      requestLabel,
      abortSignal,
      nextDelay,
      jitterRatio,
    };
    emit({ event: "attempt", attempt, remainingMs: timeLeft() });
    if (abortSignal?.aborted) return abortRequest(context);
    const result = await runRequestAttempt<T>(
      input,
      init,
      options,
      context,
      attemptTimeoutMs,
    );
    if (result !== "continue") return result;
    nextDelay = Math.min(nextDelay * delayMultiplier, maxDelayMs);
  }
}
