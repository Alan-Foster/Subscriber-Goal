import type { SubGoalColorTheme } from "../../../shared/subGoalColorTheme";
import { JoinArrowIcon } from "./JoinArrowIcon";

export type SubscriptionButtonMode =
  | "subscribe"
  | "submitting"
  | "subscribed"
  | "link";

type SubscriptionButtonProps = {
  label: string;
  mobileLabel?: string | undefined;
  mode: SubscriptionButtonMode;
  onClick?: (() => void) | undefined;
  colorTheme?: SubGoalColorTheme | undefined;
};

export const SubscriptionButton = ({
  label,
  mobileLabel,
  mode,
  onClick,
  colorTheme,
}: SubscriptionButtonProps) => {
  const disabled = mode === "submitting" || mode === "subscribed";
  const showAttention = mode === "subscribe" || mode === "link";

  return (
    <span
      className="relative isolate inline-flex max-w-full"
      data-sg-theme={colorTheme}
      data-subscription-button-mode={mode}
    >
      {showAttention ? (
        <span aria-hidden="true" className="sg-subscribe-attention absolute" />
      ) : null}
      <button
        className="sg-hover-grow relative z-10 inline-flex min-h-[60px] min-w-[255px] max-w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-[color:var(--sg-accent)] px-6 py-2 text-center text-2xl font-semibold whitespace-normal text-[color:var(--sg-button-text)] [overflow-wrap:anywhere] disabled:cursor-not-allowed disabled:opacity-60"
        data-subgoal-primary-cta={mode === "subscribe" ? "true" : undefined}
        data-sg-theme={colorTheme}
        disabled={disabled}
        onClick={disabled ? undefined : onClick}
      >
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {mobileLabel ? (
            <>
              <span className="sm:hidden">{mobileLabel}</span>
              <span className="hidden sm:inline">{label}</span>
            </>
          ) : (
            label
          )}
        </span>
        {mode === "subscribe" ? <JoinArrowIcon /> : null}
      </button>
    </span>
  );
};
