import { describe, expect, it, vi } from "vitest";
import {
  backfillSubscriberGoalPostFlair,
  ensureSubscriberGoalPostFlair,
} from "./subscriberGoalPostFlair";

describe("Subscriber Goal post flair", () => {
  it("creates the canonical mod-only flair when absent", async () => {
    const created = { id: "flair_1" };
    const reddit = {
      getPostFlairTemplates: vi.fn(async () => []),
      createPostFlairTemplate: vi.fn(async () => created),
    };

    await expect(
      ensureSubscriberGoalPostFlair(reddit as never, "ExampleSub"),
    ).resolves.toBe(created);
    expect(reddit.createPostFlairTemplate).toHaveBeenCalledWith({
      subredditName: "ExampleSub",
      text: "Subscriber Goal",
      modOnly: true,
      allowUserEdits: false,
      allowableContent: "text",
      backgroundColor: "#FF4500",
      textColor: "light",
    });
  });

  it("reuses and normalizes an exact-name template", async () => {
    const normalized = { id: "flair_existing" };
    const template = {
      id: "flair_existing",
      text: "Subscriber Goal",
      modOnly: false,
      allowUserEdits: true,
      allowableContent: "all",
      backgroundColor: "transparent",
      textColor: "dark",
      edit: vi.fn(async () => normalized),
    };
    const reddit = {
      getPostFlairTemplates: vi.fn(async () => [template]),
      createPostFlairTemplate: vi.fn(),
    };

    await expect(
      ensureSubscriberGoalPostFlair(reddit as never, "ExampleSub"),
    ).resolves.toBe(normalized);
    expect(template.edit).toHaveBeenCalledWith({
      text: "Subscriber Goal",
      modOnly: true,
      allowUserEdits: false,
      allowableContent: "text",
      backgroundColor: "#FF4500",
      textColor: "light",
    });
    expect(reddit.createPostFlairTemplate).not.toHaveBeenCalled();
  });

  it("backfills valid local goal posts and isolates individual failures", async () => {
    const reddit = {
      getPostById: vi.fn(async (id: string) => {
        if (id === "t3_missing") throw new Error("post not found");
        return { id, subredditId: id === "t3_other" ? "t5_other" : "t5_local" };
      }),
      setPostFlair: vi.fn(async () => undefined),
    };

    const result = await backfillSubscriberGoalPostFlair(
      reddit as never,
      { id: "t5_local", name: "ExampleSub" },
      ["t3_good", "t3_missing", "t3_other"],
      "flair_1",
    );

    expect(reddit.setPostFlair).toHaveBeenCalledWith({
      subredditName: "ExampleSub",
      postId: "t3_good",
      flairTemplateId: "flair_1",
    });
    expect(result).toEqual({ applied: 1, failed: ["t3_missing"] });
  });
});
