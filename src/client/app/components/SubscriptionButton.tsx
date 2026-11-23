import type { SubGoalColorTheme } from "../../../shared/subGoalColorTheme";
import { useCompactTextFit } from "./CompactTextFitContext";
import { JoinArrowIcon } from "./JoinArrowIcon";

import { useSubscriptionLabelFit } from "./useSubscriptionLabelFit";

export type SubscriptionButtonMode =
  "subscribe" | "submitting" | "subscribed" | "link";

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
  const compactTextFit = useCompactTextFit();
  const usesCompactTextFit = compactTextFit !== null;
  const { buttonRef, labelRef } = useSubscriptionLabelFit(
    label,
    mobileLabel,
    mode,
    usesCompactTextFit,
  );
  const disabled = mode === "submitting" || mode === "subscribed";
  const showAttention = mode === "subscribe" || mode === "link";

  return (
    <span
      className="sg-attention-host relative isolate inline-flex max-w-full"
      data-sg-theme={colorTheme}
      data-subscription-button-mode={mode}
    >
      {showAttention ? (
        <span
          aria-hidden="true"
          className="sg-subscribe-attention-shell absolute"
        >
          <span className="sg-subscribe-attention absolute" />
        </span>
      ) : null}
      <button
        ref={buttonRef}
        className="sg-hover-grow relative z-10 inline-flex min-h-[52px] min-w-[220px] max-w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-[color:var(--sg-accent)] px-6 py-2 text-center text-lg font-semibold whitespace-nowrap text-[color:var(--sg-button-text)] disabled:cursor-not-allowed disabled:opacity-60"
        data-subgoal-primary-cta={mode === "subscribe" ? "true" : undefined}
        data-sg-theme={colorTheme}
        disabled={disabled}
        onClick={disabled ? undefined : onClick}
      >
        <span
          ref={labelRef}
          className="min-w-0 whitespace-nowrap [overflow-wrap:normal]"
          data-subscription-button-label="true"
          style={
            compactTextFit
              ? {
                  fontSize: `${compactTextFit.fontSizePx}px`,
                  lineHeight: compactTextFit.wrapCta ? 1.25 : undefined,
                  overflowWrap: compactTextFit.wrapCta ? "anywhere" : "normal",
                  whiteSpace: compactTextFit.wrapCta ? "normal" : "nowrap",
                }
              : undefined
          }
        >
          {mobileLabel ? (
            <>
              <span className="sm:hidden">{mobileLabel}</span>
              <span className="hidden sm:inline">{label}</span>
            </>
          ) : (
            label
          )}
        </span>
        {mode === "subscribe" ? (
          <span className="hidden shrink-0 sm:inline-flex">
            <JoinArrowIcon />
          </span>
        ) : null}
      </button>
    </span>
  );
};
