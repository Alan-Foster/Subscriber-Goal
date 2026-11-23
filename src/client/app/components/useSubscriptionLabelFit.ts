import { useLayoutEffect, useRef } from "react";
import type { SubscriptionButtonMode } from "./SubscriptionButton";

const defaultLabelFontSizePx = 18;
const minimumLabelFontSizePx = 12;
const fitTolerancePx = 0.5;
const responsiveLabelMediaQuery = "(min-width: 640px)";

type LabelFit = {
  fontSizePx: number;
  wraps: boolean;
};

const parseFontSize = (fontSize: string): number => {
  const parsed = Number.parseFloat(fontSize);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : defaultLabelFontSizePx;
};

export function getProportionalLabelFontSize(
  fontSizePx: number,
  availableWidth: number,
  requiredWidth: number,
  minimumFontSizePx: number,
): number {
  const proportionalSize =
    Math.floor(fontSizePx * (availableWidth / requiredWidth) * 100) / 100;
  return Math.max(minimumFontSizePx, proportionalSize);
}

function measureLabelFit(
  labelElement: HTMLSpanElement,
  availableWidth: number,
  requiredWidthAtMaximum: number,
  maximumFontSizePx: number,
  minimumFontSizePx: number,
): LabelFit {
  if (requiredWidthAtMaximum <= availableWidth + fitTolerancePx) {
    return { fontSizePx: maximumFontSizePx, wraps: false };
  }

  let fittedSize = getProportionalLabelFontSize(
    maximumFontSizePx,
    availableWidth,
    requiredWidthAtMaximum,
    minimumFontSizePx,
  );
  labelElement.style.fontSize = `${fittedSize}px`;

  // scrollWidth is integer-rounded in browsers. A bounded correction
  // avoids wrapping from a subpixel overrun without repeated searches.
  for (let correction = 0; correction < 2; correction += 1) {
    const fittedAvailableWidth = labelElement.clientWidth;
    const fittedRequiredWidth = labelElement.scrollWidth;
    if (
      fittedRequiredWidth <= fittedAvailableWidth + fitTolerancePx ||
      fittedSize <= minimumFontSizePx
    ) {
      break;
    }
    fittedSize = getProportionalLabelFontSize(
      fittedSize,
      fittedAvailableWidth,
      fittedRequiredWidth,
      minimumFontSizePx,
    );
    labelElement.style.fontSize = `${fittedSize}px`;
  }

  const cannotFitAtMinimum =
    fittedSize <= minimumFontSizePx &&
    labelElement.scrollWidth > labelElement.clientWidth + fitTolerancePx;
  return { fontSizePx: fittedSize, wraps: cannotFitAtMinimum };
}

function observeLabelWidths(
  button: HTMLButtonElement,
  labelElement: HTMLSpanElement,
  getLastAvailableWidth: () => number | null,
  scheduleFit: () => void,
) {
  const resizeAncestors = [
    button.parentElement?.parentElement,
    button.parentElement?.parentElement?.parentElement,
  ].filter((element): element is HTMLElement => element !== null);
  const ancestorWidths = new WeakMap<HTMLElement, number>();
  for (const ancestor of resizeAncestors) {
    ancestorWidths.set(ancestor, ancestor.getBoundingClientRect().width);
  }

  const resizeObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          const availableWidth = labelElement.clientWidth;
          const lastAvailableWidth = getLastAvailableWidth();
          const labelWidthChanged = !(
            lastAvailableWidth !== null &&
            Math.abs(availableWidth - lastAvailableWidth) <= fitTolerancePx
          );
          let ancestorWidthChanged = false;
          for (const entry of entries) {
            if (!(entry.target instanceof HTMLElement)) continue;
            const previousWidth = ancestorWidths.get(entry.target);
            if (previousWidth === undefined) continue;
            const nextWidth = entry.contentRect.width;
            ancestorWidths.set(entry.target, nextWidth);
            if (Math.abs(nextWidth - previousWidth) > fitTolerancePx) {
              ancestorWidthChanged = true;
            }
          }
          if (!labelWidthChanged && !ancestorWidthChanged) return;
          scheduleFit();
        });
  resizeObserver?.observe(labelElement);
  resizeObserver?.observe(button);
  for (const ancestor of resizeAncestors) resizeObserver?.observe(ancestor);

  return resizeObserver;
}

export function useSubscriptionLabelFit(
  label: string,
  mobileLabel: string | undefined,
  mode: SubscriptionButtonMode,
  usesCompactTextFit: boolean,
) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const lastFitRef = useRef<LabelFit | null>(null);
  const maximumFontSizeRef = useRef(defaultLabelFontSizePx);
  const lastAvailableWidthRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (usesCompactTextFit) return;
    const button = buttonRef.current;
    const labelElement = labelRef.current;
    if (!button || !labelElement) return;

    let disposed = false;
    let frameId: number | null = null;
    let forceScheduledFit = false;

    const applyFit = (fit: LabelFit) => {
      const fontSize = `${fit.fontSizePx}px`;
      const whiteSpace = fit.wraps ? "normal" : "nowrap";
      const overflowWrap = fit.wraps ? "anywhere" : "normal";
      if (labelElement.style.fontSize !== fontSize) {
        labelElement.style.fontSize = fontSize;
      }
      if (labelElement.style.whiteSpace !== whiteSpace) {
        labelElement.style.whiteSpace = whiteSpace;
      }
      if (labelElement.style.overflowWrap !== overflowWrap) {
        labelElement.style.overflowWrap = overflowWrap;
      }
      lastFitRef.current = fit;
    };

    const fitLabel = (refreshMaximum: boolean) => {
      if (disposed || !labelElement.isConnected) return;

      const shouldRefreshMaximum =
        refreshMaximum || lastFitRef.current === null;
      if (shouldRefreshMaximum) {
        labelElement.style.removeProperty("font-size");
      }
      labelElement.style.whiteSpace = "nowrap";
      labelElement.style.overflowWrap = "normal";

      if (shouldRefreshMaximum) {
        maximumFontSizeRef.current = Math.min(
          defaultLabelFontSizePx,
          parseFontSize(window.getComputedStyle(labelElement).fontSize),
        );
      }
      const maximumFontSizePx = maximumFontSizeRef.current;
      const minimumFontSizePx = Math.min(
        minimumLabelFontSizePx,
        maximumFontSizePx,
      );

      labelElement.style.fontSize = `${maximumFontSizePx}px`;
      const availableWidth = labelElement.clientWidth;
      const requiredWidthAtMaximum = labelElement.scrollWidth;

      if (availableWidth <= 0 || requiredWidthAtMaximum <= 0) {
        applyFit({ fontSizePx: maximumFontSizePx, wraps: false });
        lastAvailableWidthRef.current = availableWidth;
        return;
      }

      const fit = measureLabelFit(
        labelElement,
        availableWidth,
        requiredWidthAtMaximum,
        maximumFontSizePx,
        minimumFontSizePx,
      );
      applyFit(fit);
      lastAvailableWidthRef.current = labelElement.clientWidth;
    };

    const scheduleFit = (refreshMaximum = false) => {
      forceScheduledFit ||= refreshMaximum;
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        const shouldRefreshMaximum = forceScheduledFit;
        forceScheduledFit = false;
        fitLabel(shouldRefreshMaximum);
      });
    };

    lastFitRef.current = null;
    maximumFontSizeRef.current = defaultLabelFontSizePx;
    lastAvailableWidthRef.current = null;
    fitLabel(true);

    const resizeObserver = observeLabelWidths(
      button,
      labelElement,
      () => lastAvailableWidthRef.current,
      scheduleFit,
    );

    const mediaQuery = mobileLabel
      ? window.matchMedia?.(responsiveLabelMediaQuery)
      : null;
    const handleResponsiveLabelChange = () => scheduleFit(true);
    mediaQuery?.addEventListener("change", handleResponsiveLabelChange);

    const fontSet = document.fonts;
    const handleFontsLoaded = () => scheduleFit(true);
    fontSet?.addEventListener("loadingdone", handleFontsLoaded);
    if (fontSet) {
      void fontSet.ready.then(() => {
        if (!disposed) scheduleFit(true);
      });
    }

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      mediaQuery?.removeEventListener("change", handleResponsiveLabelChange);
      fontSet?.removeEventListener("loadingdone", handleFontsLoaded);
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [label, mobileLabel, mode, usesCompactTextFit]);

  return { buttonRef, labelRef };
}
