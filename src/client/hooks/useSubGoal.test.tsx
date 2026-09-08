// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prohibitedContentMessage } from "../../shared/contentPolicy";
import type { SubscribeOnlyState } from "../../shared/types/api";

const hoisted = vi.hoisted(() => ({
  connectRealtime: vi.fn(),
  requestJsonWithRetry: vi.fn(),
  journeyHeaders: vi.fn(() => ({})),
}));

vi.mock("@devvit/web/client", () => ({
  connectRealtime: hoisted.connectRealtime,
}));

vi.mock("../utils/fetchWithRetry", () => ({
  requestJsonWithRetry: hoisted.requestJsonWithRetry,
}));

vi.mock("../analytics/goalJourneyAnalytics", () => ({
  goalJourneyAnalytics: {
    journeyHeaders: hoisted.journeyHeaders,
  },
}));

import { requestSubscribeJson, useSubGoal } from "./useSubGoal";

const tinyState: SubscribeOnlyState = {
  colorTheme: "red",
  postHeight: "tiny",
  promoSubreddit: "SubGoal",
  language: "en",
  afterSubscribeAction: { type: "disabled" },
  subscribed: false,
  authenticated: true,
  subreddit: {
    name: "ExampleSub",
    subscribers: 123,
    growth: { count: 4, period: "today" },
  },
};

const Harness = () => {
  const { prohibited, state } = useSubGoal();
  return (
    <div>{prohibited ? "prohibited" : (state?.postHeight ?? "loading")}</div>
  );
};

const SubscribeHarness = () => {
  const { state, subscribe, submitting } = useSubGoal();
  const [result, setResult] = useState("idle");
  return (
    <button
      disabled={submitting}
      onClick={() => {
        void subscribe().then((value) => {
          setResult(value.error ?? (value.state ? "success" : "missing"));
        });
      }}
    >
      {state && "subscribed" in state && state.subscribed
        ? `subscribed:${result}`
        : `unsubscribed:${result}`}
    </button>
  );
};

describe("useSubGoal tiny behavior", () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;
  let clearIntervalSpy: ReturnType<typeof vi.spyOn>;
  let intervalCallback: (() => void) | undefined;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    setIntervalSpy = vi.spyOn(window, "setInterval");
    setIntervalSpy.mockImplementation((callback: TimerHandler) => {
      intervalCallback = callback as () => void;
      return 1;
    });
    clearIntervalSpy = vi.spyOn(window, "clearInterval");
    hoisted.requestJsonWithRetry.mockResolvedValue({
      data: { type: "init", postId: "t3_tiny", state: tinyState },
      error: null,
      aborted: false,
    });
    hoisted.connectRealtime.mockResolvedValue({ disconnect: vi.fn() });
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it("polls Tiny aggregate state every minute without connecting realtime", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    expect(container.textContent).toBe("tiny");
    expect(hoisted.connectRealtime).not.toHaveBeenCalled();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60000);

    hoisted.requestJsonWithRetry.mockResolvedValueOnce({
      data: {
        type: "refresh",
        postId: "t3_tiny",
        state: {
          ...tinyState,
          subreddit: {
            ...tinyState.subreddit,
            subscribers: 130,
            growth: { count: 11, period: "today" },
          },
        },
      },
      error: null,
      aborted: false,
    });
    await act(async () => {
      intervalCallback?.();
      await Promise.resolve();
    });
    expect(hoisted.requestJsonWithRetry).toHaveBeenLastCalledWith(
      "/api/refresh",
      undefined,
      {},
    );

    await act(async () => root.unmount());
    expect(clearIntervalSpy).toHaveBeenCalledWith(1);
    container.remove();
  });

  it("keeps polling after a transient Tiny refresh failure", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    hoisted.requestJsonWithRetry.mockResolvedValueOnce({
      data: null,
      error: "temporarily unavailable",
      aborted: false,
    });

    await act(async () => {
      intervalCallback?.();
      await Promise.resolve();
    });

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    container.remove();
  });

  it("marks a prohibited initialization as terminal without scheduling recovery", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    hoisted.requestJsonWithRetry.mockResolvedValue({
      data: null,
      error: prohibitedContentMessage,
      aborted: false,
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    expect(container.textContent).toBe("prohibited");
    expect(hoisted.requestJsonWithRetry).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 5000);

    await act(async () => root.unmount());
    container.remove();
    setTimeoutSpy.mockRestore();
  });

  it("reconciles a non-JSON subscribe failure as success without retrying POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("failed to call devvit application: rpc unavailable", {
        status: 503,
        headers: { "content-type": "text/plain" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    hoisted.requestJsonWithRetry
      .mockResolvedValueOnce({
        data: { type: "init", postId: "t3_tiny", state: tinyState },
        error: null,
        aborted: false,
      })
      .mockResolvedValueOnce({
        data: {
          type: "refresh",
          postId: "t3_tiny",
          state: { ...tinyState, subscribed: true },
        },
        error: null,
        aborted: false,
      });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<SubscribeHarness />);
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector("button")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toBe("subscribed:success");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/subscribe",
      expect.objectContaining({ method: "POST" }),
    );
    expect(hoisted.requestJsonWithRetry).toHaveBeenLastCalledWith(
      "/api/refresh",
      undefined,
      {},
    );

    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("keeps prior state and permits another attempt when reconciliation is negative", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html>gateway error</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    hoisted.requestJsonWithRetry
      .mockResolvedValueOnce({
        data: { type: "init", postId: "t3_tiny", state: tinyState },
        error: null,
        aborted: false,
      })
      .mockResolvedValue({
        data: { type: "refresh", postId: "t3_tiny", state: tinyState },
        error: null,
        aborted: false,
      });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<SubscribeHarness />);
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector("button")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toBe("unsubscribed:Subscription failed.");
    expect(container.querySelector("button")?.disabled).toBe(false);
    await act(async () => {
      container.querySelector("button")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
});

describe("requestSubscribeJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses successful JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      requestSubscribeJson<{ ok: boolean }>("/api/subscribe"),
    ).resolves.toEqual({
      data: { ok: true },
      error: null,
      errorKind: null,
    });
  });

  it("extracts a valid JSON API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ status: "error", message: "Please log in." }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await expect(requestSubscribeJson("/api/subscribe")).resolves.toEqual({
      data: null,
      error: "Please log in.",
      errorKind: "api",
    });
  });

  it.each([
    ["gateway", "failed to call devvit application: rpc unavailable"],
    ["protocol", "<html>bad gateway</html>"],
    ["protocol", ""],
    ["protocol", "{malformed"],
  ] as const)(
    "classifies %s non-JSON responses without exposing their bodies",
    async (kind, body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(body, {
            status: 503,
            headers: { "content-type": "text/plain" },
          }),
        ),
      );

      const result = await requestSubscribeJson("/api/subscribe");
      expect(result).toEqual({
        data: null,
        error: "Subscription request could not be completed.",
        errorKind: kind,
      });
      expect(result.error).not.toMatch(
        /Unexpected token|rpc unavailable|bad gateway|malformed/,
      );
    },
  );

  it.each([
    new TypeError("fetch failed"),
    new DOMException("Timed out", "AbortError"),
  ])("returns a safe network error for %s", async (error) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));

    await expect(requestSubscribeJson("/api/subscribe")).resolves.toEqual({
      data: null,
      error: "Subscription request could not be completed.",
      errorKind: "network",
    });
  });
});
