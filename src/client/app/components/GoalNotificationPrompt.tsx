import { useEffect, useRef } from "react";
import type { SubGoalColorTheme } from "../../../shared/subGoalColorTheme";
import { NotificationBellIcon } from "./NotificationBellIcon";

type GoalNotificationPromptProps = {
  colorTheme: SubGoalColorTheme;
  enabled: boolean;
  loading: boolean;
  submitting: boolean;
  error: string | null;
  prompt: string;
  confirmation: string;
  onOptIn: () => void;
};

export const GoalNotificationPrompt = ({
  colorTheme,
  enabled,
  loading,
  submitting,
  error,
  prompt,
  confirmation,
  onOptIn,
}: GoalNotificationPromptProps) => {
  const activatedRef = useRef(false);

  useEffect(() => {
    if (!loading && !submitting && !enabled) {
      activatedRef.current = false;
    }
  }, [enabled, loading, submitting]);

  if (enabled) {
    return (
      <div
        className="absolute left-4 top-4 z-20 flex max-w-[55%] items-center gap-1.5 rounded-full border border-[color:var(--sg-accent)] bg-[color:var(--sg-surface)] px-3 py-1.5 text-xs font-semibold text-[color:var(--sg-accent)] shadow-sm"
        data-goal-notification-state="confirmed"
        data-sg-theme={colorTheme}
        aria-live="polite"
        role="status"
      >
        <NotificationBellIcon enabled size={18} />
        <span className="truncate">{confirmation}</span>
      </div>
    );
  }

  const busy = loading || submitting;
  return (
    <span
      className="absolute left-4 top-4 z-20 max-w-[55%]"
      data-goal-notification-state={submitting ? "submitting" : "available"}
      data-sg-theme={colorTheme}
    >
      {!busy ? (
        <span aria-hidden="true" className="sg-subscribe-attention absolute" />
      ) : null}
      <button
        type="button"
        disabled={busy}
        aria-busy={busy}
        aria-invalid={error ? true : undefined}
        title={error ?? undefined}
        className="relative z-10 flex max-w-full cursor-pointer items-center gap-1.5 rounded-full bg-[color:var(--sg-accent)] px-3 py-1.5 text-xs font-semibold text-[color:var(--sg-button-text)] shadow-sm transition hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--sg-border-strong)] disabled:cursor-wait disabled:opacity-60"
        onClick={() => {
          if (activatedRef.current) return;
          activatedRef.current = true;
          onOptIn();
        }}
      >
        <NotificationBellIcon size={18} />
        <span className="truncate">{submitting ? "…" : prompt}</span>
      </button>
    </span>
  );
};
