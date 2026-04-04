import type { ErrorResponse } from '../../shared/types/api';

export type JsonRequestResult<T> = {
  data: T | null;
  error: string | null;
  aborted: boolean;
};

export type RetryTerminalReason =
  | 'success'
  | 'aborted'
  | 'timeout'
  | 'non_retryable_status'
  | 'exhausted_budget';

export type RetryEvent =
  | {
      event: 'attempt';
      attempt: number;
      remainingMs: number;
    }
  | {
      event: 'retry_wait';
      attempt: number;
      waitMs: number;
      remainingMs: number;
      reason: 'http_retryable' | 'network_error' | 'timeout';
      status?: number;
      error?: string;
    }
  | {
      event: 'terminal';
      attempt: number;
      remainingMs: number;
      reason: RetryTerminalReason;
      status?: number;
      error?: string;
    };

function isRetryableHttpStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

function errorMessageFromPayload(payload: unknown, status: number): string {
  if (
    payload &&
    typeof payload === 'object' &&
    'message' in payload &&
    typeof (payload as ErrorResponse).message === 'string'
  ) {
    return (payload as ErrorResponse).message;
  }
  return `HTTP ${status}`;
}

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

const sleep = (ms: number, signal?: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const id = window.setTimeout(() => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      resolve();
    }, ms);
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(id);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
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
};

/**
 * GET/POST JSON with retries for transient failures (network errors, 5xx, 429)
 * within a wall-clock budget. Does not retry 4xx (except 429).
 */
export async function requestJsonWithRetry<T>(
  input: RequestInfo,
  init: RequestInit | undefined,
  options: RequestJsonWithRetryOptions = {}
): Promise<JsonRequestResult<T>> {
  const maxDurationMs = options.maxDurationMs ?? 5000;
  const initialDelayMs = options.initialDelayMs ?? 200;
  const delayMultiplier = options.delayMultiplier ?? 2;
  const maxDelayMs = options.maxDelayMs ?? 1500;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 1500;
  const jitterRatio = options.jitterRatio ?? 0.15;

  const abortSignal = init?.signal ?? undefined;
  const start = Date.now();
  const timeLeft = (): number => Math.max(0, maxDurationMs - (Date.now() - start));
  const emit = (event: RetryEvent): void => {
    options.onEvent?.(event);
    if (!options.debugLabel) {
      return;
    }
    console.info(
      `[fetch-retry:${options.debugLabel}] ${JSON.stringify(event)}`
    );
  };
  const withJitter = (baseMs: number): number => {
    if (baseMs <= 0 || jitterRatio <= 0) {
      return baseMs;
    }
    const factor = 1 + (Math.random() * 2 - 1) * jitterRatio;
    return Math.max(0, Math.round(baseMs * factor));
  };

  let nextDelay = initialDelayMs;
  let attempt = 0;

  while (true) {
    attempt += 1;
    emit({ event: 'attempt', attempt, remainingMs: timeLeft() });

    if (abortSignal?.aborted) {
      emit({
        event: 'terminal',
        attempt,
        remainingMs: timeLeft(),
        reason: 'aborted',
      });
      return { data: null, error: null, aborted: true };
    }

    let didAttemptTimeout = false;
    const attemptController = new AbortController();
    const onExternalAbort = () => {
      attemptController.abort();
    };
    const timeoutId = window.setTimeout(() => {
      didAttemptTimeout = true;
      attemptController.abort();
    }, attemptTimeoutMs);
    abortSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const res = await fetch(
        input,
        buildFetchInit({ ...(init ?? {}), signal: attemptController.signal })
      );
      let payload: unknown = {};
      try {
        payload = await res.json();
      } catch {
        payload = {};
      }

      if (res.ok) {
        emit({
          event: 'terminal',
          attempt,
          remainingMs: timeLeft(),
          reason: 'success',
          status: res.status,
        });
        return { data: payload as T, error: null, aborted: false };
      }

      const errMsg = errorMessageFromPayload(payload, res.status);

      if (!isRetryableHttpStatus(res.status)) {
        emit({
          event: 'terminal',
          attempt,
          remainingMs: timeLeft(),
          reason: 'non_retryable_status',
          status: res.status,
          error: errMsg,
        });
        return { data: null, error: errMsg, aborted: false };
      }

      const remaining = timeLeft();
      if (remaining <= 0) {
        emit({
          event: 'terminal',
          attempt,
          remainingMs: 0,
          reason: 'exhausted_budget',
          status: res.status,
          error: errMsg,
        });
        return { data: null, error: errMsg, aborted: false };
      }

      const wait = Math.min(withJitter(nextDelay), remaining);
      emit({
        event: 'retry_wait',
        attempt,
        waitMs: wait,
        remainingMs: remaining,
        reason: 'http_retryable',
        status: res.status,
        error: errMsg,
      });
      try {
        await sleep(wait, abortSignal);
      } catch {
        emit({
          event: 'terminal',
          attempt,
          remainingMs: timeLeft(),
          reason: 'aborted',
        });
        return { data: null, error: null, aborted: true };
      }

      nextDelay = Math.min(nextDelay * delayMultiplier, maxDelayMs);
    } catch (error) {
      if (didAttemptTimeout) {
        const remaining = timeLeft();
        if (remaining <= 0) {
          emit({
            event: 'terminal',
            attempt,
            remainingMs: 0,
            reason: 'timeout',
            error: 'Request timed out',
          });
          return { data: null, error: 'Request timed out', aborted: false };
        }

        const wait = Math.min(withJitter(nextDelay), remaining);
        emit({
          event: 'retry_wait',
          attempt,
          waitMs: wait,
          remainingMs: remaining,
          reason: 'timeout',
          error: 'Request timed out',
        });
        try {
          await sleep(wait, abortSignal);
        } catch {
          emit({
            event: 'terminal',
            attempt,
            remainingMs: timeLeft(),
            reason: 'aborted',
          });
          return { data: null, error: null, aborted: true };
        }
        nextDelay = Math.min(nextDelay * delayMultiplier, maxDelayMs);
        continue;
      }

      if (
        error instanceof DOMException &&
        error.name === 'AbortError' &&
        abortSignal?.aborted
      ) {
        emit({
          event: 'terminal',
          attempt,
          remainingMs: timeLeft(),
          reason: 'aborted',
        });
        return { data: null, error: null, aborted: true };
      }

      const message = error instanceof Error ? error.message : 'Request failed';
      const remaining = timeLeft();
      if (remaining <= 0) {
        emit({
          event: 'terminal',
          attempt,
          remainingMs: 0,
          reason: 'exhausted_budget',
          error: message,
        });
        return { data: null, error: message, aborted: false };
      }

      const wait = Math.min(withJitter(nextDelay), remaining);
      if (wait <= 0) {
        emit({
          event: 'terminal',
          attempt,
          remainingMs: remaining,
          reason: 'exhausted_budget',
          error: message,
        });
        return { data: null, error: message, aborted: false };
      }

      emit({
        event: 'retry_wait',
        attempt,
        waitMs: wait,
        remainingMs: remaining,
        reason: 'network_error',
        error: message,
      });
      try {
        await sleep(wait, abortSignal);
      } catch {
        emit({
          event: 'terminal',
          attempt,
          remainingMs: timeLeft(),
          reason: 'aborted',
        });
        return { data: null, error: null, aborted: true };
      }

      nextDelay = Math.min(nextDelay * delayMultiplier, maxDelayMs);
    } finally {
      window.clearTimeout(timeoutId);
      abortSignal?.removeEventListener('abort', onExternalAbort);
    }
  }
}
