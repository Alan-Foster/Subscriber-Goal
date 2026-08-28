import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SubscriberGoalState } from "../../../shared/types/api";

vi.mock("@devvit/web/client", () => ({
  context: {
    timezone: "America/New_York",
  },
}));

import { CompletedPage } from "./CompletedPage";

const baseState: SubscriberGoalState = {
  goal: 10,
  recentSubscriber: null,
  completedTime: new Date("2026-04-29T19:32:30.000Z").getTime(),
  headerText: null,
  colorTheme: "red",
  postHeight: "regular",
  language: "en",
  subscribed: true,
  user: { id: "t2_user", username: "alice" },
  appSettings: {
    promoSubreddit: "SubGoal",
  },
  subreddit: {
    id: "t5_test",
    name: "indianActressClass",
    icon: "/icon.png",
    subscribers: 10,
    isNsfw: false,
  },
};

describe("CompletedPage", () => {
  const commonProps = {
    onVisitPromoSub: vi.fn(),
    onCelebrate: vi.fn(),
  };

  const renderCompletedPage = (language: SubscriberGoalState["language"]) =>
    renderToStaticMarkup(
      <CompletedPage state={{ ...baseState, language }} {...commonProps} />,
    );

  it("formats the completed time without seconds and with a month name", () => {
    const html = renderCompletedPage("en");

    expect(html).toContain("Goal reached at 3:32 PM on April 29, 2026");
    expect(html).not.toContain("3:32:30");
    expect(html).not.toContain("4/29/2026");
  });

  it("renders Spanish completed text", () => {
    const html = renderToStaticMarkup(
      <CompletedPage
        state={{ ...baseState, language: "es" }}
        {...commonProps}
      />,
    );

    expect(html).toContain("¡r/indianActressClass alcanzó 10 suscriptores!");
    expect(html).toContain("Meta alcanzada");
  });

  it.each([
    ["es", "abril"],
    ["fr", "avril"],
    ["de", "29. April 2026"],
    ["tr", "Nisan"],
    ["id", "April"],
  ] as const)(
    "renders the completed date with a localized Gregorian month for %s",
    (language, expectedDateText) => {
      const html = renderCompletedPage(language);

      expect(html).toContain(expectedDateText);
      expect(html).not.toContain("4/29/2026");
      expect(html).not.toContain("29/4/2026");
    },
  );

  it("renders the Yoruba completed date with the runtime Gregorian month text", () => {
    const html = renderCompletedPage("yo");
    const expectedDateText = new Intl.DateTimeFormat("yo-NG-u-ca-gregory", {
      timeZone: "America/New_York",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(new Date(baseState.completedTime ?? 0));

    expect(html).toContain(expectedDateText);
    expect(html).not.toContain("4/29/2026");
  });

  it("uses the just-now fallback when completed time is missing", () => {
    const html = renderToStaticMarkup(
      <CompletedPage
        state={{ ...baseState, completedTime: null }}
        {...commonProps}
      />,
    );

    expect(html).toContain("Goal reached just now!");
  });

  it("hides the subreddit logo for short posts", () => {
    const html = renderToStaticMarkup(
      <CompletedPage
        state={{ ...baseState, postHeight: "short" }}
        {...commonProps}
      />,
    );

    expect(html).not.toContain('alt="Subreddit icon"');
    expect(html).toContain("gap-4 px-4 py-6");
    expect(html).not.toContain("max-sm:pt-8");
    expect(html).toContain("text-2xl font-bold");
    expect(html).toContain("text-lg font-semibold");
    expect(html).toContain("r/indianActressClass reached 10 subscribers!");
  });
});
