import {
  useCallback,
  useEffect,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { RefreshResponse, SubGoalState } from "../../../shared/types/api";
import { logDiagnostic } from "../../../shared/diagnostics";
import { localizeError } from "../../../shared/i18n/errors";
import { requestJsonWithRetry } from "../../utils/fetchWithRetry";
import { isRefreshResponse } from "./stateValidation";

const regularRefreshIntervalMs = 30000;
const tinyRefreshIntervalMs = 60000;

export function useSubGoalRefresh({
  postHeight,
  language,
  loadError,
  setState,
  setError,
}: {
  postHeight: SubGoalState["postHeight"] | undefined;
  language: SubGoalState["language"] | undefined;
  loadError: string;
  setState: Dispatch<SetStateAction<SubGoalState | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  const requestRefresh = useCallback(async () => {
    const result = await requestJsonWithRetry<RefreshResponse>(
      "/api/refresh",
      undefined,
      { maxDurationMs: 0, validate: isRefreshResponse },
    );
    if (result.aborted) {
      return { state: null, succeeded: false };
    }
    if (result.error) {
      setError(
        localizeError(
          language,
          result.errorResponse,
          result.error ?? loadError,
        ),
      );
      return { state: null, succeeded: false };
    }
    const refreshedState = result.data?.state ?? null;
    setState(refreshedState);
    setError(null);
    return { state: refreshedState, succeeded: true };
  }, [loadError, language, setError, setState]);

  const refresh = useCallback(async () => {
    const result = await requestRefresh();
    return result.state;
  }, [requestRefresh]);

  useEffect(() => {
    if (!postHeight) {
      return;
    }
    const baseIntervalMs =
      postHeight === "tiny" || postHeight === "cta"
        ? tinyRefreshIntervalMs
        : regularRefreshIntervalMs;
    const maximumIntervalMs = 15 * 60_000;
    let consecutiveFailures = 0;
    let cancelled = false;
    let timeoutId: number | undefined;

    const scheduleNext = (delayMs: number): void => {
      timeoutId = window.setTimeout(() => {
        void requestRefresh()
          .then(({ succeeded }) => {
            if (cancelled) return;
            consecutiveFailures = succeeded ? 0 : consecutiveFailures + 1;
            const nextDelay = succeeded
              ? baseIntervalMs
              : Math.min(
                  maximumIntervalMs,
                  baseIntervalMs * 2 ** consecutiveFailures,
                );
            scheduleNext(nextDelay);
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            consecutiveFailures += 1;
            logDiagnostic(
              "error",
              "client_async_handler_failed",
              { workflow: "refresh", phase: "backoff" },
              error,
            );
            scheduleNext(
              Math.min(
                maximumIntervalMs,
                baseIntervalMs * 2 ** consecutiveFailures,
              ),
            );
          });
      }, delayMs);
    };

    scheduleNext(baseIntervalMs);
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [postHeight, requestRefresh]);

  return refresh;
}
