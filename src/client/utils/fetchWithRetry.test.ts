// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { requestJsonWithRetry, type RetryEvent } from './fetchWithRetry';

const jsonResponse = (payload: unknown, status: number): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('requestJsonWithRetry', () => {
  it('retries a transient network error and then succeeds', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('temporary network issue');
        }
        return jsonResponse({ ok: true }, 200);
      })
    );

    const result = await requestJsonWithRetry<{ ok: boolean }>(
      '/api/init',
      undefined,
      {
        maxDurationMs: 1000,
        initialDelayMs: 1,
        maxDelayMs: 1,
        attemptTimeoutMs: 100,
      }
    );

    expect(result.error).toBeNull();
    expect(result.data).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('retries 503/429 but does not retry 400', async () => {
    let calls503 = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls503 += 1;
        if (calls503 === 1) {
          return jsonResponse({ message: 'unavailable' }, 503);
        }
        return jsonResponse({ ok: true }, 200);
      })
    );

    const retryableResult = await requestJsonWithRetry<{ ok: boolean }>(
      '/api/init',
      undefined,
      { maxDurationMs: 1000, initialDelayMs: 1, maxDelayMs: 1 }
    );
    expect(retryableResult.error).toBeNull();
    expect(retryableResult.data).toEqual({ ok: true });
    expect(calls503).toBe(2);

    let calls400 = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls400 += 1;
        return jsonResponse({ message: 'bad request' }, 400);
      })
    );
    const nonRetryableResult = await requestJsonWithRetry<{ ok: boolean }>(
      '/api/init',
      undefined,
      { maxDurationMs: 1000, initialDelayMs: 1, maxDelayMs: 1 }
    );
    expect(nonRetryableResult.error).toBe('bad request');
    expect(nonRetryableResult.data).toBeNull();
    expect(calls400).toBe(1);
  });

  it('times out a hanging attempt and proceeds to a later successful attempt', async () => {
    let calls = 0;
    const events: RetryEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true }
            );
          });
        }
        return Promise.resolve(jsonResponse({ ok: true }, 200));
      })
    );

    const result = await requestJsonWithRetry<{ ok: boolean }>(
      '/api/init',
      undefined,
      {
        maxDurationMs: 1000,
        initialDelayMs: 1,
        maxDelayMs: 1,
        attemptTimeoutMs: 20,
        onEvent: (event) => events.push(event),
      }
    );

    expect(result.error).toBeNull();
    expect(result.data).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(
      events.some(
        (event) => event.event === 'retry_wait' && event.reason === 'timeout'
      )
    ).toBe(true);
  });

  it('honors maxDurationMs and returns a deterministic terminal error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ message: 'unavailable' }, 503))
    );

    const result = await requestJsonWithRetry<{ ok: boolean }>(
      '/api/init',
      undefined,
      {
        maxDurationMs: 15,
        initialDelayMs: 10,
        maxDelayMs: 10,
        attemptTimeoutMs: 100,
      }
    );

    expect(result.data).toBeNull();
    expect(result.error).toBe('unavailable');
    expect(result.aborted).toBe(false);
  });
});
