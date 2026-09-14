import { useRef } from "react";
import type { ReactNode } from "react";
import type { SubGoalState } from "../../../shared/types/api";
import { getNotificationMessages } from "../../../shared/notificationI18n";
import { getSubGoalPostMessages } from "../../../shared/subGoalPostI18n";
import { NotificationBellIcon } from "../components/NotificationBellIcon";
import { NotificationSwitch } from "../components/NotificationSwitch";
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

type StableLocalizedSlotProps = {
  current: string;
  alternatives: readonly [string, string];
};

const StableLocalizedSlot = ({
  current,
  alternatives,
}: StableLocalizedSlotProps) => (
  <span
    className="inline-grid shrink-0 text-center"
    data-notification-stable-slot="state"
  >
    {alternatives.map((alternative) => (
      <span
        key={alternative}
        aria-hidden="true"
        className="invisible col-start-1 row-start-1 whitespace-nowrap"
      >
        {alternative}
      </span>
    ))}
    <span className="col-start-1 row-start-1 whitespace-nowrap">{current}</span>
  </span>
);

type NotificationPreferenceRowProps = {
  label: string;
  enabledText: string;
  disabledText: string;
  enabled: boolean;
  loading: boolean;
  submitting: boolean;
  authenticated: boolean;
  error: string | null;
  stackOnNarrow?: boolean;
  returnButton?: ReactNode;
  onToggle: (enabled: boolean) => void;
};

const NotificationPreferenceRow = ({
  label,
  enabledText,
  disabledText,
  enabled,
  loading,
  submitting,
  authenticated,
  error,
  stackOnNarrow = false,
  returnButton,
  onToggle,
}: NotificationPreferenceRowProps) => {
  const busy = loading || submitting;
  const statusText = loading ? "…" : enabled ? enabledText : disabledText;

  return (
    <div
      className={`flex max-w-full items-center justify-center gap-2 sm:gap-3 ${stackOnNarrow ? "flex-col sm:flex-row" : "flex-row"}`}
      data-notification-preference-row="true"
    >
      <div
        className={`flex min-w-0 max-w-full items-center justify-center gap-1.5 text-base font-semibold ${error ? "text-red-500" : enabled ? "text-green-500" : "text-[color:var(--sg-text-secondary)]"}`}
        aria-label={`${label}: ${statusText}`}
        aria-live="polite"
        role="status"
      >
        <span className="shrink-0">
          <NotificationBellIcon enabled={enabled} />
        </span>
        <span className="min-w-0 truncate">{label}:</span>
        <StableLocalizedSlot
          current={statusText}
          alternatives={[enabledText, disabledText]}
        />
      </div>
      <div className="flex shrink-0 items-center justify-center gap-2 sm:gap-3">
        <NotificationSwitch
          checked={enabled}
          disabled={busy || !authenticated}
          label={`${label}: ${statusText}`}
          busy={busy}
          onCheckedChange={onToggle}
        />
        {returnButton}
      </div>
    </div>
  );
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

  const handleReturn = () => {
    if (returnActivatedRef.current) return;
    returnActivatedRef.current = true;
    onReturn();
    window.setTimeout(() => {
      returnActivatedRef.current = false;
    }, 250);
  };

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
        className="relative flex h-full w-full items-center justify-center px-9 py-3 text-center"
        data-notification-layout="compact"
      >
        {backButton}
        <NotificationPreferenceRow
          label={messages.label}
          enabledText={messages.enabled}
          disabledText={messages.disabled}
          enabled={enabled}
          loading={loading}
          submitting={submitting}
          authenticated={authenticated}
          error={error}
          onToggle={onToggle}
        />
        {compactNotice ? (
          <div
            className={`absolute bottom-1 left-9 right-9 truncate text-[9px] ${error ? "text-red-500" : "text-[color:var(--sg-text-muted)]"}`}
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
      className={`cursor-pointer whitespace-nowrap rounded-full border border-[color:var(--sg-border)] bg-[color:var(--sg-surface)] px-5 font-semibold text-[color:var(--sg-text-secondary)] shadow-sm transition hover:bg-[color:var(--sg-surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--sg-border-strong)] ${short ? "py-2 text-base" : "py-2.5 text-sm"}`}
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
    const shortNotice =
      error ?? (!authenticated && !loading ? messages.loginRequired : null);
    return (
      <div
        className="relative flex h-full w-full items-center justify-center px-4 pb-6 pt-10 text-center sm:px-16 sm:py-6"
        data-notification-layout="short"
      >
        {backButton}
        <TopButtons
          onVisitPromoSubPressed={onVisitPromoSub}
          promoSubreddit={state.appSettings.promoSubreddit}
          language={state.language}
        />
        <NotificationPreferenceRow
          label={messages.label}
          enabledText={messages.enabled}
          disabledText={messages.disabled}
          enabled={enabled}
          loading={loading}
          submitting={submitting}
          authenticated={authenticated}
          error={error}
          stackOnNarrow
          returnButton={returnButton}
          onToggle={onToggle}
        />
        {shortNotice ? (
          <div
            className={`absolute bottom-2 left-4 right-4 truncate text-xs ${error ? "text-red-500" : "text-[color:var(--sg-text-muted)]"}`}
            aria-live="polite"
            title={shortNotice}
          >
            {shortNotice}
          </div>
        ) : null}
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
      <div className="flex w-full max-w-xl items-center justify-between gap-4 rounded-2xl border border-[color:var(--sg-border)] bg-[color:var(--sg-surface)] px-4 py-3 shadow-sm sm:px-5">
        <div
          className="flex min-w-0 items-center gap-3 text-left"
          aria-live="polite"
          role="status"
        >
          <span
            className={
              enabled
                ? "text-green-500"
                : "text-[color:var(--sg-text-secondary)]"
            }
          >
            <NotificationBellIcon enabled={enabled} size={24} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-[color:var(--sg-text-primary)] sm:text-base">
              {messages.alertsLabel}
            </span>
            <span className="block truncate text-xs text-[color:var(--sg-text-muted)] sm:text-sm">
              r/{subredditName}: {statusText}
            </span>
          </span>
        </div>
        <NotificationSwitch
          checked={enabled}
          disabled={busy || !authenticated}
          label={`${messages.alertsLabel}: ${statusText}`}
          busy={busy}
          onCheckedChange={onToggle}
        />
      </div>
      {error ? (
        <div className="text-xs text-red-500" aria-live="polite">
          {error}
        </div>
      ) : null}
      {returnButton}
    </div>
  );
};
