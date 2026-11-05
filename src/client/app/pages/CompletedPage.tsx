import { context } from "@devvit/web/client";
import { useState } from "react";
import type { SubscriberGoalState } from "../../../shared/types/api";
import { formatSubscriberCount } from "../../../shared/numberFormat";
import { getSubGoalPostMessages } from "../../../shared/subGoalPostI18n";
import { translate } from "../../../shared/i18n/catalog";
import { SubredditIcon } from "../components/SubredditIcon";
import { TopButtons } from "../components/TopButtons";
import { getNotificationMessages } from "../../../shared/notificationI18n";

type CompletedPageProps = {
  state: SubscriberGoalState;
  onVisitPromoSub: () => void;
  onNotifications?: () => void;
};

const getGregorianLocale = (locale: string): string => `${locale}-u-ca-gregory`;

const CameraModeIcon = ({ enabled }: { enabled: boolean }) => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 20 20"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path
      d="M6.4 5.5 7.55 3.75h4.9L13.6 5.5H16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h2.4Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
    <circle cx="10" cy="10.5" r="3" stroke="currentColor" strokeWidth="1.5" />
    {!enabled ? (
      <path
        data-camera-mode-slash="true"
        d="M2.75 2.75 17.25 17.25"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    ) : null}
  </svg>
);

export const CompletedPage = ({
  state,
  onVisitPromoSub,
  onNotifications,
}: CompletedPageProps) => {
  const [cameraModeEnabled, setCameraModeEnabled] = useState(false);
  const { timezone } =
    (context as { locale?: string; timezone?: string } | undefined) ?? {};
  const messages = getSubGoalPostMessages(state.language);
  const notificationMessages = getNotificationMessages(state.language);
  const cameraModeLabel = translate(
    state.language,
    cameraModeEnabled ? "cameraMode.disable" : "cameraMode.enable",
  );
  const isShort = state.postHeight === "short";
  const gregorianLocale = getGregorianLocale(messages.intlLocale);
  const completedDate = state.completedTime
    ? new Date(state.completedTime)
    : null;
  const timeText = completedDate
    ? new Intl.DateTimeFormat(gregorianLocale, {
        timeZone: timezone ?? "UTC",
        hour: "numeric",
        minute: "2-digit",
      }).format(completedDate)
    : null;
  const dateText = completedDate
    ? new Intl.DateTimeFormat(gregorianLocale, {
        timeZone: timezone ?? "UTC",
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(completedDate)
    : null;

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-4 px-4 py-6 text-center text-[color:var(--sg-text-primary)]">
      <TopButtons
        onNotificationsPressed={onNotifications}
        notificationLabel={notificationMessages.label}
        onVisitPromoSubPressed={onVisitPromoSub}
        promoSubreddit={state.appSettings.promoSubreddit}
        language={state.language}
      />
      {isShort ? null : <SubredditIcon iconUrl={state.subreddit.icon} />}
      <div
        data-camera-mode-block="headline"
        className={`text-2xl font-bold ${
          cameraModeEnabled
            ? "rounded-sm bg-[color:var(--sg-bg)] px-2 py-1"
            : ""
        }`}
      >
        {messages.completedTitle({
          subredditName: state.subreddit.name,
          ...(state.goal ? { goalCount: state.goal } : {}),
          goalText: state.goal
            ? formatSubscriberCount(state.goal)
            : messages.completedGoalFallback,
        })}
      </div>
      <div
        data-camera-mode-block="timestamp"
        className={`text-lg font-semibold text-[color:var(--sg-text-secondary)] ${
          cameraModeEnabled
            ? "rounded-sm bg-[color:var(--sg-bg)] px-2 py-1"
            : ""
        }`}
      >
        {timeText && dateText
          ? messages.completedReachedAt({ timeText, dateText })
          : messages.completedJustNow}
      </div>
      <button
        type="button"
        aria-label={cameraModeLabel}
        aria-pressed={cameraModeEnabled}
        title={cameraModeLabel}
        onClick={() => setCameraModeEnabled((enabled) => !enabled)}
        className="absolute right-4 bottom-4 z-20 inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-[color:var(--sg-text-muted)] transition-colors hover:text-[color:var(--sg-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--sg-border-strong)]"
      >
        <CameraModeIcon enabled={cameraModeEnabled} />
      </button>
    </div>
  );
};
