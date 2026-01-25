import { connectRealtime } from '@devvit/web/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DebugRealtimeRequest,
  ErrorResponse,
  InitResponse,
  RealtimeMessage,
  RefreshResponse,
  SubGoalState,
  SubscribeRequest,
  SubscribeResponse,
} from '../../shared/types/api';

type RequestResult<T> = {
  data: T | null;
  error: string | null;
};

type SubscribeResult = {
  state: SubGoalState | null;
  error: string | null;
};

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
    const result = await requestJson<RefreshResponse>('/api/refresh');
    if (result.error) {
      setError(result.error);
      return null;
    }
    setState(result.data?.state ?? null);
    setError(null);
    return result.data?.state ?? null;
  }, []);

  useEffect(() => {
    const init = async () => {
      const result = await requestJson<InitResponse>('/api/init');
      if (result.error) {
        setError(result.error);
        setLoading(false);
        return;
      }
      setState(result.data?.state ?? null);
      setError(null);
      setLoading(false);
    };
    void init();
  }, []);

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

  const simulateSubscribe = useCallback(
    (shareUsername: boolean): SubGoalState | null => {
    if (!state) {
      return null;
    }
    const nextSubscribers = state.subreddit.subscribers + 1;
      const recentSubscriber = shareUsername
        ? state.user?.username ?? 'debug_user'
        : null;
    const completedTime =
      state.goal && nextSubscribers >= state.goal
        ? Date.now()
        : state.completedTime;

    const nextState: SubGoalState = {
      ...state,
      subscribed: true,
        recentSubscriber,
      completedTime,
      subreddit: {
        ...state.subreddit,
        subscribers: nextSubscribers,
      },
    };
    setState(nextState);
    return nextState;
    },
    [state]
  );

  const sendDebugRealtime = useCallback(
    async (payload: DebugRealtimeRequest): Promise<string | null> => {
      const result = await requestJson<{ status: string }>('/api/debug/realtime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (result.error) {
        setError(result.error);
        return result.error;
      }
      return null;
    },
    []
  );

  const simulateIncrement = useCallback((): SubGoalState | null => {
    if (!state) {
      return null;
    }
    const nextSubscribers = state.subreddit.subscribers + 1;
    const completedTime =
      state.goal && nextSubscribers >= state.goal
        ? Date.now()
        : state.completedTime;

    const nextState: SubGoalState = {
      ...state,
      completedTime,
      subreddit: {
        ...state.subreddit,
        subscribers: nextSubscribers,
      },
    };
    setState(nextState);
    return nextState;
  }, [state]);

  return {
    state,
    loading,
    submitting,
    error,
    refresh,
    subscribe,
    simulateSubscribe,
    simulateIncrement,
    sendDebugRealtime,
    setError,
    notice,
    showNotice,
  } as const;
};
