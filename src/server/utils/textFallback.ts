import { formatSubscriberCount } from '../../shared/numberFormat';
import type { SubGoalLanguage } from '../../shared/subGoalPostI18n';
import { getSubGoalPostMessages } from '../../shared/subGoalPostI18n';

export type TextFallbackProps = {
  goal: number;
  subscribers: number;
  subredditName: string;
  completedTime: Date | null;
  language?: SubGoalLanguage;
};

export const textFallbackMaker = (props: TextFallbackProps): string => {
  const messages = getSubGoalPostMessages(props.language);
  return props.completedTime
    ? messages.fallbackCompleted({
        subredditName: props.subredditName,
        goalText: formatSubscriberCount(props.goal),
        completedIso: props.completedTime.toISOString(),
      })
    : messages.fallbackActive({
        subredditName: props.subredditName,
        subscribersText: formatSubscriberCount(props.subscribers),
        goalText: formatSubscriberCount(props.goal),
      });
};

type TextFallbackTarget = {
  setTextFallback: (payload: { text: string }) => Promise<void>;
};

const supportsTextFallback = (post: unknown): post is TextFallbackTarget => {
  if (!post || typeof post !== 'object') {
    return false;
  }
  return (
    'setTextFallback' in post &&
    typeof (post as { setTextFallback?: unknown }).setTextFallback === 'function'
  );
};

export const applyTextFallback = async (
  post: unknown,
  props: TextFallbackProps
): Promise<void> => {
  if (!supportsTextFallback(post)) {
    return;
  }
  await post.setTextFallback({ text: textFallbackMaker(props) });
};
