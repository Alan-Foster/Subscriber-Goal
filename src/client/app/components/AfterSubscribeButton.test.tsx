// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AfterSubscribeAction } from "../../../shared/afterSubscribeAction";
import { apiRoutes } from "../../../shared/routes";

const hoisted = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock("@devvit/web/client", () => ({ showToast: hoisted.showToast }));

import { AfterSubscribeButton } from "./AfterSubscribeButton";

type ActionableAction = Exclude<AfterSubscribeAction, { type: "disabled" }>;

describe("AfterSubscribeButton", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onNavigate = vi.fn();

  const renderButton = async (
    action: ActionableAction,
    language: "en" | "es" = "en",
  ) => {
    await act(async () => {
      root.render(
        <AfterSubscribeButton
          action={action}
          language={language}
          onNavigate={onNavigate}
        />,
      );
    });
  };

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("navigates persisted HTTPS links without calling the dynamic endpoint", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await renderButton({
      type: "link",
      buttonText: "Read the Wiki",
      url: "https://www.reddit.com/r/ExampleSub/wiki/index/",
      colorTheme: "pink",
    });

    await act(async () => {
      container
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onNavigate).toHaveBeenCalledWith(
      "https://www.reddit.com/r/ExampleSub/wiki/index/",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a dynamic target once, disables while loading, and navigates to it", async () => {
    let resolveFetch!: (response: unknown) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await renderButton({
      type: "top-post-day",
      buttonText: "View the Top Post Today",
      colorTheme: "blue",
    });

    await act(async () => {
      const button = container.querySelector("button");
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(apiRoutes.afterSubscribeTarget);
    expect(container.querySelector("button")?.disabled).toBe(true);
    expect(
      container.querySelector('[data-subscription-button-mode="submitting"]'),
    ).not.toBeNull();

    await act(async () => {
      resolveFetch({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          target: {
            url: "https://www.reddit.com/r/ExampleSub/comments/top",
            permalink: "/r/ExampleSub/comments/top",
          },
        }),
      });
    });

    expect(onNavigate).toHaveBeenCalledWith({
      url: "https://www.reddit.com/r/ExampleSub/comments/top",
      permalink: "/r/ExampleSub/comments/top",
    });
    expect(container.querySelector("button")?.disabled).toBe(false);
    expect(
      container.querySelector('[data-subscription-button-mode="link"]'),
    ).not.toBeNull();
  });

  it("shows the localized unavailable message for an empty listing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: vi.fn().mockResolvedValue({
          status: "error",
          message: "No post is currently available.",
        }),
      }),
    );
    await renderButton(
      {
        type: "newest-post",
        buttonText: "Ver la publicación más reciente",
        colorTheme: "red",
      },
      "es",
    );

    await act(async () => {
      container
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(hoisted.showToast).toHaveBeenCalledWith(
      "No hay ninguna publicación disponible.",
    );
    expect(onNavigate).not.toHaveBeenCalled();
    expect(container.querySelector("button")?.disabled).toBe(false);
  });

  it("shows a localized error and restores the button after a request failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await renderButton({
      type: "newest-post",
      buttonText: "View the Most Recent Post Today",
      colorTheme: "green",
    });

    await act(async () => {
      container
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(hoisted.showToast).toHaveBeenCalledWith(
      "The post could not be opened right now.",
    );
    expect(onNavigate).not.toHaveBeenCalled();
    expect(container.querySelector("button")?.disabled).toBe(false);
  });

  it("does not navigate when a successful response has a malformed target", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ target: { url: "not a URL" } }),
      }),
    );
    await renderButton({
      type: "top-post-day",
      buttonText: "View the Top Post Today",
      colorTheme: "blue",
    });

    await act(async () => {
      container
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(hoisted.showToast).toHaveBeenCalledWith(
      "The post could not be opened right now.",
    );
    expect(onNavigate).not.toHaveBeenCalled();
    expect(container.querySelector("button")?.disabled).toBe(false);
  });
});
