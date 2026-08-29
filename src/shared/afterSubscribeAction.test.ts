import { describe, expect, it } from "vitest";
import {
  createTopPostFallbackAction,
  resolveAfterSubscribeAction,
} from "./afterSubscribeAction";

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
