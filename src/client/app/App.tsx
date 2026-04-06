import { navigateTo, showToast } from '@devvit/web/client';
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
    const effectiveShareUsername = state.subreddit.isNsfw
      ? false
      : shareUsername;
    const { state: updatedState, error: subscribeError } = await subscribe({
      shareUsername: effectiveShareUsername,
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
    const effectiveShareUsername = state?.subreddit.isNsfw
      ? false
      : shareUsername;
    const username = effectiveShareUsername ? state?.user?.username : null;
    const message = username ? `u/${username} just subscribed!` : 'New member just subscribed!';
    returnNoticeTimeoutRef.current = window.setTimeout(() => {
      showNotice(message);
    }, 80);
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
