import { context } from '@devvit/web/client';
import type { SubGoalState } from '../../../shared/types/api';
import { formatNumberUnlessExact } from '../../utils/numberUtils';
import { SubredditIcon } from '../components/SubredditIcon';
import { TopButtons } from '../components/TopButtons';

type CompletedPageProps = {
  state: SubGoalState;
  onVisitPromoSub: () => void;
  onCelebrate: () => void;
};

export const CompletedPage = ({
  state,
  onVisitPromoSub,
  onCelebrate,
}: CompletedPageProps) => {
  const { locale, timezone } = context as { locale?: string; timezone?: string };
  const completedDate = state.completedTime ? new Date(state.completedTime) : null;
  const timeText = completedDate
    ? completedDate.toLocaleTimeString(locale ?? 'en', { timeZone: timezone ?? 'UTC' })
    : null;
  const dateText = completedDate
    ? completedDate.toLocaleDateString(locale ?? 'en', { timeZone: timezone ?? 'UTC' })
    : null;

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-4 px-4 py-6 text-center text-[color:var(--sg-text-primary)]">
      <TopButtons
        onVisitPromoSubPressed={onVisitPromoSub}
        promoSubreddit={state.appSettings.promoSubreddit}
      />
      <SubredditIcon iconUrl={state.subreddit.icon} size={100} onClick={onCelebrate} />
      <div className="text-2xl font-bold">
        r/{state.subreddit.name} reached{' '}
        {state.goal ? formatNumberUnlessExact(state.goal) : 'the goal'} subscribers!
      </div>
      <div className="text-lg font-semibold text-[color:var(--sg-text-secondary)]">
        {timeText && dateText
          ? `Goal reached at ${timeText} on ${dateText}`
          : 'Goal reached just now!'}
      </div>
    </div>
  );
};
