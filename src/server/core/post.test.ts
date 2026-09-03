import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  reddit: {
    submitCustomPost: vi.fn(),
  },
}));

vi.mock("@devvit/web/server", () => ({
  EntrypointHeight: {
    HEIGHT_UNSPECIFIED: 0,
    REGULAR: 1,
  },
  reddit: hoisted.reddit,
}));

import { EntrypointHeight } from "@devvit/web/server";
import { applyGoalPostFrameStyle, createGoalPost } from "./post";

describe("createGoalPost", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.reddit.submitCustomPost.mockResolvedValue({ id: "t3_newpost" });
  });

  it("submits custom posts as the app by default", async () => {
    await createGoalPost({
      title: "Welcome!",
      subredditName: "ExampleSub",
      textFallback: "Fallback text",
    });

    expect(hoisted.reddit.submitCustomPost).toHaveBeenCalledWith({
      title: "Welcome!",
      subredditName: "ExampleSub",
      entry: "default",
      postData: { postKind: "subscriber-goal-v1" },
      styles: { height: EntrypointHeight.REGULAR },
      textFallback: { text: "Fallback text" },
    });
  });

  it("forwards the Subscriber Goal flair during submission", async () => {
    await createGoalPost({
      title: "Welcome!",
      subredditName: "ExampleSub",
      textFallback: "Fallback text",
      flairId: "flair_subgoal",
    });

    expect(hoisted.reddit.submitCustomPost).toHaveBeenCalledWith(
      expect.objectContaining({ flairId: "flair_subgoal" }),
    );
  });

  it("uses runAs USER with required user generated content when submitAsUser is true", async () => {
    await createGoalPost({
      title: "Welcome!",
      subredditName: "ExampleSub",
      textFallback: "Fallback text",
      submitAsUser: true,
    });

    expect(hoisted.reddit.submitCustomPost).toHaveBeenCalledWith({
      title: "Welcome!",
      subredditName: "ExampleSub",
      entry: "default",
      postData: { postKind: "subscriber-goal-v1" },
      styles: { height: EntrypointHeight.REGULAR },
      textFallback: { text: "Fallback text" },
      runAs: "USER",
      userGeneratedContent: {
        text: "Subscriber Goal post: Welcome!",
      },
    });
  });

  it("submits short posts with regular height before post-creation style repair", async () => {
    await createGoalPost({
      title: "Welcome!",
      subredditName: "ExampleSub",
      textFallback: "Fallback text",
      postHeight: "short",
    });

    expect(hoisted.reddit.submitCustomPost).toHaveBeenCalledWith({
      title: "Welcome!",
      subredditName: "ExampleSub",
      entry: "default",
      postData: { postKind: "subscriber-goal-v1" },
      styles: { height: EntrypointHeight.REGULAR },
      textFallback: { text: "Fallback text" },
    });
  });

  it("submits Tiny posts through the dedicated subscribe-only entrypoint", async () => {
    await createGoalPost({
      title: "Subscribe",
      subredditName: "ExampleSub",
      textFallback: "Subscribe to r/ExampleSub",
      postHeight: "tiny",
    });

    expect(hoisted.reddit.submitCustomPost).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: "subscribe-only",
        postData: { postKind: "subscribe-only-v1" },
        styles: { height: 0, heightPixels: 100 },
      }),
    );
  });

  it("applies heightPixels through post-creation styles for short posts", async () => {
    const post = {
      id: "t3_newpost",
      setCustomPostStyles: vi.fn(),
    };

    await applyGoalPostFrameStyle(post, "short");

    expect(post.setCustomPostStyles).toHaveBeenCalledWith({
      height: EntrypointHeight.HEIGHT_UNSPECIFIED,
      heightPixels: 234,
    });
  });

  it("applies heightPixels through post-creation styles for tiny posts", async () => {
    const post = {
      id: "t3_newpost",
      setCustomPostStyles: vi.fn(),
    };

    await applyGoalPostFrameStyle(post, "tiny");

    expect(post.setCustomPostStyles).toHaveBeenCalledWith({
      height: EntrypointHeight.HEIGHT_UNSPECIFIED,
      heightPixels: 100,
    });
  });

  it("does not apply post-creation styles for regular posts", async () => {
    const post = {
      id: "t3_newpost",
      setCustomPostStyles: vi.fn(),
    };

    await applyGoalPostFrameStyle(post, "regular");

    expect(post.setCustomPostStyles).not.toHaveBeenCalled();
  });

  it("logs and continues when short post style application fails", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const post = {
      id: "t3_newpost",
      setCustomPostStyles: vi.fn(async () => {
        throw new Error("style denied");
      }),
    };

    await expect(
      applyGoalPostFrameStyle(post, "short"),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      "[postHeight] failed to apply short post height: postId=t3_newpost error=Error: style denied",
    );
  });
});
