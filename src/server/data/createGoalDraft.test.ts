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
  const creationAttemptId = "create-goal-test123";
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
      creationAttemptId,
      language: "es",
      postHeight: "short",
      subredditDisplayName: "ExampleSub",
      customDeveloperField: "",
    });

    expect(redis.set).toHaveBeenCalledWith(
      `create_goal_draft_v5:t2_mod:${creationAttemptId}`,
      JSON.stringify({
        version: 5,
        stage: "details",
        creationAttemptId,
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
    expect(
      await getCreateGoalDraft(redis, "t2_mod", creationAttemptId),
    ).toEqual({
      version: 5,
      stage: "details",
      creationAttemptId,
      language: "es",
      postHeight: "short",
      subredditDisplayName: "ExampleSub",
      customDeveloperField: "",
    });
    vi.useRealTimers();
  });

  it("returns null for missing, malformed, or unsupported drafts", async () => {
    expect(
      await getCreateGoalDraft(redis, "t2_mod", creationAttemptId),
    ).toBeNull();

    values.set(getCreateGoalDraftKey("t2_mod", creationAttemptId), "not-json");
    expect(
      await getCreateGoalDraft(redis, "t2_mod", creationAttemptId),
    ).toBeNull();

    values.set(
      getCreateGoalDraftKey("t2_mod", creationAttemptId),
      JSON.stringify({ version: 1, language: "en", postHeight: "regular" }),
    );
    expect(
      await getCreateGoalDraft(redis, "t2_mod", creationAttemptId),
    ).toBeNull();

    values.set(
      getCreateGoalDraftKey("t2_mod", creationAttemptId),
      JSON.stringify({
        version: 3,
        stage: "follow-up",
        language: "en",
        postHeight: "regular",
        subredditDisplayName: "ExampleSub",
        customDeveloperField: "",
      }),
    );
    expect(
      await getCreateGoalDraft(redis, "t2_mod", creationAttemptId),
    ).toBeNull();

    values.set(
      getCreateGoalDraftKey("t2_mod", creationAttemptId),
      JSON.stringify({
        version: 4,
        stage: "details",
        language: "xx",
        postHeight: "giant",
        subredditDisplayName: "ExampleSub",
        customDeveloperField: "",
      }),
    );
    expect(
      await getCreateGoalDraft(redis, "t2_mod", creationAttemptId),
    ).toBeNull();
  });

  it("isolates drafts by moderator and deletes only the selected draft", async () => {
    await saveCreateGoalDraft(redis, "t2_first", {
      stage: "details",
      creationAttemptId: "create-goal-first123",
      language: "en",
      postHeight: "regular",
      subredditDisplayName: "ExampleSub",
      customDeveloperField: "",
    });
    await saveCreateGoalDraft(redis, "t2_second", {
      stage: "details",
      creationAttemptId: "create-goal-second12",
      language: "fr",
      postHeight: "tiny",
      subredditDisplayName: "EXAMPLEsub",
      customDeveloperField: "",
    });

    await deleteCreateGoalDraft(redis, "t2_first", "create-goal-first123");

    expect(
      await getCreateGoalDraft(redis, "t2_first", "create-goal-first123"),
    ).toBeNull();
    expect(
      await getCreateGoalDraft(redis, "t2_second", "create-goal-second12"),
    ).toEqual({
      version: 5,
      stage: "details",
      creationAttemptId: "create-goal-second12",
      language: "fr",
      postHeight: "tiny",
      subredditDisplayName: "EXAMPLEsub",
      customDeveloperField: "",
    });
  });

  it("isolates multiple attempts for the same moderator", async () => {
    await saveCreateGoalDraft(redis, "t2_mod", {
      stage: "setup",
      creationAttemptId: "create-goal-first123",
    });
    await saveCreateGoalDraft(redis, "t2_mod", {
      stage: "setup",
      creationAttemptId: "create-goal-second12",
    });

    await deleteCreateGoalDraft(redis, "t2_mod", "create-goal-first123");

    expect(
      await getCreateGoalDraft(redis, "t2_mod", "create-goal-first123"),
    ).toBeNull();
    expect(
      await getCreateGoalDraft(redis, "t2_mod", "create-goal-second12"),
    ).toMatchObject({ creationAttemptId: "create-goal-second12" });
  });

  it("rejects malformed attempt IDs without touching Redis", async () => {
    await expect(
      saveCreateGoalDraft(redis, "t2_mod", {
        stage: "setup",
        creationAttemptId: "bad:id",
      }),
    ).rejects.toThrow("invalid_creation_attempt_id");
    await expect(
      deleteCreateGoalDraft(redis, "t2_mod", "bad:id"),
    ).rejects.toThrow("invalid_creation_attempt_id");
    await expect(
      getCreateGoalDraft(redis, "t2_mod", "bad:id"),
    ).resolves.toBeNull();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("stores and validates the post-kind-specific follow-up stage", async () => {
    await saveCreateGoalDraft(redis, "t2_goal", {
      stage: "follow-up",
      creationAttemptId: "create-goal-goal1234",
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
      creationAttemptId: "create-goal-tiny1234",
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
    await saveCreateGoalDraft(redis, "t2_cta", {
      stage: "follow-up",
      creationAttemptId: "create-goal-cta12345",
      language: "en",
      postHeight: "cta",
      subredditDisplayName: "ExampleSub",
      customDeveloperField: "",
      details: {
        kind: "cta-only",
        postTitle: "Create something",
        afterSubscribePreset: "create-post",
      },
    });

    expect(
      (await getCreateGoalDraft(redis, "t2_goal", "create-goal-goal1234"))
        ?.stage,
    ).toBe("follow-up");
    expect(
      (await getCreateGoalDraft(redis, "t2_tiny", "create-goal-tiny1234"))
        ?.stage,
    ).toBe("follow-up");
    expect(
      (await getCreateGoalDraft(redis, "t2_cta", "create-goal-cta12345"))
        ?.stage,
    ).toBe("follow-up");

    values.set(
      getCreateGoalDraftKey("t2_conflict", "create-goal-conflict"),
      JSON.stringify({
        version: 5,
        stage: "follow-up",
        creationAttemptId: "create-goal-conflict",
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
    expect(
      await getCreateGoalDraft(redis, "t2_conflict", "create-goal-conflict"),
    ).toBeNull();
  });
});
