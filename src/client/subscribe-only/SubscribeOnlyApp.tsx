import { showToast } from "@devvit/web/client";
import { useState } from "react";
import { getSubGoalPostMessages } from "../../shared/subGoalPostI18n";
import { SkeletonPage } from "../app/components/SkeletonPage";
import { SubGoalPage } from "../app/pages/SubGoalPage";
import { ThanksPage } from "../app/pages/ThanksPage";
import { useSubGoal } from "../hooks/useSubGoal";

export const SubscribeOnlyApp = () => {
  const { state, loading, submitting, setError, subscribe } = useSubGoal();
  const [succeeded, setSucceeded] = useState(false);
  const messages = getSubGoalPostMessages(state?.language);

  if (loading || !state) {
    return <SkeletonPage postHeight="tiny" />;
  }

  if (state.postHeight !== "tiny") {
    return <SkeletonPage postHeight="tiny" />;
  }

  const handleSubscribe = async () => {
    if (!state.authenticated) {
      setError(messages.loginRequired);
      showToast(messages.loginRequired);
      return;
    }
    const result = await subscribe();
    if (result.error) {
      showToast(
        state.language === "en" ? result.error : messages.subscribeErrorToast,
      );
      return;
    }
    setSucceeded(true);
    showToast({ text: messages.subscribeSuccessToast, appearance: "success" });
  };

  return (
    <div
      className="h-[120px] w-full overflow-hidden"
      data-sg-theme={state.colorTheme}
    >
      {succeeded || state.subscribed ? (
        <ThanksPage
          state={state}
          onReturn={() => undefined}
          onVisitPromoSub={() => undefined}
          onCelebrate={() => undefined}
        />
      ) : (
        <SubGoalPage
          state={state}
          onCelebrate={() => undefined}
          onVisitPromoSub={() => undefined}
          shareUsername={false}
          onShareUsernameChange={() => undefined}
          onSubscribe={() => void handleSubscribe()}
          isSubmitting={submitting}
          notice={null}
        />
      )}
    </div>
  );
};
