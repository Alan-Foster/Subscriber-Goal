import type { ReactNode } from "react";
import {
  formatRoundedSubscriberCount,
  formatSubscriberCount,
} from "../../../shared/numberFormat";
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
import {
  CompactTextFitProvider,
  type CompactTextFit,
} from "./CompactTextFitContext";

import {
  defaultButtonMinWidthPx,
  statisticColumnReservationPx,
} from "./tinyActionFit";
import { useTinyActionFit } from "./useTinyActionFit";

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
  const subscriberLabel = formatLocalizedSubscriberCount(
    state.language,
    state.subreddit.subscribers,
    formatRoundedSubscriberCount(state.subreddit.subscribers),
  );
  const activityLabel = showCtaActivity
    ? formatLocalizedCtaActivity(
        state.language,
        ctaActivity,
        formatSubscriberCount(ctaActivity.count),
      )
    : formatLocalizedSubscriberGrowth(
        state.language,
        state.subreddit.growth,
        formatSubscriberCount(state.subreddit.growth.count),
      );

  const { layoutRef, leftStatisticRef, rightStatisticRef, fit } =
    useTinyActionFit(isWideViewport, children, subscriberLabel, activityLabel);

  if (!isWideViewport) {
    return children;
  }

  const compactTextFit: CompactTextFit | null = fit.active
    ? { fontSizePx: fit.fontSizePx, wrapCta: fit.wrapCta }
    : null;
  const constrainedColumns =
    fit.active && fit.constrainedCenterWidthPx !== null
      ? `minmax(${statisticColumnReservationPx}px, 1fr) minmax(${defaultButtonMinWidthPx}px, ${fit.constrainedCenterWidthPx}px) minmax(${statisticColumnReservationPx}px, 1fr)`
      : undefined;

  return (
    <div
      ref={layoutRef}
      className="grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center"
      data-compact-font-size={fit.active ? fit.fontSizePx : undefined}
      data-compact-cta-wrap={fit.active ? String(fit.wrapCta) : undefined}
      data-tiny-wide-layout="true"
      style={{
        fontSize: fit.active ? `${fit.fontSizePx}px` : undefined,
        gridTemplateColumns: constrainedColumns,
      }}
    >
      <div
        className={`${fit.active ? "" : "text-base"} min-w-0 px-4 text-center font-semibold text-[color:var(--sg-text-secondary)]`}
      >
        <span
          ref={leftStatisticRef}
          className="block truncate"
          data-subscriber-count="true"
        >
          {subscriberLabel}
        </span>
      </div>
      <div className="min-w-0 max-w-full">
        <CompactTextFitProvider value={compactTextFit}>
          {children}
        </CompactTextFitProvider>
      </div>
      <div
        className={`${fit.active ? "" : "text-base"} min-w-0 px-4 text-center font-semibold text-[color:var(--sg-text-secondary)]`}
      >
        <span
          ref={rightStatisticRef}
          className="block truncate"
          data-compact-activity="true"
        >
          {activityLabel}
        </span>
      </div>
    </div>
  );
};
