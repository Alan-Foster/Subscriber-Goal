import { useEffect, useState, type CSSProperties } from "react";
import { formatSubscriberCount } from "../../../shared/numberFormat";

type ProgressBarProps = {
  start?: number;
  end?: number;
  current?: number;
  showText?: boolean;
  width?: CSSProperties["width"];
  onActivate?: (() => void) | undefined;
  activationLabel?: string | undefined;
  disabled?: boolean;
};

export const ProgressBar = ({
  start,
  end,
  current,
  showText = false,
  width = "70%",
  onActivate,
  activationLabel,
  disabled = false,
}: ProgressBarProps) => {
  const [animatedProgress, setAnimatedProgress] = useState(0);
  const isInvalid =
    start === undefined ||
    end === undefined ||
    current === undefined ||
    end <= start;
  const progress = isInvalid
    ? 0
    : Math.min(((current - start) / (end - start)) * 100, 100);

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

  const progressContent = (
    <>
      <div
        className="h-6 w-full rounded-md border border-[color:var(--sg-border-strong)] bg-[color:var(--sg-progress-track-bg)]"
        {...(!isInvalid
          ? {
              role: "progressbar",
              "aria-valuemin": start,
              "aria-valuemax": end,
              "aria-valuenow": current,
            }
          : {})}
      >
        {!isInvalid ? (
          <div
            className="h-full rounded-md bg-[color:var(--sg-accent)] transition-[width] duration-700 ease-out"
            style={{ width: `${animatedProgress}%` }}
          />
        ) : null}
      </div>
      {showText && !isInvalid ? (
        <div className="absolute inset-0 flex items-center justify-center text-sm leading-5 font-bold text-[color:var(--sg-progress-text)]">
          {formatSubscriberCount(current)} / {formatSubscriberCount(end)}
        </div>
      ) : null}
    </>
  );

  if (onActivate) {
    return (
      <button
        type="button"
        className="sg-hover-grow relative cursor-pointer border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[color:var(--sg-border-strong)] disabled:cursor-not-allowed"
        style={{ width }}
        aria-label={activationLabel}
        disabled={disabled}
        onClick={disabled ? undefined : onActivate}
      >
        {progressContent}
      </button>
    );
  }

  return (
    <div className="sg-hover-grow relative" style={{ width }}>
      {progressContent}
    </div>
  );
};
