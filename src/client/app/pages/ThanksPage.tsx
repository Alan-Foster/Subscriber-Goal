import type { SubGoalState } from '../../../shared/types/api';
import { formatNumberUnlessExact } from '../../utils/numberUtils';
import { SubredditIcon } from '../components/SubredditIcon';
import { TopButtons } from '../components/TopButtons';

type ThanksPageProps = {
  state: SubGoalState;
  onReturn: () => void;
  onVisitPromoSub: () => void;
  onCelebrate: () => void;
};

export const ThanksPage = ({
  state,
  onReturn,
  onVisitPromoSub,
  onCelebrate,
}: ThanksPageProps) => {
  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-4 px-4 py-6 text-center text-[color:var(--sg-text-primary)]">
      <TopButtons
        onVisitPromoSubPressed={onVisitPromoSub}
        promoSubreddit={state.appSettings.promoSubreddit}
      />
      <SubredditIcon iconUrl={state.subreddit.icon} size={100} onClick={onCelebrate} />
      <div className="text-2xl font-bold">Thanks for Subscribing!</div>
      <div className="text-lg font-semibold text-[color:var(--sg-text-secondary)]">
        There are now {formatNumberUnlessExact(state.subreddit.subscribers)} subscribers
        in the community!
      </div>
      <button
        className="cursor-pointer rounded-full border border-[color:var(--sg-border)] bg-[color:var(--sg-surface)] px-4 py-2 text-sm font-semibold text-[color:var(--sg-text-secondary)] shadow-sm transition hover:bg-[color:var(--sg-surface-muted)]"
        onClick={onReturn}
      >
        Return to Previous Page
      </button>
    </div>
  );
};
