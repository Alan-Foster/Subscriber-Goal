import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  SubGoalState,
  SubscribeOnlyState,
} from "../../../shared/types/api";
import { ThanksPage } from "./ThanksPage";

const baseState: SubGoalState = {
  goal: 10,
  recentSubscriber: null,
  completedTime: null,
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
    name: "ExampleSub",
    icon: "/icon.png",
    subscribers: 10,
    isNsfw: false,
  },
};

const tinyState: SubscribeOnlyState = {
  colorTheme: "red",
  postHeight: "tiny",
  language: "en",
  subscribed: true,
  authenticated: true,
  subreddit: { name: "ExampleSub" },
};

describe("ThanksPage", () => {
  const commonProps = {
    onReturn: vi.fn(),
    onVisitPromoSub: vi.fn(),
    onCelebrate: vi.fn(),
  };

  it("renders Spanish thanks text", () => {
    const html = renderToStaticMarkup(
      <ThanksPage state={{ ...baseState, language: "es" }} {...commonProps} />,
    );

    expect(html).toContain("¡Gracias por suscribirte!");
    expect(html).toContain("Ahora hay 10 suscriptores en la comunidad!");
    expect(html).toContain("Volver a la página anterior");
  });

  it("hides the subreddit logo for short posts", () => {
    const html = renderToStaticMarkup(
      <ThanksPage
        state={{ ...baseState, postHeight: "short" }}
        {...commonProps}
      />,
    );

    expect(html).not.toContain('alt="Subreddit icon"');
    expect(html).toContain("gap-4 px-4 py-6");
    expect(html).not.toContain("max-sm:pt-8");
    expect(html).toContain("text-2xl font-bold");
    expect(html).toContain("text-lg font-semibold");
    expect(html).toContain("Thanks for Subscribing!");
  });

  it("renders only the localized tiny subscription confirmation", () => {
    const html = renderToStaticMarkup(
      <ThanksPage state={tinyState} {...commonProps} />,
    );

    expect(html).toContain("Subscribed to r/ExampleSub");
    expect(html).not.toContain("View other subscriber goals in r/SubGoal");
    expect(html).not.toContain('alt="Subreddit icon"');
    expect(html).not.toContain("Thanks for Subscribing!");
    expect(html).not.toContain("subscribers in the community");
    expect(html).not.toContain("Return to Previous Page");
    expect(html).toContain("px-4 py-3");
  });
});
