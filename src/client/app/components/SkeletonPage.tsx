import { resolveSubGoalPostHeight } from '../../../shared/subGoalPostHeight';
import type { SubGoalColorTheme } from '../../../shared/subGoalColorTheme';

type SkeletonPageProps = {
  postHeight?: unknown;
  colorTheme?: SubGoalColorTheme | undefined;
};

export const SkeletonPage = ({ postHeight, colorTheme }: SkeletonPageProps) => {
  const skeletonClass =
    'animate-pulse rounded-full bg-[color:var(--sg-surface-muted)]';
  const resolvedPostHeight = resolveSubGoalPostHeight(postHeight);
  const isShort = resolvedPostHeight === 'short';
  const isTiny = resolvedPostHeight === 'tiny';

  return (
    <div
      className={`sg-goal-frame relative flex ${
        isTiny ? 'h-[100px]' : isShort ? 'h-[234px]' : 'h-[320px]'
      } w-full flex-col items-center justify-center gap-5 px-4 py-6`}
      data-sg-theme={colorTheme}
    >
      {isShort || isTiny ? null : (
        <div className={`h-[100px] w-[100px] ${skeletonClass}`} />
      )}
      {isTiny ? null : <div className={`h-5 w-48 ${skeletonClass}`} />}
      {isTiny ? null : (
        <div className="h-5 w-[70%] rounded-md bg-[color:var(--sg-surface-muted)] animate-pulse" />
      )}
      <div className={`h-9 w-56 ${skeletonClass}`} />
      {isTiny ? null : <div className={`h-4 w-40 ${skeletonClass}`} />}
    </div>
  );
};
