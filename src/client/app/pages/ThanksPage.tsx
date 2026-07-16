import type { SubGoalState } from '../../../shared/types/api';
import { formatSubscriberCount } from '../../../shared/numberFormat';
import { getSubGoalPostMessages } from '../../../shared/subGoalPostI18n';
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
  const messages = getSubGoalPostMessages(state.language);
  const isShort = state.postHeight === 'short';
  const isTiny = state.postHeight === 'tiny';
  return (
    <div
      className={`relative flex h-full w-full flex-col items-center justify-center text-center text-[color:var(--sg-text-primary)] ${
        isTiny ? 'gap-2 px-4 py-3' : 'gap-4 px-4 py-6'
      }`}
    >
      <TopButtons
        onVisitPromoSubPressed={onVisitPromoSub}
        promoSubreddit={state.appSettings.promoSubreddit}
        language={state.language}
      />
      {isShort || isTiny ? null : (
        <SubredditIcon iconUrl={state.subreddit.icon} onClick={onCelebrate} />
      )}
      {isTiny ? null : (
        <div className="text-2xl font-bold">{messages.thanksTitle}</div>
      )}
      <div
        className={`${isTiny ? 'text-base leading-5' : 'text-lg'} font-semibold text-[color:var(--sg-text-secondary)]`}
      >
        {messages.thanksBody({
          subscribersText: formatSubscriberCount(state.subreddit.subscribers),
        })}
      </div>
      <button
        className={`cursor-pointer rounded-full border border-[color:var(--sg-border)] bg-[color:var(--sg-surface)] font-semibold text-[color:var(--sg-text-secondary)] shadow-sm transition hover:bg-[color:var(--sg-surface-muted)] ${
          isTiny ? 'px-3 py-1 text-xs' : 'px-4 py-2 text-sm'
        }`}
        onClick={onReturn}
      >
        {messages.thanksReturnButton}
      </button>
    </div>
  );
};
