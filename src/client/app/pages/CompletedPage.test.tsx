// @vitest-environment jsdom

import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
  afterSubscribeAction: { type: "disabled" },
  subscribed: true,
  moderatorInstallPromoEligible: false,
  canViewStatistics: false,
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
  beforeAll(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  const commonProps = {
    onVisitPromoSub: vi.fn(),
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

  it("renders Hindi completed text and a localized Gregorian date", () => {
    const html = renderCompletedPage("hi");
    const expectedDateText = new Intl.DateTimeFormat("hi-IN-u-ca-gregory", {
      timeZone: "America/New_York",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(new Date(baseState.completedTime ?? 0));

    expect(html).toContain(
      "r/indianActressClass ने 10 सब्सक्राइबर पूरे कर लिए!",
    );
    expect(html).toContain(expectedDateText);
    expect(html).toContain("लक्ष्य");
  });

  it.each([
    [
      "pa",
      "pa-IN-u-ca-gregory",
      "r/indianActressClass ਨੇ 10 ਸਬਸਕ੍ਰਾਈਬਰਾਂ ਦਾ ਟੀਚਾ ਪੂਰਾ ਕਰ ਲਿਆ!",
      "ਟੀਚਾ",
    ],
    [
      "mr",
      "mr-IN-u-ca-gregory",
      "r/indianActressClass ने 10 सबस्क्राइबरचा टप्पा गाठला!",
      "ध्येय",
    ],
  ] as const)(
    "renders %s completed text and a localized Gregorian date",
    (language, locale, title, goalWord) => {
      const html = renderCompletedPage(language);
      const expectedDateText = new Intl.DateTimeFormat(locale, {
        timeZone: "America/New_York",
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(new Date(baseState.completedTime ?? 0));

      expect(html).toContain(title);
      expect(html).toContain(expectedDateText);
      expect(html).toContain(goalWord);
    },
  );

  it("renders an existing pt post with Brazilian Portuguese formatting", () => {
    const html = renderCompletedPage("pt");
    const expectedDateText = new Intl.DateTimeFormat("pt-BR-u-ca-gregory", {
      timeZone: "America/New_York",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(new Date(baseState.completedTime ?? 0));

    expect(html).toContain("r/indianActressClass alcançou 10 inscritos!");
    expect(html).toContain(expectedDateText);
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

  it("toggles Camera Mode instantly and resets it after remounting", async () => {
    const container = document.createElement("div");
    let root = createRoot(container);
    const renderPage = () =>
      root.render(<CompletedPage state={baseState} {...commonProps} />);

    await act(async () => renderPage());

    let toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Enable Camera Mode"]',
    );
    let blocks = container.querySelectorAll<HTMLElement>(
      "[data-camera-mode-block]",
    );
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    expect(toggle?.title).toBe("Enable Camera Mode");
    expect(toggle?.className).toContain("right-4");
    expect(toggle?.className).toContain("bottom-4");
    expect(
      toggle?.querySelector("[data-camera-mode-slash='true']"),
    ).not.toBeNull();
    expect(blocks).toHaveLength(2);
    blocks.forEach((block) => {
      expect(block.className).not.toContain("bg-[color:var(--sg-bg)]");
      expect(block.className).not.toContain("px-2");
      expect(block.className).not.toContain("py-1");
    });

    await act(async () => toggle?.click());

    toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Disable Camera Mode"]',
    );
    blocks = container.querySelectorAll<HTMLElement>(
      "[data-camera-mode-block]",
    );
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(toggle?.title).toBe("Disable Camera Mode");
    expect(toggle?.querySelector("[data-camera-mode-slash='true']")).toBeNull();
    blocks.forEach((block) => {
      expect(block.className).toContain("bg-[color:var(--sg-bg)]");
      expect(block.className).toContain("px-2");
      expect(block.className).toContain("py-1");
    });

    await act(async () => toggle?.click());
    expect(
      container
        .querySelector('button[aria-label="Enable Camera Mode"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Enable Camera Mode"]',
        )
        ?.click();
      root.unmount();
    });
    root = createRoot(container);
    await act(async () => renderPage());

    expect(
      container
        .querySelector('button[aria-label="Enable Camera Mode"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");

    await act(async () => root.unmount());
  });

  it("uses the English Camera Mode fallback label in localized posts", () => {
    const html = renderCompletedPage("es");

    expect(html).toContain('aria-label="Enable Camera Mode"');
    expect(html).toContain('title="Enable Camera Mode"');
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

  it.each([
    {
      type: "link" as const,
      buttonText: "Visit Website",
      url: "https://example.com/",
      colorTheme: "pink" as const,
    },
    {
      type: "top-post-day" as const,
      buttonText: "View the Top Post Today",
      colorTheme: "blue" as const,
    },
  ])("never renders a CTA on the completed page (%o)", (action) => {
    const html = renderToStaticMarkup(
      <CompletedPage
        state={{
          ...baseState,
          afterSubscribeAction: action,
        }}
        {...commonProps}
      />,
    );

    expect(html).not.toContain(action.buttonText);
    expect(html).not.toContain("sg-subscribe-attention");
  });
});
