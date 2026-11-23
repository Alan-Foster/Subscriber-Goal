import { describe, expect, it } from "vitest";
import {
  createDefaultAfterSubscribeAction,
  getAutomaticAfterSubscribeAction,
  createTopPostFallbackAction,
  defaultAfterSubscribeColorTheme,
  getDefaultAfterSubscribePreset,
  getEffectiveAfterSubscribeActions,
  resolveAfterSubscribeAction,
  resolveAfterSubscribePreset,
  type AfterSubscribeAction,
} from "./afterSubscribeAction";

describe("after-subscribe defaults", () => {
  it.each([
    "https://www.reddit.com/r/ExampleSub/submit",
    "https://www.reddit.com/r/ExampleSub/submit/",
  ])("recovers Create Post from the legacy link %s", (url) => {
    expect(
      resolveAfterSubscribePreset(undefined, {
        type: "link",
        buttonText: "Create a New Post",
        url,
        colorTheme: "blue",
      }),
    ).toBe("create-post");
  });

  it("recovers a generic web link from a legacy wiki action", () => {
    expect(
      resolveAfterSubscribePreset(undefined, {
        type: "link",
        buttonText: "Read the Wiki",
        url: "https://www.reddit.com/r/ExampleSub/wiki/index/",
        colorTheme: "blue",
      }),
    ).toBe("web-link");
  });

  it("preserves a saved preset before trying to infer one from the action", () => {
    expect(
      resolveAfterSubscribePreset("discord", {
        type: "link",
        buttonText: "Join the Discord",
        url: "https://discord.com/invite/example",
        colorTheme: "blue",
      }),
    ).toBe("discord");
  });

  it.each(["top-post-day", "newest-post"] as const)(
    "recovers the legacy dynamic preset %s",
    (type) => {
      expect(
        resolveAfterSubscribePreset(undefined, {
          type,
          buttonText: "Read a post",
          colorTheme: "blue",
        }),
      ).toBe(type);
    },
  );

  it("does not infer a preset for disabled or unrecognized legacy actions", () => {
    expect(
      resolveAfterSubscribePreset(undefined, { type: "disabled" }),
    ).toBeNull();
    const unknownAction: unknown = { type: "legacy-unknown" };
    expect(
      resolveAfterSubscribePreset(
        undefined,
        unknownAction as AfterSubscribeAction,
      ),
    ).toBeNull();
  });

  it.each(["/x/r/a/submit", "/r/a/submit/extra"])(
    "does not infer Create Post from the partial path %s",
    (path) => {
      expect(
        resolveAfterSubscribePreset(undefined, {
          type: "link",
          buttonText: "Open the link",
          url: `https://www.reddit.com${path}`,
          colorTheme: "blue",
        }),
      ).toBe("web-link");
    },
  );

  it("trims a URL before parsing and rejects objects with a trim method", () => {
    const link = {
      type: "link",
      buttonText: "Read the Wiki",
      colorTheme: "blue",
      fallbackColorTheme: "red",
    } as const;
    expect(
      resolveAfterSubscribeAction({
        ...link,
        url: "\u00a0https://example.com/wiki\u00a0",
      }),
    ).toEqual({
      action: {
        type: "link",
        buttonText: "Read the Wiki",
        colorTheme: "blue",
        url: "https://example.com/wiki",
      },
      invalidConfiguration: false,
    });
    expect(
      resolveAfterSubscribeAction({
        ...link,
        url: { trim: () => "https://example.com/wiki" },
      }),
    ).toEqual({
      action: { type: "disabled" },
      invalidConfiguration: true,
    });
  });

  it.each([
    ["public", "top-post-day"],
    ["private", "top-post-day"],
    ["restricted", "top-post-day"],
  ] as const)(
    "selects the default preset for a %s subreddit",
    (subredditType, preset) => {
      expect(getDefaultAfterSubscribePreset(subredditType)).toBe(preset);
    },
  );

  it.each(["public", "private", "restricted"])(
    "builds the %s-subreddit top-post action in blue",
    (subredditType) => {
      expect(
        createDefaultAfterSubscribeAction({
          language: "en",
          subredditName: "ExampleSub",
          subredditType,
        }),
      ).toEqual({
        type: "top-post-day",
        buttonText: "View the Top Post Today",
        colorTheme: defaultAfterSubscribeColorTheme,
      });
    },
  );
});

describe("resolveAfterSubscribeAction", () => {
  it("keeps the existing disabled behavior", () => {
    expect(
      resolveAfterSubscribeAction({
        type: "disabled",
        buttonText: "ignored",
        url: "https://example.com",
        colorTheme: "pink",
        fallbackColorTheme: "red",
      }),
    ).toEqual({
      action: { type: "disabled" },
      invalidConfiguration: false,
    });
  });

  it.each(["12345", "x".repeat(50)])(
    "accepts boundary-length link text (%s)",
    (buttonText) => {
      expect(
        resolveAfterSubscribeAction({
          type: "link",
          buttonText: ` ${buttonText} `,
          url: "https://example.com/community?q=1",
          colorTheme: "pink",
          fallbackColorTheme: "red",
        }),
      ).toEqual({
        action: {
          type: "link",
          buttonText,
          url: "https://example.com/community?q=1",
          colorTheme: "pink",
        },
        invalidConfiguration: false,
      });
    },
  );

  it.each([
    ["1234", "https://example.com"],
    ["x".repeat(51), "https://example.com"],
    ["Join us", "http://example.com"],
    ["Join us", "not a URL"],
  ])(
    "uses the supplied fallback for invalid link configuration",
    (buttonText, url) => {
      expect(
        resolveAfterSubscribeAction({
          type: "link",
          buttonText,
          url,
          colorTheme: "pink",
          fallbackColorTheme: "red",
          invalidConfigurationFallback: createTopPostFallbackAction({
            language: "en",
            colorTheme: "pink",
          }),
        }),
      ).toEqual({
        action: {
          type: "top-post-day",
          buttonText: "View the Top Post Today",
          colorTheme: "pink",
        },
        invalidConfiguration: true,
      });
    },
  );

  it("falls back to the primary color without disabling a valid link", () => {
    expect(
      resolveAfterSubscribeAction({
        type: "link",
        buttonText: "Join Discord",
        url: "https://discord.com/invite/example",
        colorTheme: "orange",
        fallbackColorTheme: "blue",
      }).action,
    ).toEqual({
      type: "link",
      buttonText: "Join Discord",
      url: "https://discord.com/invite/example",
      colorTheme: "blue",
    });
  });

  it.each(["top-post-day", "newest-post"] as const)(
    "accepts the %s dynamic action without a URL",
    (type) => {
      expect(
        resolveAfterSubscribeAction({
          type,
          buttonText: "View a Post",
          url: undefined,
          colorTheme: "pink",
          fallbackColorTheme: "red",
        }),
      ).toEqual({
        action: {
          type,
          buttonText: "View a Post",
          colorTheme: "pink",
        },
        invalidConfiguration: false,
      });
    },
  );

  it("uses the supplied fallback for a dynamic action with invalid button text", () => {
    expect(
      resolveAfterSubscribeAction({
        type: "top-post-day",
        buttonText: "No",
        url: undefined,
        colorTheme: "blue",
        fallbackColorTheme: "red",
        invalidConfigurationFallback: createTopPostFallbackAction({
          language: "es",
          colorTheme: "blue",
        }),
      }),
    ).toEqual({
      action: {
        type: "top-post-day",
        buttonText: "Ver la publicación destacada de hoy",
        colorTheme: "blue",
      },
      invalidConfiguration: true,
    });
  });
});

describe("automatic post-Join pairing", () => {
  it.each([
    ["top-post-day", "blue", "newest-post", "green"],
    ["top-post-day", "green", "newest-post", "blue"],
    ["top-post-day", "pink", "newest-post", "green"],
    ["newest-post", "green", "top-post-day", "blue"],
    ["newest-post", "blue", "top-post-day", "green"],
    ["link", "pink", "top-post-day", "blue"],
  ] as const)(
    "pairs configured %s/%s with %s/%s without changing its customization",
    (type, colorTheme, automaticType, automaticColor) => {
      const configured = {
        type,
        colorTheme,
        buttonText: "My custom label",
        ...(type === "link" ? { url: "https://example.com/" } : {}),
      } as Parameters<typeof getAutomaticAfterSubscribeAction>[0];
      const before = { ...configured };
      expect(getAutomaticAfterSubscribeAction(configured, "en")).toEqual({
        type: automaticType,
        colorTheme: automaticColor,
        buttonText:
          automaticType === "top-post-day"
            ? "View the Top Post Today"
            : "View the Most Recent Post",
      });
      expect(configured).toEqual(before);
    },
  );
  it("uses localized labels and adds nothing to a disabled CTA", () => {
    expect(
      getAutomaticAfterSubscribeAction({ type: "disabled" }, "en"),
    ).toBeNull();
    expect(
      getAutomaticAfterSubscribeAction(
        { type: "top-post-day", buttonText: "Custom", colorTheme: "blue" },
        "es",
      )?.buttonText,
    ).toBe("Ver la publicación más reciente");
  });
});

describe("effective actions in NSFW communities", () => {
  const context = {
    language: "en",
    subredditName: "ExampleSub",
    isNsfw: true,
  } as const;

  it.each([
    ["top-post-day", "green", "newest-post", "blue"],
    ["top-post-day", "pink", "newest-post", "green"],
    ["newest-post", "blue", "link", "green"],
    ["newest-post", "pink", "link", "blue"],
  ] as const)(
    "gives a %s CTA in %s a %s secondary action in %s",
    (type, colorTheme, secondaryType, secondaryColor) => {
      const configured = { type, colorTheme, buttonText: "My post action" };
      expect(
        getEffectiveAfterSubscribeActions(configured, context).secondary,
      ).toMatchObject({
        type: secondaryType,
        colorTheme: secondaryColor,
      });
    },
  );

  it("pairs Most Recent with Create Post using the actual subreddit name", () => {
    const configured = {
      type: "newest-post",
      buttonText: "My Latest Post",
      colorTheme: "green",
    } as const;
    expect(getEffectiveAfterSubscribeActions(configured, context)).toEqual({
      primary: configured,
      secondary: {
        type: "link",
        buttonText: "Create a New Post",
        colorTheme: "blue",
        url: "https://www.reddit.com/r/ExampleSub/submit/",
      },
    });
  });

  it.each([
    ["https://example.com/custom", "link"],
    ["https://www.reddit.com/r/ExampleSub/submit/", "newest-post"],
  ])(
    "preserves a configured link and does not duplicate it (%s)",
    (url, secondaryType) => {
      const configured = {
        type: "link",
        buttonText: "My community link",
        colorTheme: "pink",
        url,
      } as const;
      expect(
        getEffectiveAfterSubscribeActions(configured, context),
      ).toMatchObject({
        primary: configured,
        secondary: { type: secondaryType },
      });
    },
  );

  it("honors an explicitly disabled action", () => {
    expect(
      getEffectiveAfterSubscribeActions({ type: "disabled" }, context),
    ).toEqual({
      primary: { type: "disabled" },
      secondary: null,
    });
  });
});
