import type { SubGoalState } from "../../../shared/types/api";
import { formatSubscriberCount } from "../../../shared/numberFormat";
import { getSubGoalPostMessages } from "../../../shared/subGoalPostI18n";
import { SubredditIcon } from "../components/SubredditIcon";
import { TopButtons } from "../components/TopButtons";
import { AfterSubscribeButton } from "../components/AfterSubscribeButton";
import { SubscriptionButton } from "../components/SubscriptionButton";
import type { NavigationTarget } from "../../../shared/types/api";
import { TinyActionLayout } from "../components/TinyActionLayout";

type ThanksPageProps = {
  state: SubGoalState;
  onReturn: () => void;
  onVisitPromoSub: () => void;
  onCelebrate: () => void;
  onAfterSubscribeNavigate: (target: string | NavigationTarget) => void;
};

export const ThanksPage = ({
  state,
  onReturn,
  onVisitPromoSub,
  onCelebrate,
  onAfterSubscribeNavigate,
}: ThanksPageProps) => {
  const messages = getSubGoalPostMessages(state.language);
  const isShort = state.postHeight === "short";
  if (state.postHeight === "tiny") {
    if (state.afterSubscribeAction.type !== "disabled") {
      return (
        <div className="relative flex h-full w-full items-center justify-center px-4 py-3 text-center">
          <TinyActionLayout state={state}>
            <AfterSubscribeButton
              action={state.afterSubscribeAction}
              language={state.language}
              onNavigate={onAfterSubscribeNavigate}
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
      <div className="text-2xl font-bold">{messages.thanksTitle}</div>
      <div className="text-lg font-semibold text-[color:var(--sg-text-secondary)]">
        {messages.thanksBody({
          subscribersText: formatSubscriberCount(state.subreddit.subscribers),
        })}
      </div>
      <div className="flex items-center justify-center gap-3">
        {state.subscribed && state.afterSubscribeAction.type !== "disabled" ? (
          <AfterSubscribeButton
            action={state.afterSubscribeAction}
            language={state.language}
            onNavigate={onAfterSubscribeNavigate}
          />
        ) : null}
        <button
          className="cursor-pointer rounded-full border border-[color:var(--sg-border)] bg-[color:var(--sg-surface)] px-4 py-2 text-sm font-semibold text-[color:var(--sg-text-secondary)] shadow-sm transition hover:bg-[color:var(--sg-surface-muted)]"
          onClick={onReturn}
        >
          {messages.thanksReturnButton}
        </button>
      </div>
    </div>
  );
};
