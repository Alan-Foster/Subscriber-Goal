import { useEffect, useRef } from "react";
import type { SubGoalColorTheme } from "../../../shared/subGoalColorTheme";
import { NotificationBellIcon } from "./NotificationBellIcon";

type GoalNotificationButtonProps = {
  colorTheme: SubGoalColorTheme;
  label: string;
  submitting: boolean;
  error: string | null;
  onOptIn: () => Promise<boolean>;
};

export const GoalNotificationButton = ({
  colorTheme,
  label,
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
      className="relative isolate inline-flex min-w-0"
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
        className="relative z-10 inline-flex min-w-0 cursor-pointer items-center justify-center gap-2 rounded-full bg-[color:var(--sg-accent)] px-5 py-2 text-base font-semibold text-[color:var(--sg-button-text)] shadow-sm transition hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--sg-border-strong)] disabled:cursor-wait disabled:opacity-60 sm:px-6"
        onClick={() => {
          if (activatedRef.current) return;
          activatedRef.current = true;
          void onOptIn();
        }}
      >
        <NotificationBellIcon size={20} />
        <span className="truncate">{submitting ? "…" : label}</span>
      </button>
    </span>
  );
};
