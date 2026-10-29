import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  SubscriberGoalState,
  SubscribeOnlyState,
} from "../../../shared/types/api";
import { ThanksPage } from "./ThanksPage";

const baseState: SubscriberGoalState = {
  goal: 10,
  recentSubscriber: null,
  completedTime: null,
  headerText: null,
  colorTheme: "red",
  postHeight: "regular",
  language: "en",
  afterSubscribeAction: { type: "disabled" },
  subscribed: true,
  moderatorInstallPromoEligible: false,
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
  promoSubreddit: "SubGoal",
  language: "en",
  afterSubscribeAction: { type: "disabled" },
  subscribed: true,
  authenticated: true,
  subreddit: {
    name: "ExampleSub",
    subscribers: 10,
    growth: { count: 4, period: "today" },
  },
};

describe("ThanksPage", () => {
  const commonProps = {
    onReturn: vi.fn(),
    onVisitPromoSub: vi.fn(),
    onAfterSubscribeNavigate: vi.fn(),
    notificationOptInEnabled: false,
  };

  it("renders Spanish thanks text", () => {
    const html = renderToStaticMarkup(
      <ThanksPage state={{ ...baseState, language: "es" }} {...commonProps} />,
    );

    expect(html).toContain("¡Gracias por unirte!");
    expect(html).toContain("Ahora hay 10 suscriptores en la comunidad!");
    expect(html).toContain('aria-label="Volver a la página anterior"');
    expect(html).toContain(">Volver</button>");
  });

  it("renders Hindi thanks text and an unambiguous notification goal", () => {
    const html = renderToStaticMarkup(
      <ThanksPage
        state={{ ...baseState, language: "hi" }}
        {...commonProps}
        notificationOptInEnabled
        onNotificationOptIn={vi.fn()}
      />,
    );

    expect(html).toContain("शामिल होने के लिए धन्यवाद!");
    expect(html).toContain("कम्यूनिटी में अब 10 सब्सक्राइबर हैं!");
    expect(html).toContain("10 सब्सक्राइबर होने पर सूचना पाएँ");
    expect(html).toContain('aria-label="पिछले पेज पर वापस जाएँ"');
  });

  it("renders the Hindi moderator install promotion", () => {
    const html = renderToStaticMarkup(
      <ThanksPage
        state={{ ...baseState, language: "hi" }}
        {...commonProps}
        showModeratorInstallPromo
        onModeratorInstall={vi.fn()}
      />,
    );

    expect(html).toContain("नमस्ते");
    expect(html).toContain("u/alice</span>,");
    expect(html).toContain("अभी अपने सबरेडिट्स में Subscriber Goal जोड़ें!");
    expect(html).toContain("अभी SubGoal इंस्टॉल करें");
    expect(html).toContain("अभी Subscriber Goal इंस्टॉल करें");
  });

  it.each([
    ["pa", "ਸ਼ਾਮਲ ਹੋਣ ਲਈ ਧੰਨਵਾਦ!", "ਇਸ ਕਮਿਊਨਿਟੀ ਵਿੱਚ ਹੁਣ 10 ਸਬਸਕ੍ਰਾਈਬਰ ਹਨ!"],
    [
      "mr",
      "सामील झाल्याबद्दल धन्यवाद!",
      "या समुदायात आता 10 सबस्क्राइबर आहेत!",
    ],
  ] as const)("renders the %s Thanks experience", (language, title, body) => {
    const html = renderToStaticMarkup(
      <ThanksPage state={{ ...baseState, language }} {...commonProps} />,
    );

    expect(html).toContain(title);
    expect(html).toContain(body);
  });

  it("renders the Punjabi moderator install promotion", () => {
    const html = renderToStaticMarkup(
      <ThanksPage
        state={{ ...baseState, language: "pa" }}
        {...commonProps}
        showModeratorInstallPromo
        onModeratorInstall={vi.fn()}
      />,
    );

    expect(html).toContain("ਸਤ ਸ੍ਰੀ ਅਕਾਲ");
    expect(html).toContain(
      "ਹੁਣੇ ਆਪਣੇ ਸਬਰੇਡਿਟਾਂ ਵਿੱਚ Subscriber Goal ਸ਼ਾਮਲ ਕਰੋ!",
    );
    expect(html).toContain("ਹੁਣੇ SubGoal ਇੰਸਟਾਲ ਕਰੋ");
  });

  it("hides the subreddit logo for short posts", () => {
    const html = renderToStaticMarkup(
      <ThanksPage
        state={{ ...baseState, postHeight: "short" }}
        {...commonProps}
        notificationOptInEnabled
        onNotificationOptIn={vi.fn()}
      />,
    );

    expect(html).not.toContain('alt="Subreddit icon"');
    expect(html).toContain("gap-4 px-4 py-6");
    expect(html).not.toContain("max-sm:pt-8");
    expect(html).toContain("text-2xl font-bold");
    expect(html).toContain("text-lg font-semibold");
    expect(html).toContain("Thanks for Joining!");
    expect(html).toContain("Get Notified at 10");
    expect(html).toContain("sg-subscribe-attention");
    expect(html).toContain('data-thanks-actions-layout="short"');
    expect(html).toContain("flex-row items-center");
    expect(html).toContain("px-4 py-2 text-sm leading-tight");
    expect(html).toContain("flex-1 sm:max-w-96 sm:flex-none");
    expect(html).toContain("w-full");
    expect(html).toContain("sm:w-auto sm:max-w-96");
  });

  it("shows a large themed notification action in the button row", () => {
    const html = renderToStaticMarkup(
      <ThanksPage
        state={{ ...baseState, goal: 10_000 }}
        {...commonProps}
        notificationOptInEnabled
        onNotificationOptIn={vi.fn()}
      />,
    );

    expect(html).toContain('data-goal-notification-action="true"');
    expect(html).toContain('data-sg-theme="red"');
    expect(html).toContain("Get Notified at 10k");
    expect(html).toContain("sg-subscribe-attention");
    expect(html).toContain('data-thanks-actions-layout="regular"');
    expect(html).toContain("flex-col items-stretch");
    expect(html).toContain("min-[380px]:flex-row");
    expect(html).toContain("flex-1 sm:max-w-96 sm:flex-none");
    expect(html).toContain("sm:w-auto sm:max-w-96");
    expect(html).toContain("whitespace-normal");
    expect(html).not.toContain("truncate");
    expect(html).not.toContain("You’ll be notified");
  });

  it("disables the notification action while submitting", () => {
    const html = renderToStaticMarkup(
      <ThanksPage
        state={baseState}
        {...commonProps}
        notificationOptInEnabled
        notificationSubmitting
        onNotificationOptIn={vi.fn()}
      />,
    );

    expect(html).toContain('data-goal-notification-action="true"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("sg-subscribe-attention");
  });

  it("hides the goal prompt when no goal is available", () => {
    const html = renderToStaticMarkup(
      <ThanksPage
        state={{ ...baseState, goal: null }}
        {...commonProps}
        notificationOptInEnabled
        onNotificationOptIn={vi.fn()}
      />,
    );

    expect(html).not.toContain("data-goal-notification-action");
    expect(html).not.toContain("Get Notified");
  });

  it("renders only the localized tiny subscription confirmation", () => {
    const html = renderToStaticMarkup(
      <ThanksPage
        state={tinyState}
        {...commonProps}
        onNotificationOptIn={vi.fn()}
      />,
    );

    expect(html).toContain("Joined r/ExampleSub");
    expect(html).not.toContain("View other subscriber goals in r/SubGoal");
    expect(html).not.toContain('alt="Subreddit icon"');
    expect(html).not.toContain("Thanks for Joining!");
    expect(html).not.toContain("subscribers in the community");
    expect(html).not.toContain("Return to Previous Page");
    expect(html).not.toContain("Get Notified");
    expect(html).not.toContain("data-goal-notification-action");
    expect(html).toContain("px-4 py-3");
  });

  it("renders the Punjabi tiny confirmation", () => {
    const html = renderToStaticMarkup(
      <ThanksPage
        state={{ ...tinyState, language: "pa" }}
        {...commonProps}
        onNotificationOptIn={vi.fn()}
      />,
    );

    expect(html).toContain("r/ExampleSub ਵਿੱਚ ਸ਼ਾਮਲ ਹੋ ਗਏ ਹੋ");
  });

  it("replaces the full-size after-subscribe CTA with notification opt-in", () => {
    const html = renderToStaticMarkup(
      <ThanksPage
        state={{
          ...baseState,
          afterSubscribeAction: {
            type: "link",
            buttonText: "Join the Discord",
            url: "https://discord.com/invite/example",
            colorTheme: "pink",
          },
        }}
        {...commonProps}
        notificationOptInEnabled
        onNotificationOptIn={vi.fn()}
      />,
    );

    expect(html).not.toContain("Join the Discord");
    expect(html).toContain("Get Notified at 10");
    expect(html).toContain('aria-label="Return to Previous Page"');
    expect(html).toContain(">Return</button>");
    expect(html).toContain('data-sg-theme="red"');
    expect(html).toContain("sg-subscribe-attention");
  });

  it.each(["regular", "short"] as const)(
    "restores the configured CTA on the %s Thanks page when notifications are disabled",
    (postHeight) => {
      const html = renderToStaticMarkup(
        <ThanksPage
          state={{
            ...baseState,
            postHeight,
            afterSubscribeAction: {
              type: "link",
              buttonText: "Join the Discord",
              url: "https://discord.com/invite/example",
              colorTheme: "pink",
            },
          }}
          {...commonProps}
          onNotificationOptIn={vi.fn()}
        />,
      );

      expect(html).toContain("Join the Discord");
      expect(html).toContain('data-sg-theme="pink"');
      expect(html).toContain(">Return</button>");
      expect(html).not.toContain("data-goal-notification-action");
      expect(html).not.toContain("Get Notified");
    },
  );

  it("shows only Return when notifications and the configured CTA are disabled", () => {
    const html = renderToStaticMarkup(
      <ThanksPage
        state={baseState}
        {...commonProps}
        onNotificationOptIn={vi.fn()}
      />,
    );

    expect(html).toContain(">Return</button>");
    expect(html).not.toContain("data-goal-notification-action");
    expect(html).not.toContain("data-after-subscribe-action");
  });

  it.each(["regular", "short"] as const)(
    "replaces every follow-up action with the moderator install promotion on %s posts",
    (postHeight) => {
      const onModeratorInstall = vi.fn();
      const html = renderToStaticMarkup(
        <ThanksPage
          state={{
            ...baseState,
            postHeight,
            moderatorInstallPromoEligible: true,
            afterSubscribeAction: {
              type: "link",
              buttonText: "Join the Discord",
              url: "https://discord.com/invite/example",
              colorTheme: "pink",
            },
          }}
          {...commonProps}
          notificationOptInEnabled
          onNotificationOptIn={vi.fn()}
          showModeratorInstallPromo
          onModeratorInstall={onModeratorInstall}
        />,
      );

      expect(html).toContain("Thanks for Joining!");
      expect(html).toContain('class="text-green-500">u/alice</span>,');
      expect(html).toContain("Hi ");
      expect(html).toContain("Add Subscriber Goal to your own subreddits now!");
      expect(html).toContain(
        '<span class="sm:hidden">Install SubGoal Now</span>',
      );
      expect(html).toContain("Install Subscriber Goal Now");
      expect(html).toContain('class="hidden sm:inline"');
      expect(html).toContain('data-moderator-install-promo-action="true"');
      expect(html).toContain('data-sg-theme="green"');
      expect(html).toContain(">Return</button>");
      expect(html).not.toContain("Join the Discord");
      expect(html).not.toContain("Get Notified");
      expect(html).not.toContain('alt="Subreddit icon"');
    },
  );

  it.each(["red", "blue", "green", "purple", "pink"] as const)(
    "keeps the moderator install action green on a %s post",
    (colorTheme) => {
      const html = renderToStaticMarkup(
        <ThanksPage
          state={{
            ...baseState,
            colorTheme,
            moderatorInstallPromoEligible: true,
          }}
          {...commonProps}
          showModeratorInstallPromo
          onModeratorInstall={vi.fn()}
        />,
      );

      expect(html).toContain('data-sg-theme="green"');
    },
  );

  it("keeps the generic promotion when the username is unavailable", () => {
    const html = renderToStaticMarkup(
      <ThanksPage
        state={{
          ...baseState,
          user: null,
          moderatorInstallPromoEligible: true,
        }}
        {...commonProps}
        showModeratorInstallPromo
        onModeratorInstall={vi.fn()}
      />,
    );

    expect(html).toContain("Add Subscriber Goal to your own subreddits now!");
    expect(html).not.toContain("u/undefined");
    expect(html).not.toContain("text-green-500");
  });

  it("replaces the Tiny confirmation with its valid CTA", () => {
    const html = renderToStaticMarkup(
      <ThanksPage
        state={{
          ...tinyState,
          afterSubscribeAction: {
            type: "link",
            buttonText: "Visit Website",
            url: "https://example.com/",
            colorTheme: "blue",
          },
        }}
        {...commonProps}
      />,
    );

    expect(html).toContain("Visit Website");
    expect(html).toContain("sg-subscribe-attention");
    expect(html).not.toContain("Joined r/ExampleSub");
    expect(html).not.toContain("Return to Previous Page");
  });
});
