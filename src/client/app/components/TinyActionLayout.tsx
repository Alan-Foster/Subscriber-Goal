import type { ReactNode } from "react";
import { formatSubscriberCount } from "../../../shared/numberFormat";
import {
  formatLocalizedSubscriberGrowth,
  formatLocalizedSubscriberCount,
  formatLocalizedCtaActivity,
} from "../../../shared/subGoalPostI18n";
import type {
  CtaOnlyState,
  SubscribeOnlyState,
} from "../../../shared/types/api";
import { useWideViewport } from "../../hooks/useWideViewport";

type TinyActionLayoutProps = {
  state: SubscribeOnlyState | CtaOnlyState;
  children: ReactNode;
  showCtaActivity?: boolean;
};

export const TinyActionLayout = ({
  state,
  children,
  showCtaActivity = false,
}: TinyActionLayoutProps) => {
  const isWideViewport = useWideViewport();
  const ctaActivity = state.ctaActivity ?? {
    kind: "posts" as const,
    count: 1,
    period: "week" as const,
  };

  if (!isWideViewport) {
    return children;
  }

  return (
    <div
      className="grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center"
      data-tiny-wide-layout="true"
    >
      <div className="min-w-0 px-4 text-center text-base font-semibold text-[color:var(--sg-text-secondary)]">
        <span className="block truncate" data-subscriber-count="true">
          {formatLocalizedSubscriberCount(
            state.language,
            state.subreddit.subscribers,
            formatSubscriberCount(state.subreddit.subscribers),
          )}
        </span>
      </div>
      <div>{children}</div>
      <div className="min-w-0 px-4 text-center text-base font-semibold text-[color:var(--sg-text-secondary)]">
        <span className="block truncate" data-compact-activity="true">
          {showCtaActivity
            ? formatLocalizedCtaActivity(
                state.language,
                ctaActivity,
                formatSubscriberCount(ctaActivity.count),
              )
            : formatLocalizedSubscriberGrowth(
                state.language,
                state.subreddit.growth,
                formatSubscriberCount(state.subreddit.growth.count),
              )}
        </span>
      </div>
    </div>
  );
};
