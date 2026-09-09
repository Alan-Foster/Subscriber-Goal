import type { SubGoalState } from "../../../shared/types/api";
import { getNotificationMessages } from "../../../shared/notificationI18n";
import { getSubGoalPostMessages } from "../../../shared/subGoalPostI18n";
import { SubredditIcon } from "../components/SubredditIcon";
import { TopButtons } from "../components/TopButtons";

type NotificationSettingsPageProps = {
  state: SubGoalState;
  authenticated: boolean;
  enabled: boolean;
  loading: boolean;
  submitting: boolean;
  error: string | null;
  onToggle: (enabled: boolean) => void;
  onReturn: () => void;
  onVisitPromoSub: () => void;
};

export const NotificationSettingsPage = ({
  state,
  authenticated,
  enabled,
  loading,
  submitting,
  error,
  onToggle,
  onReturn,
  onVisitPromoSub,
}: NotificationSettingsPageProps) => {
  const messages = getNotificationMessages(state.language);
  const commonMessages = getSubGoalPostMessages(state.language);
  const compact = state.postHeight === "tiny" || state.postHeight === "cta";
  const short = state.postHeight === "short";
  const subredditName = state.subreddit.name;
  const busy = loading || submitting;
  const statusText = loading
    ? "…"
    : !authenticated
      ? messages.loginRequired
      : enabled
        ? messages.enabled
        : messages.disabled;
  const displayedStatusText = compact && error ? error : statusText;
  const toggleLabel = enabled ? messages.disableButton : messages.enableButton;

  const actions = (
    <div
      className={`flex shrink-0 items-center justify-center ${compact ? "gap-1" : "gap-2 sm:gap-3"}`}
    >
      <button
        type="button"
        disabled={busy || !authenticated}
        className={`${
          enabled
            ? "bg-red-500 text-white hover:bg-red-600"
            : "bg-[color:var(--sg-accent)] text-[color:var(--sg-button-text)]"
        } cursor-pointer rounded-full font-semibold shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${compact ? "px-2 py-1.5 text-xs" : "px-4 py-2 text-sm"}`}
        onClick={() => onToggle(!enabled)}
      >
        <span className={`block truncate ${compact ? "max-w-20" : ""}`}>
          {submitting ? "…" : toggleLabel}
        </span>
      </button>
      <button
        type="button"
        className={`cursor-pointer rounded-full border border-[color:var(--sg-border)] bg-[color:var(--sg-surface)] font-semibold text-[color:var(--sg-text-secondary)] shadow-sm transition hover:bg-[color:var(--sg-surface-muted)] ${compact ? "px-2 py-1.5 text-xs" : "px-4 py-2 text-sm"}`}
        onClick={onReturn}
      >
        <span className={`block truncate ${compact ? "max-w-16" : "max-w-32"}`}>
          {commonMessages.thanksReturnButton}
        </span>
      </button>
    </div>
  );

  if (compact) {
    return (
      <div
        className="relative flex h-full w-full items-center justify-center gap-3 px-12 py-3 text-center"
        data-notification-layout="compact"
      >
        <div className="max-w-28 min-w-0 truncate text-xs font-semibold text-[color:var(--sg-text-secondary)]">
          <span className="truncate">r/{subredditName}: </span>
          <span
            className={error ? "text-red-500" : enabled ? "text-green-500" : ""}
            title={displayedStatusText}
          >
            {displayedStatusText}
          </span>
        </div>
        {actions}
      </div>
    );
  }

  if (short) {
    return (
      <div
        className="relative flex h-full w-full items-center justify-center gap-6 px-16 py-6 text-center"
        data-notification-layout="short"
      >
        <TopButtons
          onVisitPromoSubPressed={onVisitPromoSub}
          promoSubreddit={state.appSettings.promoSubreddit}
          language={state.language}
        />
        <div className="min-w-0 text-xl font-bold text-[color:var(--sg-text-secondary)]">
          r/{subredditName}:{" "}
          <span className={enabled ? "text-green-500" : ""}>{statusText}</span>
          {error ? (
            <div className="mt-1 text-xs font-normal text-red-500">{error}</div>
          ) : null}
        </div>
        {actions}
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full w-full flex-col items-center justify-center gap-3 px-4 py-5 text-center"
      data-notification-layout="regular"
    >
      <TopButtons
        onVisitPromoSubPressed={onVisitPromoSub}
        promoSubreddit={state.appSettings.promoSubreddit}
        language={state.language}
      />
      <SubredditIcon iconUrl={state.subreddit.icon} />
      <div className="text-2xl font-bold">{messages.title}</div>
      <div className="text-sm text-[color:var(--sg-text-muted)]">
        {messages.description}
      </div>
      <div className="text-lg font-semibold text-[color:var(--sg-text-secondary)]">
        r/{subredditName}:{" "}
        <span className={enabled ? "text-green-500" : ""}>{statusText}</span>
      </div>
      {error ? <div className="text-xs text-red-500">{error}</div> : null}
      {actions}
    </div>
  );
};
