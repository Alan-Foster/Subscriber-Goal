import type { SubscriberGoalState } from "../../../shared/types/api";
import { getNotificationMessages } from "../../../shared/notificationI18n";
import { getSubGoalPostMessages } from "../../../shared/subGoalPostI18n";
import { NotificationBellIcon } from "../components/NotificationBellIcon";
import { SubredditIcon } from "../components/SubredditIcon";
import { TopButtons } from "../components/TopButtons";

type NotificationConfirmationPageProps = {
  state: SubscriberGoalState;
  onVisitPromoSub: () => void;
};

export const NotificationConfirmationPage = ({
  state,
  onVisitPromoSub,
}: NotificationConfirmationPageProps) => {
  const messages = getSubGoalPostMessages(state.language);
  const notificationMessages = getNotificationMessages(state.language);
  const short = state.postHeight === "short";

  return (
    <div
      className={`relative flex h-full w-full flex-col items-center justify-center px-4 text-center text-[color:var(--sg-text-primary)] ${short ? "gap-2 py-4" : "gap-3 py-4"}`}
      data-notification-confirmation="true"
    >
      <TopButtons
        onVisitPromoSubPressed={onVisitPromoSub}
        promoSubreddit={state.appSettings.promoSubreddit}
        language={state.language}
      />
      {short ? null : <SubredditIcon iconUrl={state.subreddit.icon} />}
      <div className="text-2xl font-bold">{messages.thanksTitle}</div>
      <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-[color:var(--sg-accent)] bg-[color:var(--sg-surface)] text-[color:var(--sg-accent)] shadow-sm">
        <NotificationBellIcon enabled size={40} />
      </div>
      <div className="text-lg font-bold text-[color:var(--sg-text-primary)]">
        {notificationMessages.enabledHeading}
      </div>
      <div className="text-base font-semibold text-[color:var(--sg-text-secondary)]">
        {notificationMessages.successBody}
      </div>
    </div>
  );
};
