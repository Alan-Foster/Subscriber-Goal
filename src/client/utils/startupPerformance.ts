import { useLayoutEffect } from "react";

const bootstrapMark = "subgoal:bootstrap";
const initStartMark = "subgoal:init:start";
const initEndMark = "subgoal:init:end";
const ctaCommitMark = "subgoal:cta:commit";
const ctaPaintMark = "subgoal:cta:paint";

const getPerformance = (): Performance | null =>
  typeof performance === "undefined" ? null : performance;

const hasEntry = (name: string): boolean =>
  (getPerformance()?.getEntriesByName(name).length ?? 0) > 0;

const markOnce = (name: string): void => {
  const browserPerformance = getPerformance();
  if (!browserPerformance || hasEntry(name)) return;
  try {
    browserPerformance.mark(name);
  } catch {
    // diagnostic-allow-silent: optional timing instrumentation must never affect the app experience.
  }
};

const measureOnce = (name: string, start: string, end: string): void => {
  const browserPerformance = getPerformance();
  if (
    !browserPerformance ||
    hasEntry(name) ||
    !hasEntry(start) ||
    !hasEntry(end)
  ) {
    return;
  }
  try {
    browserPerformance.measure(name, start, end);
  } catch {
    // diagnostic-allow-silent: optional timing instrumentation must never affect the app experience.
  }
};

export const markInitStart = (): void => {
  markOnce(initStartMark);
};

export const markInitEnd = (): void => {
  markOnce(initEndMark);
  measureOnce("subgoal:init:duration", initStartMark, initEndMark);
};

export const usePrimaryCtaPaintTiming = (
  enabled: boolean,
  renderKey: string,
): void => {
  useLayoutEffect(() => {
    if (
      !enabled ||
      hasEntry(ctaPaintMark) ||
      !hasEntry(bootstrapMark) ||
      !hasEntry(initEndMark) ||
      !document.querySelector("[data-subgoal-primary-cta='true']")
    ) {
      return;
    }

    markOnce(ctaCommitMark);
    const markPaint = () => {
      markOnce(ctaPaintMark);
      measureOnce(
        "subgoal:bootstrap-to-cta-paint",
        bootstrapMark,
        ctaPaintMark,
      );
      measureOnce(
        "subgoal:init-response-to-cta-paint",
        initEndMark,
        ctaPaintMark,
      );
    };
    const frameId = window.requestAnimationFrame(markPaint);
    return () => window.cancelAnimationFrame(frameId);
  }, [enabled, renderKey]);
};
