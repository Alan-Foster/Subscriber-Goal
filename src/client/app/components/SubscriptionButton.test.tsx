import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SubscriptionButton } from "./SubscriptionButton";

describe("SubscriptionButton", () => {
  it.each(["subscribe", "link"] as const)(
    "animates an actionable %s button with the shared styling",
    (mode) => {
      const html = renderToStaticMarkup(
        <SubscriptionButton
          label={
            mode === "subscribe" ? "Subscribe to r/ExampleSub" : "Visit Website"
          }
          mode={mode}
          onClick={vi.fn()}
        />,
      );

      expect(html).toContain("sg-subscribe-attention");
      expect(html).toContain(`data-subscription-button-mode="${mode}"`);
      expect(html).toContain("rounded-full");
      expect(html).toContain("px-6 py-2");
      expect(html).not.toContain('disabled=""');
    },
  );

  it.each(["submitting", "subscribed"] as const)(
    "disables %s mode without attention animation",
    (mode) => {
      const html = renderToStaticMarkup(
        <SubscriptionButton label="Subscribed" mode={mode} />,
      );

      expect(html).not.toContain("sg-subscribe-attention");
      expect(html).toContain('disabled=""');
    },
  );

  it("uses the selected theme for a link and its attention wrapper", () => {
    const html = renderToStaticMarkup(
      <SubscriptionButton
        colorTheme="pink"
        label="Visit Website"
        mode="link"
        onClick={vi.fn()}
      />,
    );

    expect(html).toContain('data-sg-theme="pink"');
    expect(html).toContain("sg-subscribe-attention");
    expect(html).not.toContain('disabled=""');
  });
});
