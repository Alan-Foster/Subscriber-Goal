import { useEffect, useRef } from "react";
import type { SubGoalColorTheme } from "../../../shared/subGoalColorTheme";
import { NotificationBellIcon } from "./NotificationBellIcon";

type GoalNotificationButtonProps = {
  colorTheme: SubGoalColorTheme;
  label: string;
  compact?: boolean;
  submitting: boolean;
  error: string | null;
  onOptIn: () => Promise<boolean>;
};

export const GoalNotificationButton = ({
  colorTheme,
  label,
  compact = false,
  submitting,
  error,
  onOptIn,
}: GoalNotificationButtonProps) => {
  const activatedRef = useRef(false);

  useEffect(() => {
    if (!submitting) {
      activatedRef.current = false;
    }
  }, [submitting]);

  return (
    <span
      className="relative isolate flex min-w-0 flex-1 sm:max-w-96 sm:flex-none"
      data-goal-notification-action="true"
      data-sg-theme={colorTheme}
    >
      {!submitting ? (
        <span aria-hidden="true" className="sg-subscribe-attention absolute" />
      ) : null}
      <button
        type="button"
        disabled={submitting}
        aria-busy={submitting}
        aria-invalid={error ? true : undefined}
        title={error ?? undefined}
        className={`relative z-10 inline-flex min-h-10 w-full min-w-0 cursor-pointer items-center justify-center gap-2 rounded-full bg-[color:var(--sg-accent)] font-semibold text-[color:var(--sg-button-text)] shadow-sm transition hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--sg-border-strong)] disabled:cursor-wait disabled:opacity-60 sm:w-auto sm:max-w-96 ${compact ? "px-4 py-2 text-sm leading-tight" : "px-5 py-2 text-base leading-tight sm:px-6"}`}
        onClick={() => {
          if (activatedRef.current) return;
          activatedRef.current = true;
          void onOptIn();
        }}
      >
        <NotificationBellIcon size={20} />
        <span className="min-w-0 whitespace-normal break-words text-center leading-tight">
          {submitting ? "…" : label}
        </span>
      </button>
    </span>
  );
};
