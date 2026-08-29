import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RedisClient } from "../types";
import {
  createGoalDraftExpirationMs,
  deleteCreateGoalDraft,
  getCreateGoalDraft,
  getCreateGoalDraftKey,
  saveCreateGoalDraft,
} from "./createGoalDraft";

describe("create goal drafts", () => {
  const values = new Map<string, string>();
  const redis = {
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => values.get(key)),
    del: vi.fn(async (key: string) => (values.delete(key) ? 1 : 0)),
  } as unknown as RedisClient;

  beforeEach(() => {
    vi.clearAllMocks();
    values.clear();
  });

  it("stores a versioned draft with a 30-minute expiration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));

    await saveCreateGoalDraft(redis, "t2_mod", {
      stage: "details",
      language: "es",
      postHeight: "short",
      subredditDisplayName: "ExampleSub",
      customDeveloperField: "",
    });

    expect(redis.set).toHaveBeenCalledWith(
      "create_goal_draft:t2_mod",
      JSON.stringify({
        version: 4,
        stage: "details",
        language: "es",
        postHeight: "short",
        subredditDisplayName: "ExampleSub",
        customDeveloperField: "",
      }),
      {
        expiration: new Date(
          new Date("2026-08-27T12:00:00.000Z").getTime() +
            createGoalDraftExpirationMs,
        ),
      },
    );
    expect(await getCreateGoalDraft(redis, "t2_mod")).toEqual({
      version: 4,
      stage: "details",
      language: "es",
      postHeight: "short",
      subredditDisplayName: "ExampleSub",
      customDeveloperField: "",
    });
    vi.useRealTimers();
  });

  it("returns null for missing, malformed, or unsupported drafts", async () => {
    expect(await getCreateGoalDraft(redis, "t2_mod")).toBeNull();

    values.set(getCreateGoalDraftKey("t2_mod"), "not-json");
    expect(await getCreateGoalDraft(redis, "t2_mod")).toBeNull();

    values.set(
      getCreateGoalDraftKey("t2_mod"),
      JSON.stringify({ version: 1, language: "en", postHeight: "regular" }),
    );
    expect(await getCreateGoalDraft(redis, "t2_mod")).toBeNull();

    values.set(
      getCreateGoalDraftKey("t2_mod"),
      JSON.stringify({
        version: 3,
        stage: "follow-up",
        language: "en",
        postHeight: "regular",
        subredditDisplayName: "ExampleSub",
        customDeveloperField: "",
      }),
    );
    expect(await getCreateGoalDraft(redis, "t2_mod")).toBeNull();

    values.set(
      getCreateGoalDraftKey("t2_mod"),
      JSON.stringify({
        version: 4,
        stage: "details",
        language: "xx",
        postHeight: "giant",
        subredditDisplayName: "ExampleSub",
        customDeveloperField: "",
      }),
    );
    expect(await getCreateGoalDraft(redis, "t2_mod")).toBeNull();
  });

  it("isolates drafts by moderator and deletes only the selected draft", async () => {
    await saveCreateGoalDraft(redis, "t2_first", {
      stage: "details",
      language: "en",
      postHeight: "regular",
      subredditDisplayName: "ExampleSub",
      customDeveloperField: "",
    });
    await saveCreateGoalDraft(redis, "t2_second", {
      stage: "details",
      language: "fr",
      postHeight: "tiny",
      subredditDisplayName: "EXAMPLEsub",
      customDeveloperField: "",
    });

    await deleteCreateGoalDraft(redis, "t2_first");

    expect(await getCreateGoalDraft(redis, "t2_first")).toBeNull();
    expect(await getCreateGoalDraft(redis, "t2_second")).toEqual({
      version: 4,
      stage: "details",
      language: "fr",
      postHeight: "tiny",
      subredditDisplayName: "EXAMPLEsub",
      customDeveloperField: "",
    });
  });

  it("stores and validates the post-kind-specific follow-up stage", async () => {
    await saveCreateGoalDraft(redis, "t2_goal", {
      stage: "follow-up",
      language: "en",
      postHeight: "regular",
      subredditDisplayName: "ExampleSub",
      customDeveloperField: "",
      details: {
        kind: "subscriber-goal",
        postTitle: "Welcome!",
        subscriberGoal: 250,
        colorTheme: "pink",
        crosspost: true,
        afterSubscribePreset: "web-link",
        autoCreateNextGoal: true,
      },
    });
    await saveCreateGoalDraft(redis, "t2_tiny", {
      stage: "follow-up",
      language: "en",
      postHeight: "tiny",
      subredditDisplayName: "ExampleSub",
      customDeveloperField: "",
      details: {
        kind: "subscribe-only",
        postTitle: "Subscribe",
        colorTheme: "blue",
        afterSubscribePreset: "newest-post",
      },
    });

    expect((await getCreateGoalDraft(redis, "t2_goal"))?.stage).toBe(
      "follow-up",
    );
    expect((await getCreateGoalDraft(redis, "t2_tiny"))?.stage).toBe(
      "follow-up",
    );

    values.set(
      getCreateGoalDraftKey("t2_conflict"),
      JSON.stringify({
        version: 4,
        stage: "follow-up",
        language: "en",
        postHeight: "tiny",
        subredditDisplayName: "ExampleSub",
        customDeveloperField: "",
        details: {
          kind: "subscriber-goal",
          postTitle: "Wrong kind",
          subscriberGoal: 200,
          colorTheme: "red",
          crosspost: false,
          afterSubscribePreset: "top-post-day",
          autoCreateNextGoal: true,
        },
      }),
    );
    expect(await getCreateGoalDraft(redis, "t2_conflict")).toBeNull();
  });
});
