import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubscribeOnlyState } from "../../shared/types/api";

const hoisted = vi.hoisted(() => ({
  state: null as SubscribeOnlyState | null,
  subscribe: vi.fn(),
  setError: vi.fn(),
}));

vi.mock("@devvit/web/client", () => ({ showToast: vi.fn() }));
vi.mock("../hooks/useSubGoal", () => ({
  useSubGoal: () => ({
    state: hoisted.state,
    loading: false,
    submitting: false,
    setError: hoisted.setError,
    subscribe: hoisted.subscribe,
  }),
}));

import { SubscribeOnlyApp } from "./SubscribeOnlyApp";

describe("SubscribeOnlyApp", () => {
  beforeEach(() => {
    hoisted.state = {
      postHeight: "tiny",
      colorTheme: "purple",
      language: "en",
      subscribed: true,
      authenticated: true,
      subreddit: { name: "ExampleSub" },
    };
  });

  it("renders only the persisted subscribed message on initial load", () => {
    const html = renderToStaticMarkup(<SubscribeOnlyApp />);

    expect(html).toContain("Subscribed to r/ExampleSub");
    expect(html).not.toContain("Subscribe to r/ExampleSub");
    expect(html).not.toContain("button");
    expect(html).not.toContain("progress");
  });
});
