import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { InitResponse, SubGoalState } from "../../../shared/types/api";
import { logDiagnostic } from "../../../shared/diagnostics";
import { localizeError } from "../../../shared/i18n/errors";
import { requestJsonWithRetry } from "../../utils/fetchWithRetry";
import { markInitEnd, markInitStart } from "../../utils/startupPerformance";
import {
  createStatisticsEventId,
  statisticsRequestHeaders,
} from "../../analytics/statisticsAnalytics";
import { isInitResponse } from "./stateValidation";

const initRetryOptions = {
  maxDurationMs: 8000,
  initialDelayMs: 200,
  delayMultiplier: 2,
  maxDelayMs: 1500,
  attemptTimeoutMs: 1500,
} as const;

const recoveryWindowMs = 30000;
const recoveryIntervalMs = 5000;

export function useSubGoalLoading({
  state,
  setState,
  setError,
  prohibited,
  loadError,
}: {
  state: SubGoalState | null;
  setState: Dispatch<SetStateAction<SubGoalState | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  prohibited: boolean;
  loadError: string;
}): boolean {
  const [loading, setLoading] = useState(true);
  const loadEventIdRef = useRef<string | null>(null);
  loadEventIdRef.current ??= createStatisticsEventId();

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let cancelled = false;

    const runInit = async () => {
      markInitStart();
      const result = await requestJsonWithRetry<InitResponse>(
        "/api/init",
        {
          signal,
          headers: statisticsRequestHeaders(
            loadEventIdRef.current ?? undefined,
          ),
        },
        { ...initRetryOptions, validate: isInitResponse },
      );
      if (cancelled || result.aborted) {
        return;
      }
      if (result.error) {
        setError(localizeError(undefined, result.errorResponse, result.error));
        setLoading(false);
        return;
      }
      markInitEnd();
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
  }, [setError, setState]);

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
        {
          headers: statisticsRequestHeaders(
            loadEventIdRef.current ?? undefined,
          ),
        },
        {
          ...initRetryOptions,
          maxDurationMs: 3000,
          validate: isInitResponse,
        },
      );
      if (cancelled || result.aborted) {
        return;
      }
      const nextState = result.data?.state ?? null;
      if (result.error || !nextState) {
        setError(
          result.error
            ? localizeError(undefined, result.errorResponse, result.error)
            : loadError,
        );
        if (Date.now() - startedAt < recoveryWindowMs) scheduleRecovery();
        return;
      }

      markInitEnd();
      setState(nextState);
      setError(null);
    };

    function scheduleRecovery(): void {
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
    }

    scheduleRecovery();

    return () => {
      cancelled = true;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [loading, loadError, prohibited, setError, setState, state]);

  return loading;
}
