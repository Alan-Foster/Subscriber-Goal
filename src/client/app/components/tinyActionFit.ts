import type { CompactTextFit } from "./CompactTextFitContext";

export const maximumFontSizePx = 18;
const minimumFontSizePx = 12;
export const statisticColumnReservationPx = 96;
const statisticHorizontalPaddingPx = 32;
export const defaultButtonMinWidthPx = 220;
export const fitTolerancePx = 0.5;

export type CompactLayoutFit = CompactTextFit & {
  active: boolean;
  constrainedCenterWidthPx: number | null;
};

export const inactiveFit: CompactLayoutFit = {
  active: false,
  fontSizePx: maximumFontSizePx,
  wrapCta: false,
  constrainedCenterWidthPx: null,
};

const floorFontSize = (fontSizePx: number): number =>
  Math.floor(fontSizePx * 100) / 100;

export type TinyActionMeasurements = {
  containerWidth: number;
  leftNaturalWidth: number;
  rightNaturalWidth: number;
  ctaNaturalWidth: number;
  buttonMinWidth: number;
  buttonChromeWidth: number;
};

export function getTinyActionFit({
  containerWidth,
  leftNaturalWidth,
  rightNaturalWidth,
  ctaNaturalWidth,
  buttonMinWidth,
  buttonChromeWidth,
}: TinyActionMeasurements): CompactLayoutFit {
  if (
    containerWidth <= 0 ||
    leftNaturalWidth <= 0 ||
    rightNaturalWidth <= 0 ||
    ctaNaturalWidth <= 0
  ) {
    return { ...inactiveFit, active: true };
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
  if (requiredWidthAt(maximumFontSizePx) <= containerWidth + fitTolerancePx) {
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

  return nextFit;
}
