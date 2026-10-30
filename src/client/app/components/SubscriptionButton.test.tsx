import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SubscriptionButton } from "./SubscriptionButton";

describe("SubscriptionButton", () => {
  it.each(["subscribe", "link"] as const)(
    "animates an actionable %s button with the shared styling",
    (mode) => {
      const html = renderToStaticMarkup(
        <SubscriptionButton
          label={mode === "subscribe" ? "Join r/ExampleSub" : "Visit Website"}
          mode={mode}
          onClick={vi.fn()}
        />,
      );

      expect(html).toContain("sg-subscribe-attention");
      expect(html).toContain(`data-subscription-button-mode="${mode}"`);
      expect(html).toContain("rounded-full");
      expect(html).toContain("px-6 py-2");
      expect(html).toContain("max-w-full");
      expect(html).toContain("text-center");
      expect(html).toContain("whitespace-normal");
      expect(html).toContain("[overflow-wrap:anywhere]");
      expect(html).not.toContain('disabled=""');
      if (mode === "subscribe") {
        expect(html).toContain('data-subgoal-primary-cta="true"');
      } else {
        expect(html).not.toContain("data-subgoal-primary-cta");
      }
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

  it("renders responsive labels inside one button when a mobile label is provided", () => {
    const html = renderToStaticMarkup(
      <SubscriptionButton
        label="Install Subscriber Goal Now"
        mobileLabel="Install SubGoal Now"
        mode="link"
        onClick={vi.fn()}
      />,
    );

    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain(
      '<span class="sm:hidden">Install SubGoal Now</span>',
    );
    expect(html).toContain(
      '<span class="hidden sm:inline">Install Subscriber Goal Now</span>',
    );
  });

  it("renders an unchanged plain label when no mobile label is provided", () => {
    const html = renderToStaticMarkup(
      <SubscriptionButton label="Visit Website" mode="link" />,
    );

    expect(html).toContain(">Visit Website</button>");
    expect(html).not.toContain("sm:hidden");
    expect(html).not.toContain("hidden sm:inline");
  });
});
