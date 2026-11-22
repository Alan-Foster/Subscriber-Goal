import { navigateTo } from "@devvit/web/client";
import type { ReactNode } from "react";
import type {
  CtaOnlyState,
  NavigationTarget,
  SubscribeOnlyState,
} from "../../shared/types/api";
import { getGoalJourneyContext } from "../analytics/goalJourneyAnalytics";
import { AfterSubscribeButton } from "../app/components/AfterSubscribeButton";
import { TinyActionLayout } from "../app/components/TinyActionLayout";
import { TinySubscriptionConfirmation } from "../app/components/TinySubscriptionConfirmation";
import { TinyViewTransition } from "../app/components/TinyViewTransition";
import { NOTIFICATION_SETTINGS_ENTRY_ENABLED } from "../app/notificationFeatureFlags";
import { SubGoalPage } from "../app/pages/SubGoalPage";
import { ThanksPage } from "../app/pages/ThanksPage";
import type { TinySubscribeViewPhase } from "../app/viewSelection";

export function CompactCtaView({ state }: { state: CtaOnlyState }) {
  const analyticsContext = getGoalJourneyContext(state);
  return (
    <div className="flex h-full w-full items-center justify-center px-4 py-3">
      <TinyActionLayout state={state} showCtaActivity>
        {state.afterSubscribeAction.type === "disabled" ? null : (
          <AfterSubscribeButton
            action={state.afterSubscribeAction}
            analyticsContext={analyticsContext}
            language={state.language}
            onNavigate={(target: string | NavigationTarget) =>
              navigateTo(target)
            }
            trackClicks={state.trackCtaClicks === true}
          />
        )}
      </TinyActionLayout>
    </div>
  );
}

export function TinySubscribeView({
  state,
  effectiveViewPhase,
  notificationsPage,
  onSubscribe,
  onOpenNotifications,
  submitting,
}: {
  state: SubscribeOnlyState;
  effectiveViewPhase: TinySubscribeViewPhase;
  notificationsPage: ReactNode;
  onSubscribe: () => void;
  onOpenNotifications: () => void;
  submitting: boolean;
}) {
  return (
    <TinyViewTransition transitionKey={effectiveViewPhase}>
      {effectiveViewPhase === "notifications" ? (
        notificationsPage
      ) : effectiveViewPhase === "confirmation" ? (
        <TinySubscriptionConfirmation
          language={state.language}
          subredditName={state.subreddit.name}
        />
      ) : effectiveViewPhase === "subscribed" ? (
        <ThanksPage
          state={state}
          onReturn={() => undefined}
          onVisitPromoSub={() => undefined}
          onAfterSubscribeNavigate={(target: string | NavigationTarget) =>
            navigateTo(target)
          }
          notificationOptInEnabled={NOTIFICATION_SETTINGS_ENTRY_ENABLED}
        />
      ) : (
        <SubGoalPage
          state={state}
          onVisitPromoSub={() => undefined}
          shareUsername={false}
          onShareUsernameChange={() => undefined}
          onSubscribe={onSubscribe}
          isSubmitting={submitting}
          notice={null}
          onAfterSubscribeNavigate={(target: string | NavigationTarget) =>
            navigateTo(target)
          }
          onNotifications={onOpenNotifications}
        />
      )}
    </TinyViewTransition>
  );
}
