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

      expect(html).toContain("sg-attention-host");
      expect(html).toContain('class="sg-subscribe-attention-shell absolute"');
      expect(html).toContain('class="sg-subscribe-attention absolute"');
      expect(html).toContain(`data-subscription-button-mode="${mode}"`);
      expect(html).toContain("rounded-full");
      expect(html).toContain("px-6 py-2");
      expect(html).toContain("min-h-[52px]");
      expect(html).toContain("min-w-[220px]");
      expect(html).toContain("gap-2");
      expect(html).toContain("text-lg");
      expect(html).toContain("sg-hover-grow");
      expect(html).toContain("max-w-full");
      expect(html).toContain("text-center");
      expect(html).toContain("whitespace-normal");
      expect(html).toContain("[overflow-wrap:anywhere]");
      expect(html).not.toContain('disabled=""');
      if (mode === "subscribe") {
        expect(html).toContain('data-subgoal-primary-cta="true"');
        expect(html).toContain('viewBox="0 0 20 20"');
        expect(html).toContain('d="M2.5 10h15m-6-6 6 6-6 6"');
        expect(html).toContain('stroke-width="2.5"');
        expect(html).toContain('aria-hidden="true"');
      } else {
        expect(html).not.toContain("data-subgoal-primary-cta");
        expect(html).not.toContain('viewBox="0 0 20 20"');
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
      expect(html).not.toContain("sg-subscribe-attention-shell");
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
    expect(html).toContain('class="sg-subscribe-attention-shell absolute"');
    expect(html).toContain('class="sg-subscribe-attention absolute"');
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

    expect(html).toContain(">Visit Website</span></button>");
    expect(html).not.toContain("sm:hidden");
    expect(html).not.toContain("hidden sm:inline");
  });
});
