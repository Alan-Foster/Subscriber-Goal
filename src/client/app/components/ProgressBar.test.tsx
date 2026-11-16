import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressBar } from "./ProgressBar";

describe("ProgressBar", () => {
  it("formats subscriber counts with shared display rules", () => {
    const html = renderToStaticMarkup(
      <ProgressBar current={12632} end={15000} start={0} showText />,
    );

    expect(html).toContain("12632 / 15k");
  });

  it("preserves progress semantics inside an accessible activation button", () => {
    const html = renderToStaticMarkup(
      <ProgressBar
        current={50}
        end={100}
        start={0}
        onActivate={vi.fn()}
        activationLabel="Join r/Example using the progress bar"
      />,
    );

    expect(html).toContain(
      'aria-label="Join r/Example using the progress bar"',
    );
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain("sg-hover-grow");
  });
});
