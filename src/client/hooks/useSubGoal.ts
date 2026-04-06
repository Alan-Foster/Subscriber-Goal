import { connectRealtime } from '@devvit/web/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ErrorResponse,
  InitResponse,
  RealtimeMessage,
  RefreshResponse,
  SubGoalState,
  SubscribeRequest,
  SubscribeResponse,
} from '../../shared/types/api';
import { requestJsonWithRetry } from '../utils/fetchWithRetry';

type RequestResult<T> = {
  data: T | null;
  error: string | null;
};

type SubscribeResult = {
  state: SubGoalState | null;
  error: string | null;
};

const initRetryOptions = {
  maxDurationMs: 8000,
  initialDelayMs: 200,
  delayMultiplier: 2,
  maxDelayMs: 1500,
  attemptTimeoutMs: 1500,
} as const;

const recoveryWindowMs = 30000;
const recoveryIntervalMs = 5000;

const requestJson = async <T>(input: RequestInfo, init?: RequestInit): Promise<RequestResult<T>> => {
  try {
    const res = await fetch(input, init);
    const payload = (await res.json()) as T | ErrorResponse;
    if (!res.ok) {
      const message =
        typeof (payload as ErrorResponse).message === 'string'
          ? (payload as ErrorResponse).message
          : `HTTP ${res.status}`;
      return { data: null, error: message };
    }
    return { data: payload as T, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed';
    return { data: null, error: message };
  }
};

export const useSubGoal = () => {
  const [state, setState] = useState<SubGoalState | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const realtimeConnectedRef = useRef(false);
  const noticeTimeoutRef = useRef<number | null>(null);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimeoutRef.current) {
      window.clearTimeout(noticeTimeoutRef.current);
    }
    noticeTimeoutRef.current = window.setTimeout(() => {
      setNotice(null);
    }, 2800);
  }, []);

  const handleRealtimeMessage = useCallback((data: unknown) => {
    const message = data as Partial<RealtimeMessage>;
    if (!message || message.type !== 'sub' || typeof message.newSubscriberCount !== 'number') {
      return;
    }
    const newSubscriberCount = message.newSubscriberCount;
    const recentSubscriber =
      typeof message.recentSubscriber === 'string' && message.recentSubscriber.length > 0
        ? message.recentSubscriber
        : null;
    const noticeMessage = recentSubscriber
      ? `u/${recentSubscriber} just subscribed!`
      : 'New member just subscribed!';
    showNotice(noticeMessage);
    setState((prev) => {
      if (!prev) {
        return prev;
      }
      const completedTime =
        prev.goal && newSubscriberCount >= prev.goal
          ? prev.completedTime ?? Date.now()
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
  }, [showNotice]);

  useEffect(
    () => () => {
      if (noticeTimeoutRef.current) {
        window.clearTimeout(noticeTimeoutRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (!state?.recentSubscriber) {
      return;
    }
    showNotice(`u/${state.recentSubscriber} just subscribed!`);
  }, [state?.recentSubscriber, showNotice]);

  const refresh = useCallback(async () => {
    const result = await requestJsonWithRetry<RefreshResponse>('/api/refresh', undefined, {});
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
        '/api/init',
        { signal },
        initRetryOptions
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
    if (loading || state !== null) {
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
        '/api/init',
        undefined,
        {
          ...initRetryOptions,
          maxDurationMs: 3000,
        }
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
        setError('Initialization returned no state.');
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
  }, [loading, state]);

  useEffect(() => {
    if (realtimeConnectedRef.current) {
      return;
    }
    realtimeConnectedRef.current = true;

    let connection: { disconnect: () => Promise<void> } | null = null;
    const connect = async () => {
      connection = await connectRealtime({
        channel: 'subscriber_updates',
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
  }, [handleRealtimeMessage]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refresh();
    }, 30000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const subscribe = useCallback(
    async (payload?: SubscribeRequest): Promise<SubscribeResult> => {
    if (submitting) {
      return { state: null, error: null };
    }
    setSubmitting(true);
    const result = await requestJson<SubscribeResponse>('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
    });
    setSubmitting(false);

    if (result.error) {
      setError(result.error);
      return { state: null, error: result.error };
    }

    const nextState = result.data?.state ?? null;
    setState(nextState);
    setError(null);
    return { state: nextState, error: null };
    },
    [submitting]
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
  } as const;
};
