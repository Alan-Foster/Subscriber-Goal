import type { SubGoalState } from '../../../shared/types/api';
import { formatSubscriberCount } from '../../../shared/numberFormat';
import { getSubGoalPostMessages } from '../../../shared/subGoalPostI18n';
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
  const shouldShowSubscribeAttention = !isDisabled;
  const iconAction = state.subscribed ? onCelebrate : onSubscribe;
  const showNotice = Boolean(notice);
  const messages = getSubGoalPostMessages(state.language);
  const isShort = state.postHeight === 'short';
  const isTiny = state.postHeight === 'tiny';
  const welcomeText =
    state.headerText ?? messages.welcome({ subredditName: state.subreddit.name });

  if (isTiny) {
    return (
      <div
        className="relative flex h-full w-full flex-col items-center justify-center px-4 py-3 text-center text-[color:var(--sg-text-primary)]"
        data-sg-theme={state.colorTheme}
      >
        <TopButtons
          onVisitPromoSubPressed={onVisitPromoSub}
          promoSubreddit={state.appSettings.promoSubreddit}
          language={state.language}
        />
        {state.subscribed ? (
          <div className="text-base font-bold text-[color:var(--sg-text-primary)]">
            r/{state.subreddit.name} has{' '}
            {formatSubscriberCount(state.subreddit.subscribers)} subscribers
          </div>
        ) : (
          <button
            className={`relative cursor-pointer rounded-full bg-[color:var(--sg-accent)] px-6 py-2 text-base font-semibold text-[color:var(--sg-button-text)] transition disabled:cursor-not-allowed disabled:opacity-60 ${
              shouldShowSubscribeAttention ? 'sg-subscribe-attention' : ''
            }`}
            disabled={isDisabled}
            onClick={onSubscribe}
          >
            {messages.subscribeButton({ subredditName: state.subreddit.name })}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full w-full flex-col items-center justify-center gap-6 px-4 py-6 text-center text-[color:var(--sg-text-primary)]"
      data-sg-theme={state.colorTheme}
    >
      <TopButtons
        onVisitPromoSubPressed={onVisitPromoSub}
        promoSubreddit={state.appSettings.promoSubreddit}
        language={state.language}
      />
      {isShort ? null : (
        <div className="pt-6">
          <SubredditIcon iconUrl={state.subreddit.icon} onClick={iconAction} />
        </div>
      )}
      {isShort ? (
        <>
          <div className="h-4" />
          <div className="h-4" />
          <div className="h-4" />
        </>
      ) : null}
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
      {state.goal !== null ? (
        <ProgressBar
          current={state.subreddit.subscribers}
          end={state.goal}
          start={0}
          showText
          width="70%"
        />
      ) : (
        <ProgressBar
          current={state.subreddit.subscribers}
          start={0}
          showText
          width="70%"
        />
      )}
      <button
        className={`relative cursor-pointer rounded-full bg-[color:var(--sg-accent)] px-6 py-2 text-base font-semibold text-[color:var(--sg-button-text)] transition disabled:cursor-not-allowed disabled:opacity-60 ${
          shouldShowSubscribeAttention ? 'sg-subscribe-attention' : ''
        }`}
        disabled={isDisabled}
        onClick={onSubscribe}
      >
        {state.subscribed
          ? messages.subscribedButton({ subredditName: state.subreddit.name })
          : messages.subscribeButton({ subredditName: state.subreddit.name })}
      </button>
      {state.subscribed || state.subreddit.isNsfw ? (
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
          {messages.shareUsernameLabel}
        </label>
      )}
      <div className="h-5" />
    </div>
  );
};
