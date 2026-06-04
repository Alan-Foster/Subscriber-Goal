import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  reddit: {
    submitCustomPost: vi.fn(),
  },
}));

vi.mock("@devvit/web/server", () => ({
  reddit: hoisted.reddit,
}));

import { createGoalPost } from "./post";

describe("createGoalPost", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.reddit.submitCustomPost.mockResolvedValue({ id: "t3_newpost" });
  });

  it("submits custom posts as the app by default", async () => {
    await createGoalPost({
      title: "Welcome!",
      subredditName: "ExampleSub",
    });

    expect(hoisted.reddit.submitCustomPost).toHaveBeenCalledWith({
      title: "Welcome!",
      subredditName: "ExampleSub",
    });
  });

  it("uses runAs USER with required user generated content when submitAsUser is true", async () => {
    await createGoalPost({
      title: "Welcome!",
      subredditName: "ExampleSub",
      submitAsUser: true,
    });

    expect(hoisted.reddit.submitCustomPost).toHaveBeenCalledWith({
      title: "Welcome!",
      subredditName: "ExampleSub",
      runAs: "USER",
      userGeneratedContent: {
        text: "Subscriber Goal post: Welcome!",
      },
    });
  });
});
