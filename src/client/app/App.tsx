import { navigateTo, showToast } from "@devvit/web/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getSubGoalPostMessages } from "../../shared/subGoalPostI18n";
import type { NavigationTarget } from "../../shared/types/api";
import { useSubGoal } from "../hooks/useSubGoal";
import { ConfettiBurst } from "./components/ConfettiBurst";
import { SkeletonPage } from "./components/SkeletonPage";
import {
  TinySubscriptionConfirmation,
  tinySubscriptionConfirmationDurationMs,
} from "./components/TinySubscriptionConfirmation";
import { confettiPresets } from "./confettiPresets";
import { CompletedPage } from "./pages/CompletedPage";
import { SubGoalPage } from "./pages/SubGoalPage";
import { ThanksPage } from "./pages/ThanksPage";

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
  } = useSubGoal();
  const [page, setPage] = useState<PageName>("subGoal");
  const [showConfetti, setShowConfetti] = useState(false);
  const [confettiKey, setConfettiKey] = useState(0);
  const [confettiPieces, setConfettiPieces] = useState<number>(
    confettiPresets.default.pieceCount,
  );
  const confettiTimeoutRef = useRef<number | null>(null);
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
    }, tinySubscriptionConfirmationDurationMs);
    return () => window.clearTimeout(timeoutId);
  }, [page]);

  useEffect(
    () => () => {
      if (confettiTimeoutRef.current) {
        window.clearTimeout(confettiTimeoutRef.current);
      }
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

  const triggerConfetti = useCallback(
    ({
      pieceCount = confettiPresets.default.pieceCount,
      durationMs = confettiPresets.default.durationMs,
      allowRestart = true,
    }: {
      pieceCount?: number;
      durationMs?: number;
      allowRestart?: boolean;
    } = {}) => {
      if (showConfetti && !allowRestart) {
        return;
      }
      setConfettiKey((prev) => prev + 1);
      setConfettiPieces(pieceCount);
      setShowConfetti(true);
      if (confettiTimeoutRef.current) {
        window.clearTimeout(confettiTimeoutRef.current);
      }
      confettiTimeoutRef.current = window.setTimeout(() => {
        setShowConfetti(false);
      }, durationMs);
    },
    [showConfetti],
  );

  useEffect(() => {
    if (page === "completed") {
      if (!completedConfettiShownRef.current) {
        triggerConfetti(confettiPresets.completed);
        completedConfettiShownRef.current = true;
      }
    } else {
      completedConfettiShownRef.current = false;
    }
  }, [page, triggerConfetti]);

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
    triggerConfetti(confettiPresets.subscribe);
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

  const handleCelebrate = () => {
    triggerConfetti(confettiPresets.logoCelebrate);
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
          onCelebrate={handleCelebrate}
          onAfterSubscribeNavigate={handleAfterSubscribeNavigate}
        />
      );
    } else if (page === "completed" && state.postHeight !== "tiny") {
      content = (
        <CompletedPage
          state={state}
          onVisitPromoSub={handleVisitPromo}
          onCelebrate={handleCelebrate}
        />
      );
    } else {
      content = (
        <SubGoalPage
          state={state}
          onSubscribe={handleSubscribe}
          onVisitPromoSub={handleVisitPromo}
          onCelebrate={handleCelebrate}
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
    return <SkeletonPage postHeight={state?.postHeight} />;
  }

  const appHeightClass =
    state?.postHeight === "tiny"
      ? "h-[120px]"
      : state?.postHeight === "short"
        ? "h-[234px]"
        : "h-[320px]";

  return (
    <div
      className={`relative flex ${appHeightClass} w-full flex-col items-center justify-center overflow-hidden bg-[color:var(--sg-bg)] text-[color:var(--sg-text-primary)]`}
    >
      {content ?? (
        <div className="text-center text-sm text-[color:var(--sg-text-muted)]">
          {messages.loadError}
        </div>
      )}
      {showConfetti ? (
        <ConfettiBurst key={confettiKey} pieceCount={confettiPieces} />
      ) : null}
    </div>
  );
};
