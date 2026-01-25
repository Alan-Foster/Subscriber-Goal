export const SkeletonPage = () => {
  const skeletonClass =
    'animate-pulse rounded-full bg-[color:var(--sg-surface-muted)]';

  return (
    <div className="relative flex h-[320px] w-full flex-col items-center justify-center gap-5 px-4 py-6">
      <div className={`h-[100px] w-[100px] ${skeletonClass}`} />
      <div className={`h-5 w-48 ${skeletonClass}`} />
      <div className="h-5 w-[70%] rounded-md bg-[color:var(--sg-surface-muted)] animate-pulse" />
      <div className={`h-9 w-56 ${skeletonClass}`} />
      <div className={`h-4 w-40 ${skeletonClass}`} />
    </div>
  );
};
