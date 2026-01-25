import { canRunAsUser, navigateTo, showToast } from '@devvit/web/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSubGoal } from '../hooks/useSubGoal';
import { ConfettiBurst } from './components/ConfettiBurst';
import { SkeletonPage } from './components/SkeletonPage';
import { CompletedPage } from './pages/CompletedPage';
import { SubGoalPage } from './pages/SubGoalPage';
import { ThanksPage } from './pages/ThanksPage';

type PageName = 'subGoal' | 'thanks' | 'completed';

export const App = () => {
  const {
    state,
    loading,
    submitting,
    subscribe,
    simulateSubscribe,
    simulateIncrement,
    sendDebugRealtime,
    setError,
    notice,
    showNotice,
  } = useSubGoal();
  const [page, setPage] = useState<PageName>('subGoal');
  const [showConfetti, setShowConfetti] = useState(false);
  const [confettiKey, setConfettiKey] = useState(0);
  const [confettiPieces, setConfettiPieces] = useState(70);
  const confettiTimeoutRef = useRef<number | null>(null);
  const completedConfettiShownRef = useRef(false);
  const returnNoticeTimeoutRef = useRef<number | null>(null);
  const [shareUsername, setShareUsername] = useState(false);
  const showDebugControls = false;
  const debugToggleRef = useRef(false);

  useEffect(() => {
    if (state?.completedTime) {
      setPage('completed');
    }
  }, [state?.completedTime]);

  useEffect(
    () => () => {
      if (confettiTimeoutRef.current) {
        window.clearTimeout(confettiTimeoutRef.current);
      }
      if (returnNoticeTimeoutRef.current) {
        window.clearTimeout(returnNoticeTimeoutRef.current);
      }
    },
    []
  );

  const promoSubreddit = state?.appSettings.promoSubreddit;
  const handleVisitPromo = () => {
    if (!promoSubreddit) {
      return;
    }
    navigateTo(`https://www.reddit.com/r/${promoSubreddit}/`);
  };

  const triggerConfetti = useCallback(
    ({
      pieceCount = 70,
      durationMs = 2600,
      allowRestart = true,
    }: {
      pieceCount?: number;
      durationMs?: number;
      allowRestart?: boolean;
    } = {}) => {
      if (showConfetti && !allowRestart) {
        return;
      }
      setConfettiKey((prev) => prev + 1);
      setConfettiPieces(pieceCount);
      setShowConfetti(true);
      if (confettiTimeoutRef.current) {
        window.clearTimeout(confettiTimeoutRef.current);
      }
      confettiTimeoutRef.current = window.setTimeout(() => {
        setShowConfetti(false);
      }, durationMs);
    },
    [showConfetti]
  );

  useEffect(() => {
    if (page === 'completed') {
      if (!completedConfettiShownRef.current) {
        triggerConfetti({ durationMs: 2800, allowRestart: false });
        completedConfettiShownRef.current = true;
      }
    } else {
      completedConfettiShownRef.current = false;
    }
  }, [page, triggerConfetti]);

  const handleSubscribe = async () => {
    if (!state?.user) {
      setError('Please log in to subscribe.');
      showToast('Please log in to subscribe.');
      return;
    }
    const canSubscribe = await canRunAsUser();
    if (!canSubscribe) {
      setError('Permission required to subscribe.');
      showToast('Permission required to subscribe.');
      return;
    }
    const { state: updatedState, error: subscribeError } = await subscribe({
      shareUsername,
    });
    if (subscribeError) {
      showToast(subscribeError);
      return;
    }
    if (!updatedState) {
      return;
    }
    if (updatedState.completedTime) {
      setPage('completed');
    } else {
      setPage('thanks');
    }
    triggerConfetti({ durationMs: 2800 });
    const noticeMessage = updatedState.recentSubscriber
      ? `u/${updatedState.recentSubscriber} just subscribed!`
      : 'New member just subscribed!';
    showNotice(noticeMessage);
    showToast({ text: 'Thanks for subscribing!', appearance: 'success' });
  };

  const handleReturnToSubGoal = () => {
    setPage('subGoal');
    if (returnNoticeTimeoutRef.current) {
      window.clearTimeout(returnNoticeTimeoutRef.current);
    }
    const username = shareUsername ? state?.user?.username : null;
    const message = username ? `u/${username} just subscribed!` : 'New member just subscribed!';
    returnNoticeTimeoutRef.current = window.setTimeout(() => {
      showNotice(message);
    }, 80);
  };

  const handleDebugSubscribe = () => {
    const updatedState = simulateSubscribe(shareUsername);
    if (!updatedState) {
      return;
    }
    void sendDebugRealtime({
      nextCount: updatedState.subreddit.subscribers,
      includeUsername: shareUsername,
    });
    if (updatedState.completedTime) {
      setPage('completed');
    } else {
      setPage('thanks');
    }
    triggerConfetti({ durationMs: 2400 });
    const noticeMessage = shareUsername
      ? `u/${updatedState.user?.username ?? 'debug_user'} just subscribed!`
      : 'New member just subscribed!';
    showNotice(noticeMessage);
    showToast({ text: 'Debug subscribe simulated.', appearance: 'success' });
  };

  const handleDebugIncrement = () => {
    const updatedState = simulateIncrement();
    if (!updatedState) {
      return;
    }
    const includeUsername = debugToggleRef.current;
    debugToggleRef.current = !debugToggleRef.current;
    void sendDebugRealtime({
      nextCount: updatedState.subreddit.subscribers,
      includeUsername,
    });
    if (updatedState.completedTime) {
      setPage('completed');
    }
    showToast({ text: 'Debug +1 simulated.', appearance: 'success' });
  };

  const handleCelebrate = () => {
    triggerConfetti({ pieceCount: 24, durationMs: 1800, allowRestart: false });
  };

  let content = null;
  if (state) {
    if (page === 'thanks') {
      content = (
        <ThanksPage
          state={state}
          onReturn={handleReturnToSubGoal}
          onVisitPromoSub={handleVisitPromo}
          onCelebrate={handleCelebrate}
        />
      );
    } else if (page === 'completed') {
      content = (
        <CompletedPage
          state={state}
          onVisitPromoSub={handleVisitPromo}
          onCelebrate={handleCelebrate}
        />
      );
    } else {
      content = (
        <SubGoalPage
          state={state}
          onSubscribe={handleSubscribe}
          onVisitPromoSub={handleVisitPromo}
          onCelebrate={handleCelebrate}
          isSubmitting={submitting}
          shareUsername={shareUsername}
          onShareUsernameChange={setShareUsername}
          notice={notice}
        />
      );
    }
  }

  if (loading) {
    return <SkeletonPage />;
  }

  return (
    <div className="relative flex h-[320px] w-full flex-col items-center justify-center overflow-hidden bg-[color:var(--sg-bg)] text-[color:var(--sg-text-primary)]">
      {showDebugControls ? (
        <div className="absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-1">
          <button
            className="cursor-pointer rounded-full border border-[color:var(--sg-border)] bg-[color:var(--sg-surface)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--sg-text-secondary)] shadow-sm transition hover:bg-[color:var(--sg-surface-muted)] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={handleDebugIncrement}
            disabled={!state}
          >
            +1
          </button>
          <button
            className="cursor-pointer rounded-full border border-[color:var(--sg-border)] bg-[color:var(--sg-surface)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--sg-text-secondary)] shadow-sm transition hover:bg-[color:var(--sg-surface-muted)] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={handleDebugSubscribe}
            disabled={!state}
          >
            +Subscribe
          </button>
        </div>
      ) : null}
      {content ?? (
        <div className="text-center text-sm text-[color:var(--sg-text-muted)]">
          Unable to load Subscriber Goal data.
        </div>
      )}
      {showConfetti ? (
        <ConfettiBurst key={confettiKey} pieceCount={confettiPieces} />
      ) : null}
    </div>
  );
};
