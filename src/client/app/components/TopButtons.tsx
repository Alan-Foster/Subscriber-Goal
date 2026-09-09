import { useEffect, useRef } from "react";
import type { SubGoalLanguage } from "../../../shared/subGoalPostI18n";
import { getSubGoalPostMessages } from "../../../shared/subGoalPostI18n";

type TopButtonsProps = {
  onVisitPromoSubPressed: () => void;
  onNotificationsPressed?: (() => void) | undefined;
  notificationLabel?: string;
  promoSubreddit: string;
  language: SubGoalLanguage;
  revealTextOnInteraction?: boolean;
};

let hasAnimatedOnce = false;

export const TopButtons = ({
  onVisitPromoSubPressed,
  onNotificationsPressed,
  notificationLabel = "Notifications",
  promoSubreddit,
  language,
  revealTextOnInteraction = false,
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
      {onNotificationsPressed ? (
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
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="M10 1.75a5.25 5.25 0 0 0-5.25 5.25v2.23c0 .78-.25 1.54-.72 2.16L2.7 13.17a1 1 0 0 0 .8 1.6h13a1 1 0 0 0 .8-1.6l-1.33-1.78a3.6 3.6 0 0 1-.72-2.16V7A5.25 5.25 0 0 0 10 1.75Zm0 16.5a2.51 2.51 0 0 0 2.38-1.75H7.62A2.51 2.51 0 0 0 10 18.25Z"
                fill="currentColor"
              />
            </svg>
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
          } ${revealTextOnInteraction ? "group relative" : "gap-1.5"} inline-flex cursor-pointer items-center whitespace-nowrap border-0 bg-transparent p-0 text-xs font-semibold leading-none text-[color:var(--sg-text-secondary)] transition hover:text-[color:var(--sg-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--sg-border-strong)]`}
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
