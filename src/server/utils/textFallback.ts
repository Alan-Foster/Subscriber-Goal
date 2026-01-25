export type TextFallbackProps = {
  goal: number;
  subscribers: number;
  subredditName: string;
  completedTime: Date | null;
};

export const textFallbackMaker = (props: TextFallbackProps): string =>
  props.completedTime
    ? `r/${props.subredditName} reached ${props.goal} subscribers!\n\nGoal reached at \`${props.completedTime.toISOString()}\`.`
    : `Welcome to r/${props.subredditName}\n\n${props.subscribers} / ${props.goal} subscribers.\n  Help us reach our goal!\n\nVisit this post on Shreddit to enjoy interactive features.`;

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
