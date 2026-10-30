import type { SubGoalColorTheme } from "../../../shared/subGoalColorTheme";

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
        className="relative z-10 max-w-full cursor-pointer rounded-full bg-[color:var(--sg-accent)] px-6 py-2 text-center text-base font-semibold whitespace-normal text-[color:var(--sg-button-text)] [overflow-wrap:anywhere] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        data-subgoal-primary-cta={mode === "subscribe" ? "true" : undefined}
        data-sg-theme={colorTheme}
        disabled={disabled}
        onClick={disabled ? undefined : onClick}
      >
        {mobileLabel ? (
          <>
            <span className="sm:hidden">{mobileLabel}</span>
            <span className="hidden sm:inline">{label}</span>
          </>
        ) : (
          label
        )}
      </button>
    </span>
  );
};
