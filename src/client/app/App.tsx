import { navigateTo, showToast } from "@devvit/web/client";
import { useEffect, useRef, useState } from "react";
import { getSubGoalPostMessages } from "../../shared/subGoalPostI18n";
import type { NavigationTarget } from "../../shared/types/api";
import { useSubGoal } from "../hooks/useSubGoal";
import { ConfettiBurst } from "./components/ConfettiBurst";
import { SkeletonPage } from "./components/SkeletonPage";
import {
  TinySubscriptionConfirmation,
  tinySubscriptionConfirmationPhaseDurationMs,
} from "./components/TinySubscriptionConfirmation";
import { TinyViewTransition } from "./components/TinyViewTransition";
import { TinyPromoLink } from "./components/TinyPromoLink";
import { confettiPresets } from "./confettiPresets";
import { prohibitedContentMessage } from "../../shared/contentPolicy";
import { CompletedPage } from "./pages/CompletedPage";
import { SubGoalPage } from "./pages/SubGoalPage";
import { ThanksPage } from "./pages/ThanksPage";
import { useCelebration } from "./hooks/useCelebration";

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
    celebrationKey,
    interactionHandlers,
    pieceCount,
    prefersReducedMotion,
    showCelebration,
    triggerCelebration,
  } = useCelebration();
  const completedConfettiShownRef = useRef(false);
  const returnNoticeTimeoutRef = useRef<number | null>(null);
  const [shareUsername, setShareUsername] = useState(true);
  const messages = getSubGoalPostMessages(state?.language);

  useEffect(() => {
    if (state && state.postHeight !== "tiny" && state.subreddit.isNsfw) {
      setShareUsername(false);
    }
  }, [state]);

  useEffect(() => {
    if (state && state.postHeight !== "tiny" && state.completedTime) {
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
    state?.postHeight !== "tiny"
      ? state?.appSettings.promoSubreddit
      : undefined;
  const handleVisitPromo = () => {
    if (!promoSubreddit) {
      return;
    }
    navigateTo(`https://www.reddit.com/r/${promoSubreddit}/`);
  };
  const handleAfterSubscribeNavigate = (target: string | NavigationTarget) => {
    navigateTo(target);
  };

  useEffect(() => {
    if (page === "completed") {
      if (!completedConfettiShownRef.current) {
        triggerCelebration(confettiPresets.completed);
        completedConfettiShownRef.current = true;
      }
    } else {
      completedConfettiShownRef.current = false;
    }
  }, [page, triggerCelebration]);

  const handleSubscribe = async () => {
    if (!state) {
      return;
    }
    const authenticated =
      state.postHeight === "tiny" ? state.authenticated : Boolean(state.user);
    if (!authenticated) {
      setError(messages.loginRequired);
      showToast(messages.loginRequired);
      return;
    }
    const payload =
      state.postHeight === "tiny"
        ? undefined
        : { shareUsername: state.subreddit.isNsfw ? false : shareUsername };
    const { state: updatedState, error: subscribeError } =
      await subscribe(payload);
    if (subscribeError) {
      showToast(
        state.language === "en" ? subscribeError : messages.subscribeErrorToast,
      );
      return;
    }
    if (!updatedState) {
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

  const handleReturnToSubGoal = () => {
    if (!state || state.postHeight === "tiny") {
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
    if (page === "tinyConfirmation" && state.postHeight === "tiny") {
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
    state?.subscribed === true &&
    state.afterSubscribeAction.type !== "disabled" &&
    page !== "completed" &&
    page !== "tinyConfirmation"
  ) {
    frameColorTheme = state.afterSubscribeAction.colorTheme;
  }

  const appHeightClass =
    state?.postHeight === "tiny"
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
    >
      {state?.postHeight === "tiny" && content ? (
        <TinyViewTransition transitionKey={page}>{content}</TinyViewTransition>
      ) : content ? (
        content
      ) : (
        <div className="text-center text-sm text-[color:var(--sg-text-muted)]">
          {prohibited ? prohibitedContentMessage : messages.loadError}
        </div>
      )}
      {state?.postHeight === "tiny" ? (
        <TinyPromoLink
          promoSubreddit={state.promoSubreddit}
          language={state.language}
        />
      ) : null}
      {showCelebration ? (
        <ConfettiBurst
          key={celebrationKey}
          pieceCount={pieceCount}
          reducedMotion={prefersReducedMotion}
        />
      ) : null}
    </div>
  );
};
