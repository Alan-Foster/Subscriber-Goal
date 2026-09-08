import { navigateTo, showToast } from "@devvit/web/client";
import { useEffect, useRef, useState } from "react";
import { getSubGoalPostMessages } from "../../shared/subGoalPostI18n";
import type { NavigationTarget } from "../../shared/types/api";
import { useSubGoal } from "../hooks/useSubGoal";
import { ConfettiBurst } from "./components/ConfettiBurst";
import { AmbientConfetti } from "./components/AmbientConfetti";
import { SkeletonPage } from "./components/SkeletonPage";
import {
  TinySubscriptionConfirmation,
  tinySubscriptionConfirmationPhaseDurationMs,
} from "./components/TinySubscriptionConfirmation";
import { TinyViewTransition } from "./components/TinyViewTransition";
import { TinyPromoLink } from "./components/TinyPromoLink";
import { TinyActionLayout } from "./components/TinyActionLayout";
import { AfterSubscribeButton } from "./components/AfterSubscribeButton";
import { confettiPresets } from "./confettiPresets";
import { prohibitedContentMessage } from "../../shared/contentPolicy";
import { CompletedPage } from "./pages/CompletedPage";
import { SubGoalPage } from "./pages/SubGoalPage";
import { ThanksPage } from "./pages/ThanksPage";
import { useCelebration } from "./hooks/useCelebration";
import { isCelebrationInteractiveTarget } from "./hooks/useCelebration";
import {
  getGoalJourneyContext,
  goalJourneyAnalytics,
} from "../analytics/goalJourneyAnalytics";
import { logDiagnostic } from "../../shared/diagnostics";

type PageName = "subGoal" | "thanks" | "completed" | "tinyConfirmation";

export const App = () => {
  const {
    state,
    loading,
    submitting,
    subscribe,
    setError,
    notice,
    showNotice,
    prohibited,
  } = useSubGoal();
  const [page, setPage] = useState<PageName>("subGoal");
  const {
    celebrationBursts,
    interactionHandlers,
    prefersReducedMotion,
    triggerCelebration,
  } = useCelebration();
  const returnNoticeTimeoutRef = useRef<number | null>(null);
  const subscribeAttemptRef = useRef(false);
  const [shareUsername, setShareUsername] = useState(true);
  const messages = getSubGoalPostMessages(state?.language);
  const readyReportedRef = useRef(false);

  useEffect(() => {
    if (readyReportedRef.current || loading || prohibited || state === null) {
      return;
    }
    readyReportedRef.current = true;
    goalJourneyAnalytics.appReady();
  }, [loading, prohibited, state]);

  useEffect(() => {
    if (
      state &&
      state.postHeight !== "tiny" &&
      state.postHeight !== "cta" &&
      state.subreddit.isNsfw
    ) {
      setShareUsername(false);
    }
  }, [state]);

  useEffect(() => {
    if (
      state &&
      state.postHeight !== "tiny" &&
      state.postHeight !== "cta" &&
      state.completedTime
    ) {
      setPage("completed");
    }
  }, [state]);

  useEffect(() => {
    if (page !== "tinyConfirmation") {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setPage("subGoal");
    }, tinySubscriptionConfirmationPhaseDurationMs);
    return () => window.clearTimeout(timeoutId);
  }, [page]);

  useEffect(
    () => () => {
      if (returnNoticeTimeoutRef.current) {
        window.clearTimeout(returnNoticeTimeoutRef.current);
      }
    },
    [],
  );

  const promoSubreddit =
    state?.postHeight !== "tiny" && state?.postHeight !== "cta"
      ? state?.appSettings.promoSubreddit
      : undefined;
  const handleVisitPromo = () => {
    if (!promoSubreddit || !state) {
      return;
    }
    goalJourneyAnalytics.promoSubgoalActivated(getGoalJourneyContext(state));
    navigateTo(`https://www.reddit.com/r/${promoSubreddit}/`);
  };
  const handleAfterSubscribeNavigate = (target: string | NavigationTarget) => {
    navigateTo(target);
  };

  const performSubscribe = async () => {
    if (!state || state.postHeight === "cta" || subscribeAttemptRef.current) {
      return;
    }
    subscribeAttemptRef.current = true;
    const authenticated =
      state.postHeight === "tiny" ? state.authenticated : Boolean(state.user);
    const analyticsContext = getGoalJourneyContext(state);
    goalJourneyAnalytics.subscribeActivated(analyticsContext);
    if (!authenticated) {
      goalJourneyAnalytics.subscribeFailed(analyticsContext, "login_required");
      setError(messages.loginRequired);
      showToast(messages.loginRequired);
      subscribeAttemptRef.current = false;
      return;
    }
    const payload =
      state.postHeight === "tiny"
        ? undefined
        : { shareUsername: state.subreddit.isNsfw ? false : shareUsername };
    const {
      state: updatedState,
      error: subscribeError,
      journeyTelemetryHandled,
    } = await subscribe(payload);
    if (subscribeError) {
      goalJourneyAnalytics.subscribeFailed(analyticsContext, "api_error");
      showToast(
        state.language === "en" ? subscribeError : messages.subscribeErrorToast,
      );
      subscribeAttemptRef.current = false;
      return;
    }
    if (!updatedState) {
      goalJourneyAnalytics.subscribeFailed(analyticsContext, "missing_result");
      subscribeAttemptRef.current = false;
      return;
    }
    goalJourneyAnalytics.subscribeSucceeded(
      analyticsContext,
      journeyTelemetryHandled === true,
    );
    if (updatedState.postHeight === "cta") {
      subscribeAttemptRef.current = false;
      return;
    }
    if (updatedState.postHeight !== "tiny" && updatedState.completedTime) {
      setPage("completed");
    } else if (updatedState.postHeight === "tiny") {
      setPage("tinyConfirmation");
    } else {
      setPage("thanks");
    }
    triggerCelebration(confettiPresets.subscribe);
    if (updatedState.postHeight !== "tiny") {
      const noticeMessage = messages.subscriberNotice({
        username: updatedState.recentSubscriber,
      });
      showNotice(noticeMessage);
    }
    showToast({ text: messages.subscribeSuccessToast, appearance: "success" });
  };

  const handleSubscribe = () => {
    void performSubscribe().catch((error: unknown) => {
      subscribeAttemptRef.current = false;
      logDiagnostic(
        "error",
        "client_async_handler_failed",
        { workflow: "subscribe", phase: "app_handler" },
        error,
      );
      showToast(messages.subscribeErrorToast);
    });
  };

  const handleReturnToSubGoal = () => {
    if (!state || state.postHeight === "tiny" || state.postHeight === "cta") {
      return;
    }
    setPage("subGoal");
    if (returnNoticeTimeoutRef.current) {
      window.clearTimeout(returnNoticeTimeoutRef.current);
    }
    const effectiveShareUsername = state.subreddit.isNsfw
      ? false
      : shareUsername;
    const username = effectiveShareUsername
      ? (state.user?.username ?? null)
      : null;
    const message = messages.subscriberNotice({ username });
    returnNoticeTimeoutRef.current = window.setTimeout(() => {
      showNotice(message);
    }, 80);
  };

  let content = null;
  if (state) {
    if (state.postHeight === "cta") {
      content =
        state.afterSubscribeAction.type === "disabled" ? null : (
          <div className="relative flex h-full w-full items-center justify-center px-4 py-3 text-center">
            <TinyActionLayout state={state} showCtaActivity>
              <AfterSubscribeButton
                action={state.afterSubscribeAction}
                analyticsContext={getGoalJourneyContext(state)}
                language={state.language}
                onNavigate={handleAfterSubscribeNavigate}
                trackClicks={state.trackCtaClicks === true}
              />
            </TinyActionLayout>
          </div>
        );
    } else if (page === "tinyConfirmation" && state.postHeight === "tiny") {
      content = (
        <TinySubscriptionConfirmation
          language={state.language}
          subredditName={state.subreddit.name}
        />
      );
    } else if (page === "thanks") {
      content = (
        <ThanksPage
          state={state}
          onReturn={handleReturnToSubGoal}
          onVisitPromoSub={handleVisitPromo}
          onAfterSubscribeNavigate={handleAfterSubscribeNavigate}
        />
      );
    } else if (page === "completed" && state.postHeight !== "tiny") {
      content = (
        <CompletedPage state={state} onVisitPromoSub={handleVisitPromo} />
      );
    } else {
      content = (
        <SubGoalPage
          state={state}
          onSubscribe={handleSubscribe}
          onVisitPromoSub={handleVisitPromo}
          isSubmitting={submitting}
          shareUsername={shareUsername}
          onShareUsernameChange={setShareUsername}
          notice={notice}
          onAfterSubscribeNavigate={handleAfterSubscribeNavigate}
        />
      );
    }
  }

  if (loading) {
    return (
      <SkeletonPage
        postHeight={state?.postHeight}
        colorTheme={state?.colorTheme}
      />
    );
  }

  let frameColorTheme = state?.colorTheme;
  if (
    state?.postHeight === "cta" &&
    state.afterSubscribeAction.type !== "disabled"
  ) {
    frameColorTheme = state.afterSubscribeAction.colorTheme;
  } else if (
    state?.postHeight !== "cta" &&
    state?.subscribed === true &&
    state.afterSubscribeAction.type !== "disabled" &&
    page !== "completed" &&
    page !== "tinyConfirmation"
  ) {
    frameColorTheme = state.afterSubscribeAction.colorTheme;
  }

  const appHeightClass =
    state?.postHeight === "tiny" || state?.postHeight === "cta"
      ? "h-[100px]"
      : state?.postHeight === "short"
        ? "h-[234px]"
        : "h-[320px]";

  return (
    <div
      className={`sg-goal-frame relative flex ${appHeightClass} w-full cursor-pointer flex-col items-center justify-center overflow-hidden bg-[color:var(--sg-bg)] text-[color:var(--sg-text-primary)]`}
      data-app-interaction-shell="true"
      data-sg-theme={frameColorTheme}
      {...(state && !prohibited ? interactionHandlers : {})}
      onClickCapture={
        state && !prohibited
          ? (event) => {
              interactionHandlers.onClickCapture(event);
              goalJourneyAnalytics.committedInteraction();
              if (!isCelebrationInteractiveTarget(event.target)) {
                goalJourneyAnalytics.celebrationTriggered(
                  getGoalJourneyContext(state),
                );
              }
            }
          : undefined
      }
    >
      <div className="sg-goal-ui flex h-full w-full flex-col items-center justify-center">
        {(state?.postHeight === "tiny" || state?.postHeight === "cta") &&
        content ? (
          <TinyViewTransition transitionKey={page}>
            {content}
          </TinyViewTransition>
        ) : content ? (
          content
        ) : (
          <div className="text-center text-sm text-[color:var(--sg-text-muted)]">
            {prohibited ? prohibitedContentMessage : messages.loadError}
          </div>
        )}
        {state?.postHeight === "tiny" || state?.postHeight === "cta" ? (
          <TinyPromoLink
            promoSubreddit={state.promoSubreddit}
            language={state.language}
            analyticsContext={getGoalJourneyContext(state)}
          />
        ) : null}
      </div>
      {page === "completed" &&
      state &&
      state.postHeight !== "tiny" &&
      state.postHeight !== "cta" ? (
        <AmbientConfetti reducedMotion={prefersReducedMotion} />
      ) : null}
      {celebrationBursts.map((burst) => (
        <ConfettiBurst
          key={burst.id}
          pieceCount={burst.pieceCount}
          reducedMotion={prefersReducedMotion}
        />
      ))}
    </div>
  );
};
