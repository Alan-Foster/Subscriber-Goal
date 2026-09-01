import type { ReactNode } from "react";
import { formatSubscriberCount } from "../../../shared/numberFormat";
import {
  formatLocalizedNewTodayCount,
  formatLocalizedSubscriberCount,
} from "../../../shared/subGoalPostI18n";
import type { SubscribeOnlyState } from "../../../shared/types/api";
import { useWideViewport } from "../../hooks/useWideViewport";

type TinyActionLayoutProps = {
  state: SubscribeOnlyState;
  children: ReactNode;
};

export const TinyActionLayout = ({
  state,
  children,
}: TinyActionLayoutProps) => {
  const isWideViewport = useWideViewport();

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
            formatSubscriberCount(state.subreddit.subscribers),
          )}
        </span>
      </div>
      <div>{children}</div>
      <div className="min-w-0 px-4 text-center text-base font-semibold text-[color:var(--sg-text-secondary)]">
        <span className="block truncate" data-new-subscribers-today="true">
          {formatLocalizedNewTodayCount(
            state.language,
            formatSubscriberCount(state.subreddit.newSubscribersToday),
          )}
        </span>
      </div>
    </div>
  );
};
