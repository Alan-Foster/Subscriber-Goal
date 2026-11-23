import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  defaultButtonMinWidthPx,
  fitTolerancePx,
  getTinyActionFit,
  inactiveFit,
  maximumFontSizePx,
  type CompactLayoutFit,
  type TinyActionMeasurements,
} from "./tinyActionFit";

const defaultButtonHorizontalPaddingPx = 48;
const defaultButtonGapPx = 8;
const defaultJoinArrowWidthPx = 20;

const parseCssPixels = (value: string, fallback: number): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const sameFit = (left: CompactLayoutFit, right: CompactLayoutFit): boolean =>
  left.active === right.active &&
  left.wrapCta === right.wrapCta &&
  Math.abs(left.fontSizePx - right.fontSizePx) < 0.01 &&
  (left.constrainedCenterWidthPx === right.constrainedCenterWidthPx ||
    (left.constrainedCenterWidthPx !== null &&
      right.constrainedCenterWidthPx !== null &&
      Math.abs(left.constrainedCenterWidthPx - right.constrainedCenterWidthPx) <
        0.01));

function measureTinyAction(
  layout: HTMLDivElement,
  leftStatistic: HTMLSpanElement,
  rightStatistic: HTMLSpanElement,
  ctaLabel: HTMLElement,
  button: HTMLButtonElement,
): TinyActionMeasurements {
  const measuredElements = [leftStatistic, ctaLabel, rightStatistic];
  const previousStyles = measuredElements.map((element) => ({
    fontSize: element.style.fontSize,
    lineHeight: element.style.lineHeight,
    overflowWrap: element.style.overflowWrap,
    whiteSpace: element.style.whiteSpace,
  }));
  for (const element of measuredElements) {
    element.style.fontSize = `${maximumFontSizePx}px`;
    element.style.lineHeight = "normal";
    element.style.overflowWrap = "normal";
    element.style.whiteSpace = "nowrap";
  }

  const containerWidth = layout.clientWidth;
  const leftNaturalWidth = leftStatistic.scrollWidth;
  const rightNaturalWidth = rightStatistic.scrollWidth;
  const ctaNaturalWidth = ctaLabel.scrollWidth;
  const buttonStyles = window.getComputedStyle(button);
  const horizontalPadding =
    parseCssPixels(
      buttonStyles.paddingLeft,
      defaultButtonHorizontalPaddingPx / 2,
    ) +
    parseCssPixels(
      buttonStyles.paddingRight,
      defaultButtonHorizontalPaddingPx / 2,
    );
  const buttonMinWidth = parseCssPixels(
    buttonStyles.minWidth,
    defaultButtonMinWidthPx,
  );
  const arrowElement = Array.from(button.children).find(
    (element) => element !== ctaLabel,
  );
  const arrowVisible =
    arrowElement instanceof HTMLElement &&
    window.getComputedStyle(arrowElement).display !== "none";
  const arrowWidth = arrowVisible
    ? arrowElement.getBoundingClientRect().width || defaultJoinArrowWidthPx
    : 0;
  const buttonGap = arrowVisible
    ? parseCssPixels(buttonStyles.columnGap, defaultButtonGapPx)
    : 0;
  const buttonChromeWidth = horizontalPadding + arrowWidth + buttonGap;

  previousStyles.forEach((previous, index) => {
    const element = measuredElements[index]!;
    element.style.fontSize = previous.fontSize;
    element.style.lineHeight = previous.lineHeight;
    element.style.overflowWrap = previous.overflowWrap;
    element.style.whiteSpace = previous.whiteSpace;
  });

  return {
    containerWidth,
    leftNaturalWidth,
    rightNaturalWidth,
    ctaNaturalWidth,
    buttonMinWidth,
    buttonChromeWidth,
  };
}

export const useTinyActionFit = (
  isWideViewport: boolean,
  children: ReactNode,
  subscriberLabel: string,
  activityLabel: string,
) => {
  const layoutRef = useRef<HTMLDivElement>(null);
  const leftStatisticRef = useRef<HTMLSpanElement>(null);
  const rightStatisticRef = useRef<HTMLSpanElement>(null);
  const lastContainerWidthRef = useRef<number | null>(null);
  const [fit, setFit] = useState<CompactLayoutFit>(inactiveFit);
  useLayoutEffect(() => {
    if (!isWideViewport) {
      setFit((current) =>
        sameFit(current, inactiveFit) ? current : inactiveFit,
      );
      return;
    }

    const layout = layoutRef.current;
    const leftStatistic = leftStatisticRef.current;
    const rightStatistic = rightStatisticRef.current;
    if (!layout || !leftStatistic || !rightStatistic) return;

    let disposed = false;
    let frameId: number | null = null;

    const applyFit = (nextFit: CompactLayoutFit) => {
      if (disposed) return;
      setFit((current) => (sameFit(current, nextFit) ? current : nextFit));
    };

    const measure = () => {
      if (disposed || !layout.isConnected) return;
      const ctaLabel = layout.querySelector<HTMLElement>(
        "[data-subscription-button-label='true']",
      );
      const button = ctaLabel?.closest("button");
      if (!ctaLabel || !button) {
        applyFit(inactiveFit);
        lastContainerWidthRef.current = layout.clientWidth;
        return;
      }

      const measurements = measureTinyAction(
        layout,
        leftStatistic,
        rightStatistic,
        ctaLabel,
        button,
      );
      applyFit(getTinyActionFit(measurements));
      lastContainerWidthRef.current = measurements.containerWidth;
    };

    const scheduleMeasure = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        measure();
      });
    };

    measure();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            const nextWidth =
              entries.find((entry) => entry.target === layout)?.contentRect
                .width ?? layout.clientWidth;
            if (
              lastContainerWidthRef.current !== null &&
              Math.abs(nextWidth - lastContainerWidthRef.current) <=
                fitTolerancePx
            ) {
              return;
            }
            scheduleMeasure();
          });
    resizeObserver?.observe(layout);

    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(scheduleMeasure);
    mutationObserver?.observe(layout, {
      characterData: true,
      childList: true,
      subtree: true,
    });

    const fontSet = document.fonts;
    const handleFontsLoaded = () => scheduleMeasure();
    fontSet?.addEventListener("loadingdone", handleFontsLoaded);
    if (fontSet) {
      void fontSet.ready.then(() => {
        if (!disposed) scheduleMeasure();
      });
    }

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      fontSet?.removeEventListener("loadingdone", handleFontsLoaded);
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [activityLabel, children, isWideViewport, subscriberLabel]);

  return { layoutRef, leftStatisticRef, rightStatisticRef, fit };
};
