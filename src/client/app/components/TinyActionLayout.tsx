import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  formatRoundedSubscriberCount,
  formatSubscriberCount,
} from "../../../shared/numberFormat";
import {
  formatLocalizedSubscriberGrowth,
  formatLocalizedSubscriberCount,
  formatLocalizedCtaActivity,
} from "../../../shared/subGoalPostI18n";
import type {
  CtaOnlyState,
  SubscribeOnlyState,
} from "../../../shared/types/api";
import { useWideViewport } from "../../hooks/useWideViewport";
import {
  CompactTextFitProvider,
  type CompactTextFit,
} from "./CompactTextFitContext";

const maximumFontSizePx = 18;
const minimumFontSizePx = 12;
const statisticColumnReservationPx = 96;
const statisticHorizontalPaddingPx = 32;
const defaultButtonMinWidthPx = 220;
const defaultButtonHorizontalPaddingPx = 48;
const defaultButtonGapPx = 8;
const defaultJoinArrowWidthPx = 20;
const fitTolerancePx = 0.5;

type CompactLayoutFit = CompactTextFit & {
  active: boolean;
  constrainedCenterWidthPx: number | null;
};

const inactiveFit: CompactLayoutFit = {
  active: false,
  fontSizePx: maximumFontSizePx,
  wrapCta: false,
  constrainedCenterWidthPx: null,
};

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

const floorFontSize = (fontSizePx: number): number =>
  Math.floor(fontSizePx * 100) / 100;

type TinyActionLayoutProps = {
  state: SubscribeOnlyState | CtaOnlyState;
  children: ReactNode;
  showCtaActivity?: boolean;
};

export const TinyActionLayout = ({
  state,
  children,
  showCtaActivity = false,
}: TinyActionLayoutProps) => {
  const isWideViewport = useWideViewport();
  const layoutRef = useRef<HTMLDivElement>(null);
  const leftStatisticRef = useRef<HTMLSpanElement>(null);
  const rightStatisticRef = useRef<HTMLSpanElement>(null);
  const lastContainerWidthRef = useRef<number | null>(null);
  const [fit, setFit] = useState<CompactLayoutFit>(inactiveFit);
  const ctaActivity = state.ctaActivity ?? {
    kind: "posts" as const,
    count: 1,
    period: "week" as const,
  };
  const subscriberLabel = formatLocalizedSubscriberCount(
    state.language,
    state.subreddit.subscribers,
    formatRoundedSubscriberCount(state.subreddit.subscribers),
  );
  const activityLabel = showCtaActivity
    ? formatLocalizedCtaActivity(
        state.language,
        ctaActivity,
        formatSubscriberCount(ctaActivity.count),
      )
    : formatLocalizedSubscriberGrowth(
        state.language,
        state.subreddit.growth,
        formatSubscriberCount(state.subreddit.growth.count),
      );

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

      if (
        containerWidth <= 0 ||
        leftNaturalWidth <= 0 ||
        rightNaturalWidth <= 0 ||
        ctaNaturalWidth <= 0
      ) {
        applyFit({ ...inactiveFit, active: true });
        lastContainerWidthRef.current = containerWidth;
        return;
      }

      const widestStatistic = Math.max(leftNaturalWidth, rightNaturalWidth);
      const requiredWidthAt = (fontSizePx: number): number => {
        const scale = fontSizePx / maximumFontSizePx;
        const statisticWidth =
          widestStatistic * scale + statisticHorizontalPaddingPx;
        const buttonWidth = Math.max(
          buttonMinWidth,
          ctaNaturalWidth * scale + buttonChromeWidth,
        );
        return statisticWidth * 2 + buttonWidth;
      };

      let nextFit: CompactLayoutFit;
      if (
        requiredWidthAt(maximumFontSizePx) <=
        containerWidth + fitTolerancePx
      ) {
        nextFit = {
          active: true,
          fontSizePx: maximumFontSizePx,
          wrapCta: false,
          constrainedCenterWidthPx: null,
        };
      } else if (
        requiredWidthAt(minimumFontSizePx) <=
        containerWidth + fitTolerancePx
      ) {
        let lower = minimumFontSizePx;
        let upper = maximumFontSizePx;
        for (let iteration = 0; iteration < 10; iteration += 1) {
          const candidate = (lower + upper) / 2;
          if (requiredWidthAt(candidate) <= containerWidth + fitTolerancePx) {
            lower = candidate;
          } else {
            upper = candidate;
          }
        }
        nextFit = {
          active: true,
          fontSizePx: floorFontSize(lower),
          wrapCta: false,
          constrainedCenterWidthPx: null,
        };
      } else {
        const centerWidth = Math.max(
          buttonMinWidth,
          containerWidth - statisticColumnReservationPx * 2,
        );
        const ctaWidthAtMinimum = Math.max(
          buttonMinWidth,
          ctaNaturalWidth * (minimumFontSizePx / maximumFontSizePx) +
            buttonChromeWidth,
        );
        nextFit = {
          active: true,
          fontSizePx: minimumFontSizePx,
          wrapCta: ctaWidthAtMinimum > centerWidth + fitTolerancePx,
          constrainedCenterWidthPx: centerWidth,
        };
      }

      applyFit(nextFit);
      lastContainerWidthRef.current = containerWidth;
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

  if (!isWideViewport) {
    return children;
  }

  const compactTextFit: CompactTextFit | null = fit.active
    ? { fontSizePx: fit.fontSizePx, wrapCta: fit.wrapCta }
    : null;
  const constrainedColumns =
    fit.active && fit.constrainedCenterWidthPx !== null
      ? `minmax(${statisticColumnReservationPx}px, 1fr) minmax(${defaultButtonMinWidthPx}px, ${fit.constrainedCenterWidthPx}px) minmax(${statisticColumnReservationPx}px, 1fr)`
      : undefined;

  return (
    <div
      ref={layoutRef}
      className="grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center"
      data-compact-font-size={fit.active ? fit.fontSizePx : undefined}
      data-compact-cta-wrap={fit.active ? String(fit.wrapCta) : undefined}
      data-tiny-wide-layout="true"
      style={{
        fontSize: fit.active ? `${fit.fontSizePx}px` : undefined,
        gridTemplateColumns: constrainedColumns,
      }}
    >
      <div
        className={`${fit.active ? "" : "text-base"} min-w-0 px-4 text-center font-semibold text-[color:var(--sg-text-secondary)]`}
      >
        <span
          ref={leftStatisticRef}
          className="block truncate"
          data-subscriber-count="true"
        >
          {subscriberLabel}
        </span>
      </div>
      <div className="min-w-0 max-w-full">
        <CompactTextFitProvider value={compactTextFit}>
          {children}
        </CompactTextFitProvider>
      </div>
      <div
        className={`${fit.active ? "" : "text-base"} min-w-0 px-4 text-center font-semibold text-[color:var(--sg-text-secondary)]`}
      >
        <span
          ref={rightStatisticRef}
          className="block truncate"
          data-compact-activity="true"
        >
          {activityLabel}
        </span>
      </div>
    </div>
  );
};
