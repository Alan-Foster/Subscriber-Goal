import type { SubGoalState } from '../../../shared/types/api';
import { ProgressBar } from '../components/ProgressBar';
import { SubredditIcon } from '../components/SubredditIcon';
import { TopButtons } from '../components/TopButtons';

type SubGoalPageProps = {
  state: SubGoalState;
  onSubscribe: () => void;
  onCelebrate: () => void;
  onVisitPromoSub: () => void;
  isSubmitting: boolean;
  shareUsername: boolean;
  onShareUsernameChange: (value: boolean) => void;
  notice: string | null;
};

export const SubGoalPage = ({
  state,
  onSubscribe,
  onCelebrate,
  onVisitPromoSub,
  isSubmitting,
  shareUsername,
  onShareUsernameChange,
  notice,
}: SubGoalPageProps) => {
  const isDisabled = state.subscribed || isSubmitting;
  const iconAction = state.subscribed ? onCelebrate : onSubscribe;
  const showNotice = Boolean(notice);
  const welcomeText = `Welcome to r/${state.subreddit.name}`;
  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-6 px-4 py-6 text-center text-[color:var(--sg-text-primary)]">
      <TopButtons
        onVisitPromoSubPressed={onVisitPromoSub}
        promoSubreddit={state.appSettings.promoSubreddit}
      />
      <div className="pt-6">
        <SubredditIcon
          iconUrl={state.subreddit.icon}
          size={100}
          onClick={iconAction}
        />
      </div>
      <div className="relative h-7 w-full">
        <div
          className={`absolute inset-0 flex items-center justify-center gap-1 text-xl font-bold leading-7 text-[color:var(--sg-text-primary)] transition-opacity duration-500 whitespace-nowrap ${
            showNotice ? 'opacity-0' : 'opacity-100'
          }`}
        >
          <span className="w-full truncate text-center">{welcomeText}</span>
        </div>
        <div
          className={`absolute inset-0 flex items-center justify-center gap-1 text-xl font-bold leading-7 text-[color:var(--sg-text-primary)] transition-opacity duration-500 whitespace-nowrap ${
            showNotice ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <span className="w-full truncate text-center">{notice ?? ''}</span>
        </div>
      </div>
      <ProgressBar
        current={state.subreddit.subscribers}
        end={state.goal ?? undefined}
        start={0}
        showText
        width="70%"
      />
      <button
        className="cursor-pointer rounded-full bg-[color:var(--sg-accent)] px-6 py-2 text-base font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-60"
        disabled={isDisabled}
        onClick={onSubscribe}
      >
        Subscribe{state.subscribed ? 'd' : ''} to r/{state.subreddit.name}
      </button>
      {state.subscribed ? (
        <div className="h-5" />
      ) : (
        <label
          className={`flex items-center gap-2 text-xs text-[color:var(--sg-text-muted)] ${
            isDisabled ? 'cursor-not-allowed' : 'cursor-pointer'
          }`}
        >
          <input
            type="checkbox"
            className="h-3 w-3 cursor-pointer accent-[color:var(--sg-accent)] disabled:cursor-not-allowed"
            checked={shareUsername}
            disabled={isDisabled}
            onChange={(event) => onShareUsernameChange(event.target.checked)}
          />
          Show my username when I subscribe
        </label>
      )}
      <div className="h-5" />
    </div>
  );
};
