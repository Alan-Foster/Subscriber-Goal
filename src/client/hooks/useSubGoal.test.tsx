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

import {
  reconcileSubscriptionStatus,
  requestSubscribeJson,
  useSubGoal,
} from "./useSubGoal";

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

const attemptId = "123e4567-e89b-42d3-a456-426614174000";

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
      { validate: expect.any(Function) },
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("failed to call devvit application: rpc unavailable", {
          status: 503,
          headers: { "content-type": "text/plain" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: "refresh",
            postId: "t3_tiny",
            state: { ...tinyState, subscribed: true },
            subscriptionAttemptConfirmed: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    hoisted.requestJsonWithRetry.mockResolvedValueOnce({
      data: { type: "init", postId: "t3_tiny", state: tinyState },
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/subscribe",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/refresh\?attemptId=/),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);

    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("keeps prior state and permits another attempt after reconciliation times out", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<html>gateway error</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      )
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              type: "refresh",
              postId: "t3_tiny",
              state: tinyState,
              subscriptionAttemptConfirmed: false,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
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

    expect(container.querySelector("button")?.disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });

    expect(container.textContent).toBe("unsubscribed:Subscription failed.");
    expect(container.querySelector("button")?.disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(11);
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);

    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("cancels scheduled reconciliation polls when unmounted", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("failed to call devvit application: unavailable", {
          status: 503,
        }),
      )
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              type: "refresh",
              postId: "t3_tiny",
              state: tinyState,
              subscriptionAttemptConfirmed: false,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
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
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([400, 401])(
    "surfaces a definite %s API error without reconciliation",
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ status: "error", message: "Cannot subscribe." }),
            { status, headers: { "content-type": "application/json" } },
          ),
        );
      vi.stubGlobal("fetch", fetchMock);
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

      expect(container.textContent).toBe("unsubscribed:Cannot subscribe.");
      expect(fetchMock).toHaveBeenCalledOnce();
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  );

  it("reconciles a malformed successful subscribe payload", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: "refresh",
            postId: "t3_tiny",
            state: { ...tinyState, subscribed: true },
            subscriptionAttemptConfirmed: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
});

describe("reconcileSubscriptionStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("polls every second through five seconds and stops when confirmed", async () => {
    const attemptTimes: number[] = [];
    const fetchMock = vi.fn().mockImplementation(() => {
      attemptTimes.push(Date.now());
      const subscribed = attemptTimes.length === 6;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: "refresh",
            postId: "t3_tiny",
            state: { ...tinyState, subscribed },
            subscriptionAttemptConfirmed: subscribed,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const reconciliation = reconcileSubscriptionStatus(attemptId);
    await vi.advanceTimersByTimeAsync(5000);

    await expect(reconciliation).resolves.toMatchObject({
      outcome: "confirmed",
      state: { subscribed: true },
    });
    expect(attemptTimes).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
  });

  it("backs off to five seconds after the initial window", async () => {
    const attemptTimes: number[] = [];
    const fetchMock = vi.fn().mockImplementation(() => {
      attemptTimes.push(Date.now());
      const subscribed = attemptTimes.length === 8;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: "refresh",
            postId: "t3_tiny",
            state: { ...tinyState, subscribed },
            subscriptionAttemptConfirmed: subscribed,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const reconciliation = reconcileSubscriptionStatus(attemptId);
    await vi.advanceTimersByTimeAsync(15000);

    await expect(reconciliation).resolves.toMatchObject({
      outcome: "confirmed",
    });
    expect(attemptTimes).toEqual([
      0, 1000, 2000, 3000, 4000, 5000, 10000, 15000,
    ]);
  });

  it("continues through transient and unconfirmed results until timeout", async () => {
    const attemptTimes: number[] = [];
    const fetchMock = vi.fn().mockImplementation(() => {
      attemptTimes.push(Date.now());
      if (attemptTimes.length === 1) {
        return Promise.reject(new TypeError("network unavailable"));
      }
      if (attemptTimes.length === 2) {
        return Promise.resolve(
          new Response("<html>bad gateway</html>", { status: 502 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: "refresh",
            postId: "t3_tiny",
            state: tinyState,
            subscriptionAttemptConfirmed: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const reconciliation = reconcileSubscriptionStatus(attemptId);
    await vi.advanceTimersByTimeAsync(30000);

    await expect(reconciliation).resolves.toEqual({
      outcome: "timeout",
      state: null,
    });
    expect(attemptTimes).toEqual([
      0, 1000, 2000, 3000, 4000, 5000, 10000, 15000, 20000, 25000,
    ]);
  });

  it("cancels pending polling when externally aborted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          type: "refresh",
          postId: "t3_tiny",
          state: tinyState,
          subscriptionAttemptConfirmed: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const reconciliation = reconcileSubscriptionStatus(
      attemptId,
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await vi.runAllTimersAsync();

    await expect(reconciliation).resolves.toEqual({
      outcome: "aborted",
      state: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips missed checkpoints after suspension without a request burst", async () => {
    let resolveFirstRequest: ((response: Response) => void) | undefined;
    const attemptTimes: number[] = [];
    const fetchMock = vi.fn().mockImplementation(() => {
      attemptTimes.push(Date.now());
      if (attemptTimes.length === 1) {
        return new Promise<Response>((resolve) => {
          resolveFirstRequest = resolve;
        });
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: "refresh",
            postId: "t3_tiny",
            state: tinyState,
            subscriptionAttemptConfirmed: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const reconciliation = reconcileSubscriptionStatus(attemptId);
    await Promise.resolve();
    vi.setSystemTime(20_000);
    resolveFirstRequest?.(
      new Response(
        JSON.stringify({
          type: "refresh",
          postId: "t3_tiny",
          state: tinyState,
          subscriptionAttemptConfirmed: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(attemptTimes).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(attemptTimes).toEqual([0, 25_000]);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(reconciliation).resolves.toMatchObject({ outcome: "timeout" });
  });

  it("does not start another request once wall-clock time reaches the deadline", async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const reconciliation = reconcileSubscriptionStatus(attemptId);
    await Promise.resolve();
    vi.setSystemTime(30_000);
    resolveRequest?.(
      new Response(
        JSON.stringify({
          type: "refresh",
          postId: "t3_tiny",
          state: tinyState,
          subscriptionAttemptConfirmed: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(reconciliation).resolves.toEqual({
      outcome: "timeout",
      state: null,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not confirm from historical subscribed state alone", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: "refresh",
            postId: "t3_tiny",
            state: { ...tinyState, subscribed: true },
            subscriptionAttemptConfirmed: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const reconciliation = reconcileSubscriptionStatus(attemptId);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(reconciliation).resolves.toMatchObject({ outcome: "timeout" });
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
      status: 200,
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
      status: 401,
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
        status: 503,
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
      status: null,
    });
  });
});
