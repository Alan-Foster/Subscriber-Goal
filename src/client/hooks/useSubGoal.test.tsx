// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prohibitedContentMessage } from "../../shared/contentPolicy";
import type { SubscribeOnlyState } from "../../shared/types/api";

const hoisted = vi.hoisted(() => ({
  connectRealtime: vi.fn(),
  requestJsonWithRetry: vi.fn(),
}));

vi.mock("@devvit/web/client", () => ({
  connectRealtime: hoisted.connectRealtime,
}));

vi.mock("../utils/fetchWithRetry", () => ({
  requestJsonWithRetry: hoisted.requestJsonWithRetry,
}));

import { useSubGoal } from "./useSubGoal";

const tinyState: SubscribeOnlyState = {
  colorTheme: "red",
  postHeight: "tiny",
  language: "en",
  afterSubscribeAction: { type: "disabled" },
  subscribed: false,
  authenticated: true,
  subreddit: { name: "ExampleSub", subscribers: 123 },
};

const Harness = () => {
  const { prohibited, state } = useSubGoal();
  return (
    <div>{prohibited ? "prohibited" : (state?.postHeight ?? "loading")}</div>
  );
};

describe("useSubGoal tiny behavior", () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    setIntervalSpy = vi.spyOn(window, "setInterval");
    setIntervalSpy.mockImplementation(() => 1);
    hoisted.requestJsonWithRetry.mockResolvedValue({
      data: { type: "init", postId: "t3_tiny", state: tinyState },
      error: null,
      aborted: false,
    });
    hoisted.connectRealtime.mockResolvedValue({ disconnect: vi.fn() });
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
  });

  it("does not connect realtime or start refresh polling after tiny initialization", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    expect(container.textContent).toBe("tiny");
    expect(hoisted.connectRealtime).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();

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
});
