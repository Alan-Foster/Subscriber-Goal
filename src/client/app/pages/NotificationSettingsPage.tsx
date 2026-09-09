import { useRef } from "react";
import type { SubGoalState } from "../../../shared/types/api";
import { getNotificationMessages } from "../../../shared/notificationI18n";
import { getSubGoalPostMessages } from "../../../shared/subGoalPostI18n";
import { NotificationBellIcon } from "../components/NotificationBellIcon";
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
  const returnActivatedRef = useRef(false);
  const statusText = loading
    ? "…"
    : !authenticated
      ? messages.loginRequired
      : enabled
        ? messages.enabled
        : messages.disabled;
  const preferenceStatusText = loading
    ? "…"
    : enabled
      ? messages.enabled
      : messages.disabled;
  const toggleLabel = enabled ? messages.disableButton : messages.enableButton;
  const compactToggleLabel = enabled
    ? messages.disableShort
    : messages.enableShort;

  const handleReturn = () => {
    if (returnActivatedRef.current) return;
    returnActivatedRef.current = true;
    onReturn();
    window.setTimeout(() => {
      returnActivatedRef.current = false;
    }, 250);
  };

  const toggleButton = (
    <button
      type="button"
      disabled={busy || !authenticated}
      aria-label={toggleLabel}
      className={`${
        enabled
          ? "bg-red-600 text-white hover:bg-red-700"
          : "bg-green-700 text-white hover:bg-green-800"
      } cursor-pointer whitespace-nowrap rounded-full font-semibold shadow-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--sg-border-strong)] disabled:cursor-not-allowed disabled:opacity-50 ${compact ? "min-w-20 px-3 py-1.5 text-xs" : "px-5 py-2.5 text-sm"}`}
      onClick={() => onToggle(!enabled)}
    >
      {submitting ? "…" : compact ? compactToggleLabel : toggleLabel}
    </button>
  );

  const backButton = (
    <button
      type="button"
      aria-label={messages.backAriaLabel}
      className="absolute left-3 top-3 z-20 inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-[color:var(--sg-text-secondary)] transition hover:text-[color:var(--sg-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--sg-border-strong)] sm:left-4 sm:top-4"
      onClick={handleReturn}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 20 20"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path
          d="M11.75 4.25 6 10l5.75 5.75M6.5 10h8"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );

  if (compact) {
    const compactNotice =
      error ?? (!authenticated && !loading ? statusText : null);
    return (
      <div
        className="relative flex h-full w-full items-center justify-center px-12 py-3 text-center"
        data-notification-layout="compact"
      >
        {backButton}
        <div className="flex w-full min-w-0 items-center justify-center gap-2">
          <div
            className={`flex min-w-0 flex-1 items-center justify-end gap-1.5 text-xs font-semibold ${error ? "text-red-500" : enabled ? "text-green-500" : "text-[color:var(--sg-text-secondary)]"}`}
            aria-label={`${messages.label}: ${preferenceStatusText}`}
          >
            <span className="shrink-0">
              <NotificationBellIcon enabled={enabled} />
            </span>
            <span className="min-w-0 truncate">{messages.label}:</span>{" "}
            <span className="shrink-0 whitespace-nowrap">
              {preferenceStatusText}
            </span>
          </div>
          {toggleButton}
        </div>
        {compactNotice ? (
          <div
            className={`absolute bottom-1 left-12 right-12 truncate text-[9px] ${error ? "text-red-500" : "text-[color:var(--sg-text-muted)]"}`}
            aria-live="polite"
            title={compactNotice}
          >
            {compactNotice}
          </div>
        ) : null}
      </div>
    );
  }

  const returnButton = (
    <button
      type="button"
      className="cursor-pointer whitespace-nowrap rounded-full border border-[color:var(--sg-border)] bg-[color:var(--sg-surface)] px-5 py-2.5 text-sm font-semibold text-[color:var(--sg-text-secondary)] shadow-sm transition hover:bg-[color:var(--sg-surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--sg-border-strong)]"
      onClick={handleReturn}
    >
      {short ? (
        messages.returnShort
      ) : (
        <>
          <span className="sm:hidden">{messages.returnShort}</span>
          <span className="hidden sm:inline">
            {commonMessages.thanksReturnButton}
          </span>
        </>
      )}
    </button>
  );

  if (short) {
    return (
      <div
        className="relative flex h-full w-full flex-col items-center justify-center gap-4 px-4 pb-5 pt-10 text-center sm:flex-row sm:gap-8 sm:px-16 sm:py-6"
        data-notification-layout="short"
      >
        {backButton}
        <TopButtons
          onVisitPromoSubPressed={onVisitPromoSub}
          promoSubreddit={state.appSettings.promoSubreddit}
          language={state.language}
        />
        <div className="min-w-0 text-base font-bold text-[color:var(--sg-text-secondary)] sm:flex-1 sm:text-xl">
          <span className="sm:whitespace-nowrap">
            r/{subredditName}:{" "}
            <span className={enabled ? "text-green-500" : ""}>
              {statusText}
            </span>
          </span>
          {error ? (
            <div className="mt-1 text-xs font-normal text-red-500">{error}</div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center justify-center gap-2 sm:gap-3">
          {toggleButton}
          {returnButton}
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full w-full flex-col items-center justify-center gap-3 px-4 pb-6 pt-10 text-center sm:gap-4 sm:px-16"
      data-notification-layout="regular"
    >
      {backButton}
      <TopButtons
        onVisitPromoSubPressed={onVisitPromoSub}
        promoSubreddit={state.appSettings.promoSubreddit}
        language={state.language}
      />
      <div className="text-xl font-bold sm:text-2xl">{messages.title}</div>
      <div className="max-w-xl text-sm text-[color:var(--sg-text-muted)] sm:text-base">
        {messages.description}
      </div>
      <div className="text-base font-semibold text-[color:var(--sg-text-secondary)] sm:text-lg">
        r/{subredditName}:{" "}
        <span className={enabled ? "text-green-500" : ""}>{statusText}</span>
      </div>
      {error ? (
        <div className="text-xs text-red-500" aria-live="polite">
          {error}
        </div>
      ) : null}
      <div className="flex items-center justify-center gap-2 sm:gap-3">
        {toggleButton}
        {returnButton}
      </div>
    </div>
  );
};
