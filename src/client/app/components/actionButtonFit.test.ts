import { describe, expect, it } from "vitest";
import { getTinyActionFit } from "./tinyActionFit";
import { getProportionalLabelFontSize } from "./useSubscriptionLabelFit";

describe("getTinyActionFit", () => {
  const measurements = {
    containerWidth: 600,
    leftNaturalWidth: 100,
    rightNaturalWidth: 120,
    ctaNaturalWidth: 180,
    buttonMinWidth: 220,
    buttonChromeWidth: 48,
  };

  it("uses the default fit for unmeasurable elements and layouts that already fit", () => {
    const defaultFit = {
      active: true,
      fontSizePx: 18,
      wrapCta: false,
      constrainedCenterWidthPx: null,
    };
    expect(getTinyActionFit({ ...measurements, leftNaturalWidth: 0 })).toEqual(
      defaultFit,
    );
    expect(getTinyActionFit(measurements)).toEqual(defaultFit);
  });

  it("finds a smaller size using the wider statistics column", () => {
    expect(getTinyActionFit({ ...measurements, containerWidth: 460 })).toEqual({
      active: true,
      fontSizePx: 13.23,
      wrapCta: false,
      constrainedCenterWidthPx: null,
    });
  });

  it("constrains the center column and wraps only when needed at minimum size", () => {
    const narrow = { ...measurements, containerWidth: 370 };
    expect(getTinyActionFit(narrow)).toEqual({
      active: true,
      fontSizePx: 12,
      wrapCta: false,
      constrainedCenterWidthPx: 220,
    });
    expect(getTinyActionFit({ ...narrow, ctaNaturalWidth: 300 })).toEqual({
      active: true,
      fontSizePx: 12,
      wrapCta: true,
      constrainedCenterWidthPx: 220,
    });
  });
});

describe("getProportionalLabelFontSize", () => {
  it("rounds down to hundredths and respects the minimum", () => {
    expect(getProportionalLabelFontSize(18, 101, 137, 12)).toBe(13.27);
    expect(getProportionalLabelFontSize(18, 60, 180, 12)).toBe(12);
  });
});
