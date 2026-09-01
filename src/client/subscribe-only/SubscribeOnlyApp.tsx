import { navigateTo, showToast } from "@devvit/web/client";
import { useEffect, useRef, useState } from "react";
import { getSubGoalPostMessages } from "../../shared/subGoalPostI18n";
import type { NavigationTarget } from "../../shared/types/api";
import { SkeletonPage } from "../app/components/SkeletonPage";
import {
  TinySubscriptionConfirmation,
  tinySubscriptionConfirmationPhaseDurationMs,
} from "../app/components/TinySubscriptionConfirmation";
import { TinyViewTransition } from "../app/components/TinyViewTransition";
import { TinyPromoLink } from "../app/components/TinyPromoLink";
import { SubGoalPage } from "../app/pages/SubGoalPage";
import { ThanksPage } from "../app/pages/ThanksPage";
import { useSubGoal } from "../hooks/useSubGoal";
import { prohibitedContentMessage } from "../../shared/contentPolicy";

type TinySubscribeViewPhase = "subscribe" | "confirmation" | "subscribed";

export const SubscribeOnlyApp = () => {
  const { state, loading, submitting, setError, subscribe, prohibited } =
    useSubGoal();
  const [viewPhase, setViewPhase] =
    useState<TinySubscribeViewPhase>("subscribe");
  const interactionStartedRef = useRef(false);
  const messages = getSubGoalPostMessages(state?.language);

  useEffect(() => {
    if (viewPhase !== "confirmation") {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setViewPhase("subscribed");
    }, tinySubscriptionConfirmationPhaseDurationMs);
    return () => window.clearTimeout(timeoutId);
  }, [viewPhase]);

  if (prohibited) {
    return (
      <div className="flex h-[120px] w-full items-center justify-center text-center text-sm">
        {prohibitedContentMessage}
      </div>
    );
  }

  if (loading || !state) {
    return <SkeletonPage postHeight="tiny" />;
  }

  if (state.postHeight !== "tiny") {
    return <SkeletonPage postHeight="tiny" />;
  }

  const handleSubscribe = async () => {
    if (!state.authenticated) {
      setError(messages.loginRequired);
      showToast(messages.loginRequired);
      return;
    }
    interactionStartedRef.current = true;
    const result = await subscribe();
    if (result.error) {
      interactionStartedRef.current = false;
      showToast(
        state.language === "en" ? result.error : messages.subscribeErrorToast,
      );
      return;
    }
    if (!result.state) {
      interactionStartedRef.current = false;
      return;
    }
    setViewPhase("confirmation");
    showToast({ text: messages.subscribeSuccessToast, appearance: "success" });
  };

  const effectiveViewPhase =
    viewPhase === "confirmation" || viewPhase === "subscribed"
      ? viewPhase
      : state.subscribed && !interactionStartedRef.current
        ? "subscribed"
        : "subscribe";

  return (
    <div
      className="relative h-[120px] w-full overflow-hidden"
      data-sg-theme={state.colorTheme}
    >
      <TinyViewTransition transitionKey={effectiveViewPhase}>
        {effectiveViewPhase === "confirmation" ? (
          <TinySubscriptionConfirmation
            language={state.language}
            subredditName={state.subreddit.name}
          />
        ) : effectiveViewPhase === "subscribed" ? (
          <ThanksPage
            state={state}
            onReturn={() => undefined}
            onVisitPromoSub={() => undefined}
            onCelebrate={() => undefined}
            onAfterSubscribeNavigate={(target: string | NavigationTarget) =>
              navigateTo(target)
            }
          />
        ) : (
          <SubGoalPage
            state={state}
            onCelebrate={() => undefined}
            onVisitPromoSub={() => undefined}
            shareUsername={false}
            onShareUsernameChange={() => undefined}
            onSubscribe={() => void handleSubscribe()}
            isSubmitting={submitting}
            notice={null}
            onAfterSubscribeNavigate={(target: string | NavigationTarget) =>
              navigateTo(target)
            }
          />
        )}
      </TinyViewTransition>
      <TinyPromoLink
        promoSubreddit={state.promoSubreddit}
        language={state.language}
      />
    </div>
  );
};
