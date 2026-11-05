import { useLayoutEffect, useRef } from "react";
import type { SubGoalColorTheme } from "../../../shared/subGoalColorTheme";
import { useCompactTextFit } from "./CompactTextFitContext";
import { JoinArrowIcon } from "./JoinArrowIcon";

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

const roundFontSizeDown = (fontSizePx: number): number =>
  Math.floor(fontSizePx * 100) / 100;

export type SubscriptionButtonMode =
  | "subscribe"
  | "submitting"
  | "subscribed"
  | "link";

type SubscriptionButtonProps = {
  label: string;
  mobileLabel?: string | undefined;
  mode: SubscriptionButtonMode;
  onClick?: (() => void) | undefined;
  colorTheme?: SubGoalColorTheme | undefined;
};

export const SubscriptionButton = ({
  label,
  mobileLabel,
  mode,
  onClick,
  colorTheme,
}: SubscriptionButtonProps) => {
  const compactTextFit = useCompactTextFit();
  const usesCompactTextFit = compactTextFit !== null;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const lastFitRef = useRef<LabelFit | null>(null);
  const maximumFontSizeRef = useRef(defaultLabelFontSizePx);
  const lastAvailableWidthRef = useRef<number | null>(null);
  const disabled = mode === "submitting" || mode === "subscribed";
  const showAttention = mode === "subscribe" || mode === "link";

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

      let fit: LabelFit;
      if (requiredWidthAtMaximum <= availableWidth + fitTolerancePx) {
        fit = { fontSizePx: maximumFontSizePx, wraps: false };
      } else {
        const proportionalSize = roundFontSizeDown(
          maximumFontSizePx * (availableWidth / requiredWidthAtMaximum),
        );
        let fittedSize = Math.max(minimumFontSizePx, proportionalSize);
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
          fittedSize = Math.max(
            minimumFontSizePx,
            roundFontSizeDown(
              fittedSize * (fittedAvailableWidth / fittedRequiredWidth),
            ),
          );
          labelElement.style.fontSize = `${fittedSize}px`;
        }

        const cannotFitAtMinimum =
          fittedSize <= minimumFontSizePx &&
          labelElement.scrollWidth > labelElement.clientWidth + fitTolerancePx;
        fit = {
          fontSizePx: fittedSize,
          wraps: cannotFitAtMinimum,
        };
      }

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
            const labelWidthChanged = !(
              lastAvailableWidthRef.current !== null &&
              Math.abs(availableWidth - lastAvailableWidthRef.current) <=
                fitTolerancePx
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

  return (
    <span
      className="sg-attention-host relative isolate inline-flex max-w-full"
      data-sg-theme={colorTheme}
      data-subscription-button-mode={mode}
    >
      {showAttention ? (
        <span
          aria-hidden="true"
          className="sg-subscribe-attention-shell absolute"
        >
          <span className="sg-subscribe-attention absolute" />
        </span>
      ) : null}
      <button
        ref={buttonRef}
        className="sg-hover-grow relative z-10 inline-flex min-h-[52px] min-w-[220px] max-w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-[color:var(--sg-accent)] px-6 py-2 text-center text-lg font-semibold whitespace-nowrap text-[color:var(--sg-button-text)] disabled:cursor-not-allowed disabled:opacity-60"
        data-subgoal-primary-cta={mode === "subscribe" ? "true" : undefined}
        data-sg-theme={colorTheme}
        disabled={disabled}
        onClick={disabled ? undefined : onClick}
      >
        <span
          ref={labelRef}
          className="min-w-0 whitespace-nowrap [overflow-wrap:normal]"
          data-subscription-button-label="true"
          style={
            compactTextFit
              ? {
                  fontSize: `${compactTextFit.fontSizePx}px`,
                  lineHeight: compactTextFit.wrapCta ? 1.25 : undefined,
                  overflowWrap: compactTextFit.wrapCta ? "anywhere" : "normal",
                  whiteSpace: compactTextFit.wrapCta ? "normal" : "nowrap",
                }
              : undefined
          }
        >
          {mobileLabel ? (
            <>
              <span className="sm:hidden">{mobileLabel}</span>
              <span className="hidden sm:inline">{label}</span>
            </>
          ) : (
            label
          )}
        </span>
        {mode === "subscribe" ? (
          <span className="hidden shrink-0 sm:inline-flex">
            <JoinArrowIcon />
          </span>
        ) : null}
      </button>
    </span>
  );
};
