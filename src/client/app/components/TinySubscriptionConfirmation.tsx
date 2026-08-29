import type { SubGoalLanguage } from "../../../shared/subGoalPostI18n";
import { getSubGoalPostMessages } from "../../../shared/subGoalPostI18n";

export const tinySubscriptionConfirmationDurationMs = 2000;

type TinySubscriptionConfirmationProps = {
  language: SubGoalLanguage;
  subredditName: string;
};

export const TinySubscriptionConfirmation = ({
  language,
  subredditName,
}: TinySubscriptionConfirmationProps) => {
  const messages = getSubGoalPostMessages(language);
  return (
    <div className="relative flex h-full w-full items-center justify-center px-4 py-3 text-center text-base font-semibold text-[color:var(--sg-text-primary)]">
      {messages.subscribedButton({ subredditName })}
    </div>
  );
};
