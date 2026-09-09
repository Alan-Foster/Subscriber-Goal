import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TopButtons } from "./TopButtons";

describe("TopButtons", () => {
  it("shows the promo subreddit link text and accessible label", () => {
    const html = renderToStaticMarkup(
      <TopButtons
        onVisitPromoSubPressed={vi.fn()}
        promoSubreddit="SubGoal"
        language="en"
      />,
    );

    expect(html).toContain("r/SubGoal");
    expect(html).toContain("View other subscriber goals in r/SubGoal");
    expect(html).toContain("absolute right-4 top-4");
    expect(html).toContain("text-xs");
    expect(html).not.toContain("text-[8px]");
    expect(html).not.toContain("group-hover:opacity-100");
    expect(html).not.toContain("opacity-0");
    expect(html).not.toContain("max-sm:top-6");
  });

  it("localizes the accessible label", () => {
    const html = renderToStaticMarkup(
      <TopButtons
        onVisitPromoSubPressed={vi.fn()}
        promoSubreddit="SubGoal"
        language="es"
      />,
    );

    expect(html).toContain("Ver otras metas de suscriptores en r/SubGoal");
  });

  it("renders a 20px left notification control", () => {
    const html = renderToStaticMarkup(
      <TopButtons
        onNotificationsPressed={vi.fn()}
        notificationLabel="Notifications"
        onVisitPromoSubPressed={vi.fn()}
        promoSubreddit="SubGoal"
        language="en"
      />,
    );
    expect(html).toContain("absolute left-4 top-4");
    expect(html).toContain('aria-label="Notifications"');
    expect(html).toContain('width="20"');
    expect(html).toContain('height="20"');
  });

  it("reveals compact notification text toward the center", () => {
    const html = renderToStaticMarkup(
      <TopButtons
        revealTextOnInteraction
        onNotificationsPressed={vi.fn()}
        onVisitPromoSubPressed={vi.fn()}
        promoSubreddit="SubGoal"
        language="en"
      />,
    );
    expect(html).toContain("absolute left-full");
    expect(html).toContain("group-hover:opacity-100");
  });
});
