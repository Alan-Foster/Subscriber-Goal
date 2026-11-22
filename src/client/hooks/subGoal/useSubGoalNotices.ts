import { useCallback, useEffect, useRef, useState } from "react";
import type { getSubGoalPostMessages } from "../../../shared/subGoalPostI18n";
import type { SubGoalState } from "../../../shared/types/api";

export function useSubGoalNotices(
  state: SubGoalState | null,
  messages: ReturnType<typeof getSubGoalPostMessages>,
) {
  const [notice, setNotice] = useState<string | null>(null);

  const noticeTimeoutRef = useRef<number | null>(null);
  const initialNoticeDelayRef = useRef<number | null>(null);
  const initialWelcomeStartedRef = useRef(false);
  const initialNoticeWindowCompleteRef = useRef(false);
  const pendingInitialNoticeRef = useRef<string | null>(null);
  const seenNoticeEventsRef = useRef(new Set<string>());

  const postHeight = state?.postHeight;

  const recentSubscriber =
    postHeight === "tiny" || postHeight === "cta"
      ? null
      : state?.recentSubscriber;

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimeoutRef.current) {
      window.clearTimeout(noticeTimeoutRef.current);
    }
    noticeTimeoutRef.current = window.setTimeout(() => {
      setNotice(null);
    }, 2800);
  }, []);

  const announceSubscriber = useCallback(
    (username: string | null, subscriberCount: number) => {
      const eventKey = `${subscriberCount}:${username ?? "anonymous"}`;
      if (seenNoticeEventsRef.current.has(eventKey)) {
        return;
      }
      seenNoticeEventsRef.current.add(eventKey);
      if (seenNoticeEventsRef.current.size > 100) {
        const oldestEvent = seenNoticeEventsRef.current.values().next().value;
        if (oldestEvent !== undefined) {
          seenNoticeEventsRef.current.delete(oldestEvent);
        }
      }
      const message = messages.subscriberNotice({ username });
      if (!initialNoticeWindowCompleteRef.current) {
        pendingInitialNoticeRef.current = message;
        return;
      }
      showNotice(message);
    },
    [messages, showNotice],
  );

  useEffect(
    () => () => {
      if (noticeTimeoutRef.current) {
        window.clearTimeout(noticeTimeoutRef.current);
      }
      if (initialNoticeDelayRef.current) {
        window.clearTimeout(initialNoticeDelayRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!postHeight || postHeight === "tiny" || postHeight === "cta") {
      return;
    }
    if (!initialWelcomeStartedRef.current) {
      initialWelcomeStartedRef.current = true;
      initialNoticeDelayRef.current = window.setTimeout(() => {
        initialNoticeWindowCompleteRef.current = true;
        initialNoticeDelayRef.current = null;
        const pendingNotice = pendingInitialNoticeRef.current;
        pendingInitialNoticeRef.current = null;
        if (pendingNotice) {
          showNotice(pendingNotice);
        }
      }, 5000);
    }
    if (recentSubscriber && state) {
      announceSubscriber(recentSubscriber, state.subreddit.subscribers);
    }
  }, [announceSubscriber, postHeight, recentSubscriber, showNotice, state]);

  return { notice, showNotice, announceSubscriber };
}
