import type { SubGoalColorTheme } from "../../../shared/subGoalColorTheme";

export type SubscriptionButtonMode =
  | "subscribe"
  | "submitting"
  | "subscribed"
  | "link";

type SubscriptionButtonProps = {
  label: string;
  mode: SubscriptionButtonMode;
  onClick?: (() => void) | undefined;
  colorTheme?: SubGoalColorTheme | undefined;
};

export const SubscriptionButton = ({
  label,
  mode,
  onClick,
  colorTheme,
}: SubscriptionButtonProps) => {
  const disabled = mode === "submitting" || mode === "subscribed";
  const showAttention = mode === "subscribe" || mode === "link";

  return (
    <span
      className="relative isolate inline-flex"
      data-sg-theme={colorTheme}
      data-subscription-button-mode={mode}
    >
      {showAttention ? (
        <span aria-hidden="true" className="sg-subscribe-attention absolute" />
      ) : null}
      <button
        className="relative z-10 cursor-pointer rounded-full bg-[color:var(--sg-accent)] px-6 py-2 text-base font-semibold text-[color:var(--sg-button-text)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        data-sg-theme={colorTheme}
        disabled={disabled}
        onClick={disabled ? undefined : onClick}
      >
        {label}
      </button>
    </span>
  );
};
