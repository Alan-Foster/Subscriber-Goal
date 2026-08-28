import { context } from "@devvit/web/client";
import type { SubscriberGoalState } from "../../../shared/types/api";
import { formatSubscriberCount } from "../../../shared/numberFormat";
import { getSubGoalPostMessages } from "../../../shared/subGoalPostI18n";
import { SubredditIcon } from "../components/SubredditIcon";
import { TopButtons } from "../components/TopButtons";

type CompletedPageProps = {
  state: SubscriberGoalState;
  onVisitPromoSub: () => void;
  onCelebrate: () => void;
};

const getGregorianLocale = (locale: string): string => `${locale}-u-ca-gregory`;

export const CompletedPage = ({
  state,
  onVisitPromoSub,
  onCelebrate,
}: CompletedPageProps) => {
  const { timezone } =
    (context as { locale?: string; timezone?: string } | undefined) ?? {};
  const messages = getSubGoalPostMessages(state.language);
  const isShort = state.postHeight === "short";
  const gregorianLocale = getGregorianLocale(messages.intlLocale);
  const completedDate = state.completedTime
    ? new Date(state.completedTime)
    : null;
  const timeText = completedDate
    ? new Intl.DateTimeFormat(gregorianLocale, {
        timeZone: timezone ?? "UTC",
        hour: "numeric",
        minute: "2-digit",
      }).format(completedDate)
    : null;
  const dateText = completedDate
    ? new Intl.DateTimeFormat(gregorianLocale, {
        timeZone: timezone ?? "UTC",
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(completedDate)
    : null;

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-4 px-4 py-6 text-center text-[color:var(--sg-text-primary)]">
      <TopButtons
        onVisitPromoSubPressed={onVisitPromoSub}
        promoSubreddit={state.appSettings.promoSubreddit}
        language={state.language}
      />
      {isShort ? null : (
        <SubredditIcon iconUrl={state.subreddit.icon} onClick={onCelebrate} />
      )}
      <div className="text-2xl font-bold">
        {messages.completedTitle({
          subredditName: state.subreddit.name,
          goalText: state.goal
            ? formatSubscriberCount(state.goal)
            : messages.completedGoalFallback,
        })}
      </div>
      <div className="text-lg font-semibold text-[color:var(--sg-text-secondary)]">
        {timeText && dateText
          ? messages.completedReachedAt({ timeText, dateText })
          : messages.completedJustNow}
      </div>
    </div>
  );
};
