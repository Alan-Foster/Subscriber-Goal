import { useLayoutEffect, useRef } from "react";

const maximumHeaderFontSizePx = 20;
const minimumHeaderFontSizePx = 12;
const fitTolerancePx = 0.5;

const roundFontSizeDown = (fontSizePx: number): number =>
  Math.floor(fontSizePx * 100) / 100;

type ResponsiveHeaderTextProps = {
  text: string;
};

export const ResponsiveHeaderText = ({ text }: ResponsiveHeaderTextProps) => {
  const textRef = useRef<HTMLSpanElement>(null);
  const lastAvailableWidthRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const textElement = textRef.current;
    if (!textElement) return;

    let disposed = false;
    let frameId: number | null = null;

    const applyFontSize = (fontSizePx: number) => {
      const fontSize = `${fontSizePx}px`;
      if (textElement.style.fontSize !== fontSize) {
        textElement.style.fontSize = fontSize;
      }
    };

    const fitText = () => {
      if (disposed || !textElement.isConnected) return;

      applyFontSize(maximumHeaderFontSizePx);
      const availableWidth = textElement.clientWidth;
      const requiredWidthAtMaximum = textElement.scrollWidth;

      if (availableWidth <= 0 || requiredWidthAtMaximum <= 0) {
        lastAvailableWidthRef.current = availableWidth;
        return;
      }

      let fittedSize = maximumHeaderFontSizePx;
      if (requiredWidthAtMaximum > availableWidth + fitTolerancePx) {
        fittedSize = Math.max(
          minimumHeaderFontSizePx,
          roundFontSizeDown(
            maximumHeaderFontSizePx * (availableWidth / requiredWidthAtMaximum),
          ),
        );
        applyFontSize(fittedSize);

        // Browser scroll widths are integer-rounded. Correct a bounded
        // subpixel overrun without repeatedly searching the layout.
        for (let correction = 0; correction < 2; correction += 1) {
          const fittedAvailableWidth = textElement.clientWidth;
          const fittedRequiredWidth = textElement.scrollWidth;
          if (
            fittedRequiredWidth <= fittedAvailableWidth + fitTolerancePx ||
            fittedSize <= minimumHeaderFontSizePx
          ) {
            break;
          }
          fittedSize = Math.max(
            minimumHeaderFontSizePx,
            roundFontSizeDown(
              fittedSize * (fittedAvailableWidth / fittedRequiredWidth),
            ),
          );
          applyFontSize(fittedSize);
        }
      }

      applyFontSize(fittedSize);
      lastAvailableWidthRef.current = textElement.clientWidth;
    };

    const scheduleFit = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        fitText();
      });
    };

    lastAvailableWidthRef.current = null;
    fitText();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const availableWidth = textElement.clientWidth;
            if (
              lastAvailableWidthRef.current !== null &&
              Math.abs(availableWidth - lastAvailableWidthRef.current) <=
                fitTolerancePx
            ) {
              return;
            }
            scheduleFit();
          });
    resizeObserver?.observe(textElement);
    if (textElement.parentElement) {
      resizeObserver?.observe(textElement.parentElement);
    }

    const fontSet = document.fonts;
    const handleFontsLoaded = () => scheduleFit();
    fontSet?.addEventListener("loadingdone", handleFontsLoaded);
    if (fontSet) {
      void fontSet.ready.then(() => {
        if (!disposed) scheduleFit();
      });
    }

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      fontSet?.removeEventListener("loadingdone", handleFontsLoaded);
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [text]);

  return (
    <span
      ref={textRef}
      className="w-full truncate text-center whitespace-nowrap"
      data-subgoal-header-label="true"
    >
      {text}
    </span>
  );
};
