import type { CtaOnlyState, SubGoalState } from "../../../shared/types/api";
import { formatSubscriberCount } from "../../../shared/numberFormat";
import {
  getModeratorInstallPromotionMessages,
  getSubGoalPostMessages,
} from "../../../shared/subGoalPostI18n";
import { SubredditIcon } from "../components/SubredditIcon";
import { TopButtons } from "../components/TopButtons";
import { AfterSubscribeButton } from "../components/AfterSubscribeButton";
import { SubscriptionButton } from "../components/SubscriptionButton";
import type { NavigationTarget } from "../../../shared/types/api";
import { TinyActionLayout } from "../components/TinyActionLayout";
import { getGoalJourneyContext } from "../../analytics/goalJourneyAnalytics";
import { getNotificationMessages } from "../../../shared/notificationI18n";
import { GoalNotificationButton } from "../components/GoalNotificationButton";

type ThanksPageProps = {
  state: Exclude<SubGoalState, CtaOnlyState>;
  onReturn: () => void;
  onVisitPromoSub: () => void;
  onAfterSubscribeNavigate: (target: string | NavigationTarget) => void;
  notificationOptInEnabled: boolean;
  notificationSubmitting?: boolean;
  notificationError?: string | null;
  onNotificationOptIn?: () => Promise<boolean>;
  showModeratorInstallPromo?: boolean;
  onModeratorInstall?: () => void;
};

export const ThanksPage = ({
  state,
  onReturn,
  onVisitPromoSub,
  onAfterSubscribeNavigate,
  notificationOptInEnabled,
  notificationSubmitting = false,
  notificationError = null,
  onNotificationOptIn,
  showModeratorInstallPromo = false,
  onModeratorInstall,
}: ThanksPageProps) => {
  const messages = getSubGoalPostMessages(state.language);
  const moderatorPromoMessages = getModeratorInstallPromotionMessages(
    state.language,
  );
  const notificationMessages = getNotificationMessages(state.language);
  const isShort = state.postHeight === "short";
  if (state.postHeight === "tiny") {
    if (state.afterSubscribeAction.type !== "disabled") {
      return (
        <div className="relative flex h-full w-full items-center justify-center px-4 py-3 text-center">
          <TinyActionLayout state={state} showCtaActivity>
            <AfterSubscribeButton
              action={state.afterSubscribeAction}
              analyticsContext={getGoalJourneyContext(state)}
              language={state.language}
              onNavigate={onAfterSubscribeNavigate}
              trackClicks={state.trackCtaClicks === true}
            />
          </TinyActionLayout>
        </div>
      );
    }
    return (
      <div className="relative flex h-full w-full items-center justify-center px-4 py-3 text-center">
        <TinyActionLayout state={state}>
          <SubscriptionButton
            label={messages.subscribedButton({
              subredditName: state.subreddit.name,
            })}
            mode="subscribed"
          />
        </TinyActionLayout>
      </div>
    );
  }

  const moderatorUsername = state.user?.username.trim() ?? "";

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-4 px-4 py-6 text-center text-[color:var(--sg-text-primary)]">
      <TopButtons
        onVisitPromoSubPressed={onVisitPromoSub}
        promoSubreddit={state.appSettings.promoSubreddit}
        language={state.language}
      />
      {isShort || showModeratorInstallPromo ? null : (
        <SubredditIcon iconUrl={state.subreddit.icon} />
      )}
      <div className="text-2xl font-bold">{messages.thanksTitle}</div>
      <div className="text-lg font-semibold text-[color:var(--sg-text-secondary)]">
        {showModeratorInstallPromo ? (
          <>
            {moderatorUsername ? (
              <div className="mb-2">
                {moderatorPromoMessages.greeting}{" "}
                <span className="text-green-500">u/{moderatorUsername}</span>,
              </div>
            ) : null}
            <div>{moderatorPromoMessages.body}</div>
          </>
        ) : (
          messages.thanksBody({
            subscribersCount: state.subreddit.subscribers,
            subscribersText: formatSubscriberCount(state.subreddit.subscribers),
          })
        )}
      </div>
      <div
        className={`flex w-full max-w-xl justify-center gap-3 ${isShort ? "flex-row items-center" : "flex-col items-stretch min-[380px]:flex-row min-[380px]:items-center"}`}
        data-thanks-actions-layout={isShort ? "short" : "regular"}
      >
        {showModeratorInstallPromo && onModeratorInstall ? (
          <div data-moderator-install-promo-action="true">
            <SubscriptionButton
              colorTheme="green"
              label={moderatorPromoMessages.installButton}
              mobileLabel={moderatorPromoMessages.mobileInstallButton}
              mode="link"
              onClick={onModeratorInstall}
            />
          </div>
        ) : notificationOptInEnabled &&
          state.goal !== null &&
          onNotificationOptIn ? (
          <GoalNotificationButton
            colorTheme={state.colorTheme}
            label={notificationMessages.goalPrompt({
              goalText: formatSubscriberCount(state.goal),
            })}
            compact={isShort}
            submitting={notificationSubmitting}
            error={notificationError}
            onOptIn={onNotificationOptIn}
          />
        ) : !notificationOptInEnabled &&
          state.subscribed &&
          state.afterSubscribeAction.type !== "disabled" ? (
          <AfterSubscribeButton
            action={state.afterSubscribeAction}
            analyticsContext={getGoalJourneyContext(state)}
            language={state.language}
            onNavigate={onAfterSubscribeNavigate}
            trackClicks={state.trackCtaClicks === true}
          />
        ) : null}
        <button
          type="button"
          aria-label={messages.thanksReturnButton}
          className="min-h-10 w-auto shrink-0 self-center cursor-pointer rounded-full border border-[color:var(--sg-border)] bg-[color:var(--sg-surface)] px-4 py-2 text-sm font-semibold whitespace-nowrap text-[color:var(--sg-text-secondary)] shadow-sm transition hover:bg-[color:var(--sg-surface-muted)]"
          onClick={onReturn}
        >
          {notificationMessages.returnShort}
        </button>
      </div>
    </div>
  );
};
