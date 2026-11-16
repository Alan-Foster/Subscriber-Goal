import type { CtaOnlyState, SubGoalState } from "../../../shared/types/api";
import { getSubGoalPostMessages } from "../../../shared/subGoalPostI18n";
import { ProgressBar } from "../components/ProgressBar";
import { SubscriptionButton } from "../components/SubscriptionButton";
import { SubredditIcon } from "../components/SubredditIcon";
import { TopButtons } from "../components/TopButtons";
import { AfterSubscribeButton } from "../components/AfterSubscribeButton";
import type { NavigationTarget } from "../../../shared/types/api";
import { TinyActionLayout } from "../components/TinyActionLayout";
import { getGoalJourneyContext } from "../../analytics/goalJourneyAnalytics";
import { getNotificationMessages } from "../../../shared/notificationI18n";
import { LoggedOutAuthButtons } from "../components/LoggedOutAuthButtons";
import { ResponsiveHeaderText } from "../components/ResponsiveHeaderText";

type SubGoalPageProps = {
  state: Exclude<SubGoalState, CtaOnlyState>;
  onSubscribe: () => void;
  onVisitPromoSub: () => void;
  isSubmitting: boolean;
  shareUsername: boolean;
  onShareUsernameChange: (value: boolean) => void;
  notice: string | null;
  onAfterSubscribeNavigate: (target: string | NavigationTarget) => void;
  onNotifications?: () => void;
  onStatistics?: () => void;
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
  onNotifications,
  onStatistics,
}: SubGoalPageProps) => {
  const messages = getSubGoalPostMessages(state.language);
  const notificationMessages = getNotificationMessages(state.language);
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
  const authenticated =
    state.postHeight === "tiny" ? state.authenticated : Boolean(state.user);
  const showAuthenticationButtons =
    !authenticated && !state.subscribed && !isSubmitting;
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
    const actionButton = showAuthenticationButtons ? (
      <LoggedOutAuthButtons
        signUpLabel={messages.signUpButton}
        logInLabel={messages.logInButton}
        onAuthenticate={handleButtonClick}
      />
    ) : afterSubscribeAction ? (
      <AfterSubscribeButton
        action={afterSubscribeAction}
        analyticsContext={getGoalJourneyContext(state)}
        language={state.language}
        onNavigate={onAfterSubscribeNavigate}
        trackClicks={state.trackCtaClicks === true}
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
        <TinyActionLayout
          state={state}
          showCtaActivity={Boolean(afterSubscribeAction)}
        >
          {actionButton}
        </TinyActionLayout>
      </div>
    );
  }

  // A moderator-provided header remains visible when configured. The default
  // is deliberately just the subreddit name: the logo now supplies the rest
  // of the visual identity without adding another row or "Welcome to".
  const headerText = state.headerText ?? `r/${state.subreddit.name}`;

  return (
    <div
      className={`relative flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center text-[color:var(--sg-text-primary)] ${
        isShort ? "py-1" : "py-6"
      }`}
      data-sg-theme={state.colorTheme}
    >
      <TopButtons
        onStatisticsPressed={onStatistics}
        onNotificationsPressed={onNotifications}
        notificationLabel={notificationMessages.label}
        onVisitPromoSubPressed={onVisitPromoSub}
        promoSubreddit={state.appSettings.promoSubreddit}
        language={state.language}
      />
      <div
        className="relative flex h-[88px] w-full items-end"
        data-subgoal-header="true"
      >
        <button
          type="button"
          data-subgoal-header-activate="true"
          aria-hidden={showNotice}
          disabled={showNotice || isDisabled}
          onClick={showNotice || isDisabled ? undefined : onSubscribe}
          className={`absolute inset-0 flex items-center justify-center transition-opacity duration-500 motion-reduce:transition-none ${
            showNotice ? "pointer-events-none opacity-0" : "opacity-100"
          } border-0 bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--sg-border-strong)] disabled:cursor-default`}
        >
          <span
            className="flex min-w-0 max-w-full items-center justify-center gap-3"
            data-subgoal-header-group="true"
          >
            <SubredditIcon
              iconUrl={state.subreddit.icon}
              size={48}
              {...(iconAction ? { onClick: iconAction } : {})}
            />
            <ResponsiveHeaderText text={headerText} />
          </span>
        </button>
        <div
          aria-live="polite"
          className={`absolute inset-0 flex items-center justify-center text-xl font-bold leading-7 text-[color:var(--sg-text-primary)] transition-opacity duration-500 motion-reduce:transition-none ${
            showNotice ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <span
            className={`absolute left-0 transition-transform duration-500 motion-reduce:transition-none ${
              showNotice ? "translate-x-0" : "translate-x-[calc(50vw-50%)]"
            }`}
            data-subgoal-notice-icon="true"
          >
            <SubredditIcon iconUrl={state.subreddit.icon} size={48} />
          </span>
          <span className="w-full truncate px-12 text-center">
            {notice ?? ""}
          </span>
        </div>
      </div>
      {state.goal !== null ? (
        <ProgressBar
          current={state.subreddit.subscribers}
          end={state.goal}
          start={0}
          showText
          width="70%"
          onActivate={onSubscribe}
          activationLabel={messages.progressSubscribeAriaLabel({
            subredditName: state.subreddit.name,
          })}
          disabled={isDisabled}
        />
      ) : (
        <ProgressBar
          current={state.subreddit.subscribers}
          start={0}
          showText
          width="70%"
          onActivate={onSubscribe}
          activationLabel={messages.progressSubscribeAriaLabel({
            subredditName: state.subreddit.name,
          })}
          disabled={isDisabled}
        />
      )}
      {showAuthenticationButtons ? (
        <LoggedOutAuthButtons
          signUpLabel={messages.signUpButton}
          logInLabel={messages.logInButton}
          onAuthenticate={handleButtonClick}
        />
      ) : afterSubscribeAction ? (
        <AfterSubscribeButton
          action={afterSubscribeAction}
          analyticsContext={getGoalJourneyContext(state)}
          language={state.language}
          onNavigate={onAfterSubscribeNavigate}
          trackClicks={state.trackCtaClicks === true}
        />
      ) : (
        <SubscriptionButton
          label={buttonLabel}
          mode={buttonMode}
          onClick={handleButtonClick}
        />
      )}
      {state.subscribed || state.subreddit.isNsfw ? (
        <div className={isShort ? "h-0" : "h-5"} />
      ) : (
        <label
          className={`flex items-center gap-2 text-xs text-[color:var(--sg-text-muted)] ${
            isDisabled ? "cursor-not-allowed" : "cursor-pointer"
          }`}
        >
          <input
            type="checkbox"
            className="sg-hover-grow h-3 w-3 cursor-pointer accent-[color:var(--sg-accent)] disabled:cursor-not-allowed"
            checked={shareUsername}
            disabled={isDisabled}
            onChange={(event) => onShareUsernameChange(event.target.checked)}
          />
          <span className="sg-hover-grow">{messages.shareUsernameLabel}</span>
        </label>
      )}
      <div className={isShort ? "h-0" : "h-5"} />
    </div>
  );
};
