import { useEffect, useRef } from "react";
import type { SubGoalLanguage } from "../../../shared/subGoalPostI18n";
import { getSubGoalPostMessages } from "../../../shared/subGoalPostI18n";
import { NotificationBellIcon } from "./NotificationBellIcon";
import { NOTIFICATION_SETTINGS_ENTRY_ENABLED } from "../notificationFeatureFlags";
import { translate } from "../../../shared/i18n/catalog";

type TopButtonsProps = {
  onVisitPromoSubPressed: () => void;
  onNotificationsPressed?: (() => void) | undefined;
  notificationLabel?: string;
  promoSubreddit: string;
  language: SubGoalLanguage;
  revealTextOnInteraction?: boolean;
  notificationsEntryEnabled?: boolean;
  onStatisticsPressed?: (() => void) | undefined;
};

let hasAnimatedOnce = false;

export const TopButtons = ({
  onVisitPromoSubPressed,
  onNotificationsPressed,
  notificationLabel = translate("en", "notifications.label"),
  promoSubreddit,
  language,
  revealTextOnInteraction = false,
  notificationsEntryEnabled = NOTIFICATION_SETTINGS_ENTRY_ENABLED,
  onStatisticsPressed,
}: TopButtonsProps) => {
  const shouldAnimate = !hasAnimatedOnce;
  const messages = getSubGoalPostMessages(language);
  const activatedRef = useRef(false);
  const notificationsActivatedRef = useRef(false);

  useEffect(() => {
    hasAnimatedOnce = true;
  }, []);

  return (
    <>
      {onStatisticsPressed ? (
        <div className="absolute bottom-4 left-4 z-20">
          <button
            type="button"
            aria-label="Statistics"
            className={`${shouldAnimate ? "sg-fade-in" : ""} inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-xs font-semibold leading-none whitespace-nowrap text-[color:var(--sg-text-secondary)] transition hover:text-[color:var(--sg-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--sg-border-strong)]`}
            onClick={onStatisticsPressed}
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
                d="M3 16.25V10.5h2.5v5.75H3Zm5.75 0V3.75h2.5v12.5h-2.5Zm5.75 0V7h2.5v9.25h-2.5Z"
                fill="currentColor"
              />
            </svg>
            <span className="hidden sm:inline">Statistics</span>
          </button>
        </div>
      ) : null}
      {notificationsEntryEnabled && onNotificationsPressed ? (
        <div className="absolute left-4 top-4 z-20">
          <button
            type="button"
            aria-label={notificationLabel}
            className={`${
              shouldAnimate ? "sg-fade-in" : ""
            } ${revealTextOnInteraction ? "group relative" : "gap-1.5"} inline-flex cursor-pointer items-center whitespace-nowrap border-0 bg-transparent p-0 text-xs font-semibold leading-none text-[color:var(--sg-text-secondary)] transition hover:text-[color:var(--sg-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--sg-border-strong)]`}
            onClick={() => {
              if (notificationsActivatedRef.current) return;
              notificationsActivatedRef.current = true;
              onNotificationsPressed();
              window.setTimeout(() => {
                notificationsActivatedRef.current = false;
              }, 250);
            }}
          >
            <NotificationBellIcon />
            <span
              className={
                revealTextOnInteraction
                  ? "pointer-events-none absolute left-full ml-1.5 opacity-0 transition-opacity duration-[250ms] group-hover:pointer-events-auto group-hover:opacity-100 group-focus-visible:pointer-events-auto group-focus-visible:opacity-100 motion-reduce:transition-none"
                  : undefined
              }
            >
              {notificationLabel}
            </span>
          </button>
        </div>
      ) : null}
      <div className="absolute right-4 top-4 z-20">
        <button
          type="button"
          aria-label={messages.promoAriaLabel({ promoSubreddit })}
          className={`${
            shouldAnimate ? "sg-fade-in" : ""
          } ${revealTextOnInteraction ? "group relative" : "gap-1.5"} sg-hover-grow inline-flex cursor-pointer items-center whitespace-nowrap border-0 bg-transparent p-0 text-xs font-semibold leading-none text-[color:var(--sg-text-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--sg-border-strong)]`}
          onClick={() => {
            if (activatedRef.current) return;
            activatedRef.current = true;
            onVisitPromoSubPressed();
          }}
        >
          <span
            className={
              revealTextOnInteraction
                ? "pointer-events-none absolute right-full mr-1.5 opacity-0 transition-opacity duration-[250ms] group-hover:pointer-events-auto group-hover:opacity-100 group-focus-visible:pointer-events-auto group-focus-visible:opacity-100 motion-reduce:transition-none"
                : undefined
            }
          >
            r/{promoSubreddit}
          </span>
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M10 1C5.029 1 1 5.029 1 10C1 14.971 5.029 19 10 19C14.971 19 19 14.971 19 10C19 5.029 14.971 1 10 1ZM10 17.2C8.34 17.2 6.814 16.63 5.595 15.683L12.071 9.206V13H13.872V7.028C13.872 6.531 13.469 6.128 12.972 6.128H7.032V7.929H10.803L4.322 14.411C3.372 13.191 2.801 11.663 2.801 10.001C2.801 6.031 6.031 2.801 10.001 2.801C13.971 2.801 17.201 6.031 17.201 10.001C17.201 13.971 13.971 17.201 10.001 17.201L10 17.2Z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>
    </>
  );
};
