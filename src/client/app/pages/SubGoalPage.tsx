import type { SubGoalState } from "../../../shared/types/api";
import { getSubGoalPostMessages } from "../../../shared/subGoalPostI18n";
import { ProgressBar } from "../components/ProgressBar";
import { SubscriptionButton } from "../components/SubscriptionButton";
import { SubredditIcon } from "../components/SubredditIcon";
import { TopButtons } from "../components/TopButtons";
import { AfterSubscribeButton } from "../components/AfterSubscribeButton";
import type { NavigationTarget } from "../../../shared/types/api";
import { TinyActionLayout } from "../components/TinyActionLayout";
import { getGoalJourneyContext } from "../../analytics/goalJourneyAnalytics";

type SubGoalPageProps = {
  state: SubGoalState;
  onSubscribe: () => void;
  onVisitPromoSub: () => void;
  isSubmitting: boolean;
  shareUsername: boolean;
  onShareUsernameChange: (value: boolean) => void;
  notice: string | null;
  onAfterSubscribeNavigate: (target: string | NavigationTarget) => void;
};

export const SubGoalPage = ({
  state,
  onSubscribe,
  onVisitPromoSub,
  isSubmitting,
  shareUsername,
  onShareUsernameChange,
  notice,
  onAfterSubscribeNavigate,
}: SubGoalPageProps) => {
  const messages = getSubGoalPostMessages(state.language);
  const afterSubscribeAction =
    state.subscribed && state.afterSubscribeAction.type !== "disabled"
      ? state.afterSubscribeAction
      : null;
  const buttonMode = isSubmitting
    ? "submitting"
    : afterSubscribeAction
      ? "link"
      : state.subscribed
        ? "subscribed"
        : "subscribe";
  const isDisabled = buttonMode === "submitting" || buttonMode === "subscribed";
  const buttonLabel = afterSubscribeAction
    ? afterSubscribeAction.buttonText
    : state.subscribed
      ? messages.subscribedButton({ subredditName: state.subreddit.name })
      : messages.subscribeButton({ subredditName: state.subreddit.name });
  const handleButtonClick = onSubscribe;
  const iconAction = state.subscribed ? undefined : onSubscribe;
  const showNotice = Boolean(notice);
  const isShort = state.postHeight === "short";
  if (state.postHeight === "tiny") {
    const actionButton = afterSubscribeAction ? (
      <AfterSubscribeButton
        action={afterSubscribeAction}
        analyticsContext={getGoalJourneyContext(state)}
        language={state.language}
        onNavigate={onAfterSubscribeNavigate}
      />
    ) : (
      <SubscriptionButton
        label={buttonLabel}
        mode={buttonMode}
        onClick={handleButtonClick}
      />
    );

    return (
      <div
        className="relative flex h-full w-full items-center justify-center px-4 py-3 text-center text-[color:var(--sg-text-primary)]"
        data-sg-theme={state.colorTheme}
      >
        <TinyActionLayout state={state}>{actionButton}</TinyActionLayout>
      </div>
    );
  }

  const welcomeText =
    state.headerText ??
    messages.welcome({ subredditName: state.subreddit.name });

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
          <SubredditIcon
            iconUrl={state.subreddit.icon}
            {...(iconAction ? { onClick: iconAction } : {})}
          />
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
            showNotice ? "opacity-0" : "opacity-100"
          }`}
        >
          <span className="w-full truncate text-center">{welcomeText}</span>
        </div>
        <div
          className={`absolute inset-0 flex items-center justify-center gap-1 text-xl font-bold leading-7 text-[color:var(--sg-text-primary)] transition-opacity duration-500 whitespace-nowrap ${
            showNotice ? "opacity-100" : "opacity-0"
          }`}
        >
          <span className="w-full truncate text-center">{notice ?? ""}</span>
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
      {afterSubscribeAction ? (
        <AfterSubscribeButton
          action={afterSubscribeAction}
          analyticsContext={getGoalJourneyContext(state)}
          language={state.language}
          onNavigate={onAfterSubscribeNavigate}
        />
      ) : (
        <SubscriptionButton
          label={buttonLabel}
          mode={buttonMode}
          onClick={handleButtonClick}
        />
      )}
      {state.subscribed || state.subreddit.isNsfw ? (
        <div className="h-5" />
      ) : (
        <label
          className={`flex items-center gap-2 text-xs text-[color:var(--sg-text-muted)] ${
            isDisabled ? "cursor-not-allowed" : "cursor-pointer"
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
