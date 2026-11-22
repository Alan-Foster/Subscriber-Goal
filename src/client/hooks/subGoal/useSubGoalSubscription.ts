import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  SubGoalState,
  SubscribeRequest,
  SubscribeResponse,
} from "../../../shared/types/api";
import { localizeError } from "../../../shared/i18n/errors";
import { goalJourneyAnalytics } from "../../analytics/goalJourneyAnalytics";
import { statisticsRequestHeaders } from "../../analytics/statisticsAnalytics";
import { isSubscribeResponse } from "./stateValidation";
import {
  createSubscriptionAttemptId,
  reconcileSubscriptionStatus,
  requestSubscribeJson,
} from "./subscriptionRequests";

type SubscribeResult = {
  state: SubGoalState | null;
  error: string | null;
  journeyTelemetryHandled: boolean;
};

const subscriptionMutationTimeoutMs = 10000;

function sendSubscriptionRequest(
  payload: SubscribeRequest | undefined,
  attemptId: string,
  signal: AbortSignal,
) {
  return requestSubscribeJson<SubscribeResponse>(
    "/api/subscribe",
    {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        ...goalJourneyAnalytics.journeyHeaders(),
        ...statisticsRequestHeaders(),
      },
      body: JSON.stringify({
        ...(payload ?? {}),
        attemptId,
      } satisfies SubscribeRequest),
    },
    isSubscribeResponse,
    { timeoutMs: subscriptionMutationTimeoutMs },
  );
}

function localizeSubscribeRejection(
  language: SubGoalState["language"] | undefined,
  message: string,
  result: Awaited<ReturnType<typeof sendSubscriptionRequest>>,
): string {
  return localizeError(
    language,
    {
      message,
      ...(result.errorMessageKey
        ? {
            messageKey: result.errorMessageKey,
            messageParams: result.errorMessageParams ?? {},
          }
        : {}),
    },
    message,
  );
}

export function useSubGoalSubscription({
  language,
  uncertainToast,
  setState,
  setError,
}: {
  language: SubGoalState["language"] | undefined;
  uncertainToast: string;
  setState: Dispatch<SetStateAction<SubGoalState | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const subscriptionAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      subscriptionAbortRef.current?.abort();
    };
  }, []);

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
      const attemptId = payload?.attemptId ?? createSubscriptionAttemptId();
      const subscriptionController = new AbortController();
      subscriptionAbortRef.current = subscriptionController;
      try {
        const result = await sendSubscriptionRequest(
          payload,
          attemptId,
          subscriptionController.signal,
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
            const localizedError = localizeSubscribeRejection(
              language,
              result.error,
              result,
            );
            if (mountedRef.current) setError(localizedError);
            return {
              state: null,
              error: localizedError,
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

          const userSafeError = uncertainToast;
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
    [uncertainToast, language, submitting, setError, setState],
  );

  return { submitting, subscribe };
}
