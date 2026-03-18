import { useEffect, useState, type CSSProperties } from 'react';
import { formatNumberUnlessExact } from '../../utils/numberUtils';

type ProgressBarProps = {
  start?: number;
  end?: number;
  current?: number;
  showText?: boolean;
  width?: CSSProperties['width'];
};

export const ProgressBar = ({
  start,
  end,
  current,
  showText = false,
  width = '70%',
}: ProgressBarProps) => {
  const [animatedProgress, setAnimatedProgress] = useState(0);
  const isInvalid = start === undefined || end === undefined || current === undefined || end <= start;
  const progress = isInvalid ? 0 : Math.min(((current - start) / (end - start)) * 100, 100);

  useEffect(() => {
    if (isInvalid) {
      setAnimatedProgress(0);
      return;
    }
    const frame = requestAnimationFrame(() => {
      setAnimatedProgress(progress);
    });
    return () => cancelAnimationFrame(frame);
  }, [isInvalid, progress]);

  if (isInvalid) {
    return (
      <div className="relative" style={{ width }}>
        <div className="h-5 w-full rounded-md border border-[color:var(--sg-border-strong)] bg-[color:#ffffff]" />
      </div>
    );
  }

  return (
    <div className="relative" style={{ width }}>
      <div className="h-5 w-full rounded-md border border-[color:var(--sg-border-strong)] bg-[color:#ffffff]">
        <div
          className="h-full rounded-md bg-[color:var(--sg-accent)] transition-[width] duration-700 ease-out"
          style={{ width: `${animatedProgress}%` }}
        />
      </div>
      {showText ? (
        <div className="absolute inset-0 flex items-center justify-center text-sm font-bold text-[color:#0f172a]">
          {current} / {formatNumberUnlessExact(end)}
        </div>
      ) : null}
    </div>
  );
};
