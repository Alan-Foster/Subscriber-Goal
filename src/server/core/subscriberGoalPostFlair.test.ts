import { describe, expect, it, vi } from "vitest";
import { watchTestString } from "../testing/testHashWatch";
import {
  backfillSubscriberGoalPostFlair,
  ensureSubscriberGoalPostFlair,
} from "./subscriberGoalPostFlair";

function flairRedis() {
  const values = new Map<string, string>();
  const redis = {
    set: async (key: string, value: string) => {
      if (!values.has(key)) values.set(key, value);
    },
    get: async (key: string) => values.get(key),
    del: async (key: string) => values.delete(key),
  };
  return { ...redis, watch: (key: string) => watchTestString(redis, key) };
}

describe("Subscriber Goal post flair", () => {
  it("creates the canonical mod-only flair when absent", async () => {
    const created = { id: "flair_1" };
    const reddit = {
      getPostFlairTemplates: vi.fn(async () => []),
      createPostFlairTemplate: vi.fn(async () => created),
    };

    await expect(
      ensureSubscriberGoalPostFlair(
        reddit as never,
        flairRedis() as never,
        "ExampleSub",
      ),
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
      ensureSubscriberGoalPostFlair(
        reddit as never,
        flairRedis() as never,
        "ExampleSub",
      ),
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

  it("prevents repair and creation from creating duplicate canonical templates", async () => {
    const redis = flairRedis();
    const template = {
      id: "flair_1",
      text: "Subscriber Goal",
      allowableContent: "text",
      backgroundColor: "#FF4500",
      modOnly: true,
      textColor: "light",
      allowUserEdits: false,
    };
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finishCreation!: () => void;
    const creation = new Promise<void>((resolve) => {
      finishCreation = resolve;
    });
    let templates: (typeof template)[] = [];
    const reddit = {
      getPostFlairTemplates: vi.fn(async () => templates),
      createPostFlairTemplate: vi.fn(async () => {
        markStarted();
        await creation;
        templates = [template];
        return template;
      }),
    };
    const ensure = () =>
      ensureSubscriberGoalPostFlair(
        reddit as never,
        redis as never,
        "ExampleSub",
      );
    const first = ensure();
    await started;
    await expect(ensure()).rejects.toThrow(
      "flair creation is already in progress",
    );
    finishCreation();
    await expect(first).resolves.toBe(template);
    await expect(ensure()).resolves.toBe(template);
    expect(reddit.createPostFlairTemplate).toHaveBeenCalledOnce();
  });

  it("pauses flair repair on removed posts and resumes after approval", async () => {
    const post = { id: "t3_paused", subredditId: "t5_local", removed: true };
    const reddit = {
      getPostById: vi.fn(async () => post),
      setPostFlair: vi.fn(),
    };
    const repair = () =>
      backfillSubscriberGoalPostFlair(
        reddit as never,
        { id: "t5_local", name: "ExampleSub" },
        [post.id],
        "flair_1",
      );
    await expect(repair()).resolves.toEqual({ applied: 0, failed: [] });
    expect(reddit.setPostFlair).not.toHaveBeenCalled();
    post.removed = false;
    await expect(repair()).resolves.toEqual({ applied: 1, failed: [] });
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
