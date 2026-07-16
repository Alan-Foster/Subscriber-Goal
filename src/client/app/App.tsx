import { navigateTo, showToast } from '@devvit/web/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSubGoalPostMessages } from '../../shared/subGoalPostI18n';
import { useSubGoal } from '../hooks/useSubGoal';
import { ConfettiBurst } from './components/ConfettiBurst';
import { SkeletonPage } from './components/SkeletonPage';
import { confettiPresets } from './confettiPresets';
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
  const [confettiPieces, setConfettiPieces] = useState<number>(
    confettiPresets.default.pieceCount
  );
  const confettiTimeoutRef = useRef<number | null>(null);
  const completedConfettiShownRef = useRef(false);
  const returnNoticeTimeoutRef = useRef<number | null>(null);
  const [shareUsername, setShareUsername] = useState(true);
  const messages = getSubGoalPostMessages(state?.language);

  useEffect(() => {
    if (state?.subreddit.isNsfw) {
      setShareUsername(false);
    }
  }, [state?.subreddit.isNsfw]);

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
      pieceCount = confettiPresets.default.pieceCount,
      durationMs = confettiPresets.default.durationMs,
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
        triggerConfetti(confettiPresets.completed);
        completedConfettiShownRef.current = true;
      }
    } else {
      completedConfettiShownRef.current = false;
    }
  }, [page, triggerConfetti]);

  const handleSubscribe = async () => {
    if (!state?.user) {
      setError(messages.loginRequired);
      showToast(messages.loginRequired);
      return;
    }
    const effectiveShareUsername = state.subreddit.isNsfw || state.postHeight === 'tiny'
      ? false
      : shareUsername;
    const { state: updatedState, error: subscribeError } = await subscribe({
      shareUsername: effectiveShareUsername,
    });
    if (subscribeError) {
      showToast(
        state.language === 'en' ? subscribeError : messages.subscribeErrorToast
      );
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
    triggerConfetti(confettiPresets.subscribe);
    const noticeMessage = messages.subscriberNotice({
      username: updatedState.recentSubscriber,
    });
    showNotice(noticeMessage);
    showToast({ text: messages.subscribeSuccessToast, appearance: 'success' });
  };

  const handleReturnToSubGoal = () => {
    setPage('subGoal');
    if (returnNoticeTimeoutRef.current) {
      window.clearTimeout(returnNoticeTimeoutRef.current);
    }
    const effectiveShareUsername = state?.subreddit.isNsfw || state?.postHeight === 'tiny'
      ? false
      : shareUsername;
    const username = effectiveShareUsername ? state?.user?.username ?? null : null;
    const message = messages.subscriberNotice({ username });
    returnNoticeTimeoutRef.current = window.setTimeout(() => {
      showNotice(message);
    }, 80);
  };

  const handleCelebrate = () => {
    triggerConfetti(confettiPresets.logoCelebrate);
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
    return <SkeletonPage postHeight={state?.postHeight} />;
  }

  const appHeightClass =
    state?.postHeight === 'tiny'
      ? 'h-[120px]'
      : state?.postHeight === 'short'
        ? 'h-[234px]'
        : 'h-[320px]';

  return (
    <div
      className={`relative flex ${appHeightClass} w-full flex-col items-center justify-center overflow-hidden bg-[color:var(--sg-bg)] text-[color:var(--sg-text-primary)]`}
    >
      {content ?? (
        <div className="text-center text-sm text-[color:var(--sg-text-muted)]">
          {messages.loadError}
        </div>
      )}
      {showConfetti ? (
        <ConfettiBurst key={confettiKey} pieceCount={confettiPieces} />
      ) : null}
    </div>
  );
};
