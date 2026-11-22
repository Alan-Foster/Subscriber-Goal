import type { ReactNode } from "react";
import type { CtaOnlyState, SubscribeOnlyState } from "../../shared/types/api";
import {
  getGoalJourneyContext,
  goalJourneyAnalytics,
} from "../analytics/goalJourneyAnalytics";
import { ConfettiBurst } from "../app/components/ConfettiBurst";
import { TinyPromoLink } from "../app/components/TinyPromoLink";
import {
  isCelebrationInteractiveTarget,
  type useCelebration,
} from "../app/hooks/useCelebration";
import type { TinySubscribeViewPhase } from "../app/viewSelection";

export function SubscribeOnlyFrame({
  state,
  colorTheme,
  viewPhase,
  onOpenNotifications,
  celebration,
  content,
}: {
  state: CtaOnlyState | SubscribeOnlyState;
  colorTheme: SubscribeOnlyState["colorTheme"];
  viewPhase: TinySubscribeViewPhase;
  onOpenNotifications: () => void;
  celebration: ReturnType<typeof useCelebration>;
  content: ReactNode;
}) {
  const { celebrationBursts, interactionHandlers, prefersReducedMotion } =
    celebration;
  const analyticsContext = getGoalJourneyContext(state);
  return (
    <div
      className="sg-goal-frame relative h-[100px] w-full cursor-pointer overflow-hidden"
      data-app-interaction-shell="true"
      data-sg-theme={colorTheme}
      {...interactionHandlers}
      onClickCapture={(event) => {
        interactionHandlers.onClickCapture(event);
        goalJourneyAnalytics.committedInteraction();
        if (!isCelebrationInteractiveTarget(event.target)) {
          goalJourneyAnalytics.celebrationTriggered(analyticsContext);
        }
      }}
    >
      <div
        className={
          state.postHeight === "cta"
            ? "sg-goal-ui flex h-full w-full items-center justify-center text-center"
            : "sg-goal-ui h-full w-full"
        }
      >
        {content}
        <TinyPromoLink
          promoSubreddit={state.promoSubreddit}
          language={state.language}
          analyticsContext={analyticsContext}
          onNotificationsPressed={
            viewPhase === "notifications" ? undefined : onOpenNotifications
          }
        />
      </div>
      {celebrationBursts.map((burst) => (
        <ConfettiBurst
          key={burst.id}
          pieceCount={burst.pieceCount}
          reducedMotion={prefersReducedMotion}
        />
      ))}
    </div>
  );
}
