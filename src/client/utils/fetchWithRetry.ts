import type { ErrorResponse } from '../../shared/types/api';

export type JsonRequestResult<T> = {
  data: T | null;
  error: string | null;
  aborted: boolean;
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

  const abortSignal = init?.signal ?? undefined;
  const start = Date.now();
  const timeLeft = (): number => Math.max(0, maxDurationMs - (Date.now() - start));

  let nextDelay = initialDelayMs;

  while (true) {
    if (abortSignal?.aborted) {
      return { data: null, error: null, aborted: true };
    }

    try {
      const res = await fetch(input, buildFetchInit(init));
      let payload: unknown = {};
      try {
        payload = await res.json();
      } catch {
        payload = {};
      }

      if (res.ok) {
        return { data: payload as T, error: null, aborted: false };
      }

      const errMsg = errorMessageFromPayload(payload, res.status);

      if (!isRetryableHttpStatus(res.status)) {
        return { data: null, error: errMsg, aborted: false };
      }

      const remaining = timeLeft();
      if (remaining <= 0) {
        return { data: null, error: errMsg, aborted: false };
      }

      const wait = Math.min(nextDelay, remaining);
      try {
        await sleep(wait, abortSignal);
      } catch {
        return { data: null, error: null, aborted: true };
      }

      nextDelay = Math.min(nextDelay * delayMultiplier, maxDelayMs);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { data: null, error: null, aborted: true };
      }

      const message = error instanceof Error ? error.message : 'Request failed';
      const remaining = timeLeft();
      if (remaining <= 0) {
        return { data: null, error: message, aborted: false };
      }

      const wait = Math.min(nextDelay, remaining);
      if (wait <= 0) {
        return { data: null, error: message, aborted: false };
      }

      try {
        await sleep(wait, abortSignal);
      } catch {
        return { data: null, error: null, aborted: true };
      }

      nextDelay = Math.min(nextDelay * delayMultiplier, maxDelayMs);
    }
  }
}
