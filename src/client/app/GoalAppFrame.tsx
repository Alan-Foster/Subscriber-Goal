import type { ReactNode } from "react";
import { prohibitedContentMessage } from "../../shared/contentPolicy";
import type { SubGoalState } from "../../shared/types/api";
import {
  getGoalJourneyContext,
  goalJourneyAnalytics,
} from "../analytics/goalJourneyAnalytics";
import { AmbientConfetti } from "./components/AmbientConfetti";
import { ConfettiBurst } from "./components/ConfettiBurst";
import { TinyPromoLink } from "./components/TinyPromoLink";
import { TinyViewTransition } from "./components/TinyViewTransition";
import {
  isCelebrationInteractiveTarget,
  type useCelebration,
} from "./hooks/useCelebration";
import { NOTIFICATION_SETTINGS_ENTRY_ENABLED } from "./notificationFeatureFlags";
import {
  getGoalFrameColor,
  getGoalFrameHeight,
  type PageName,
} from "./viewSelection";

export function GoalAppFrame({
  state,
  page,
  prohibited,
  loadError,
  celebration,
  content,
  onOpenNotifications,
}: {
  state: SubGoalState | null;
  page: PageName;
  prohibited: boolean;
  loadError: string;
  celebration: ReturnType<typeof useCelebration>;
  content: ReactNode;
  onOpenNotifications: () => void;
}) {
  const { interactionHandlers, celebrationBursts, prefersReducedMotion } =
    celebration;
  const frameColorTheme = getGoalFrameColor(
    page,
    state,
    NOTIFICATION_SETTINGS_ENTRY_ENABLED,
  );
  const appHeightClass = getGoalFrameHeight(state?.postHeight);
  const interactiveState = !prohibited && page !== "statistics" ? state : null;
  const compactState =
    state?.postHeight === "tiny" || state?.postHeight === "cta" ? state : null;
  return (
    <div
      className={`sg-goal-frame relative flex ${appHeightClass} w-full ${page === "statistics" ? "cursor-default" : "cursor-pointer"} flex-col items-center justify-center overflow-hidden bg-[color:var(--sg-bg)] text-[color:var(--sg-text-primary)]`}
      data-app-interaction-shell="true"
      data-sg-theme={frameColorTheme}
      {...(interactiveState ? interactionHandlers : {})}
      onClickCapture={
        interactiveState
          ? (event) => {
              interactionHandlers.onClickCapture(event);
              goalJourneyAnalytics.committedInteraction();
              if (!isCelebrationInteractiveTarget(event.target)) {
                goalJourneyAnalytics.celebrationTriggered(
                  getGoalJourneyContext(interactiveState),
                );
              }
            }
          : undefined
      }
    >
      <div
        className={`sg-goal-ui flex h-full w-full flex-col items-center justify-center ${page === "statistics" ? "min-h-0" : ""}`}
      >
        {compactState && content ? (
          <TinyViewTransition transitionKey={page}>
            {content}
          </TinyViewTransition>
        ) : content ? (
          content
        ) : (
          <div className="text-center text-sm text-[color:var(--sg-text-muted)]">
            {prohibited ? prohibitedContentMessage : loadError}
          </div>
        )}
        {compactState ? (
          <TinyPromoLink
            promoSubreddit={compactState.promoSubreddit}
            language={compactState.language}
            analyticsContext={getGoalJourneyContext(compactState)}
            onNotificationsPressed={
              page === "notifications" ? undefined : onOpenNotifications
            }
          />
        ) : null}
      </div>
      {page === "completed" && state && !compactState ? (
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
}
