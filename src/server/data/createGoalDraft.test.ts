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
      language: "es",
      postHeight: "short",
    });

    expect(redis.set).toHaveBeenCalledWith(
      "create_goal_draft:t2_mod",
      JSON.stringify({ version: 1, language: "es", postHeight: "short" }),
      {
        expiration: new Date(
          new Date("2026-08-27T12:00:00.000Z").getTime() +
            createGoalDraftExpirationMs,
        ),
      },
    );
    expect(await getCreateGoalDraft(redis, "t2_mod")).toEqual({
      version: 1,
      language: "es",
      postHeight: "short",
    });
    vi.useRealTimers();
  });

  it("returns null for missing, malformed, or unsupported drafts", async () => {
    expect(await getCreateGoalDraft(redis, "t2_mod")).toBeNull();

    values.set(getCreateGoalDraftKey("t2_mod"), "not-json");
    expect(await getCreateGoalDraft(redis, "t2_mod")).toBeNull();

    values.set(
      getCreateGoalDraftKey("t2_mod"),
      JSON.stringify({ version: 2, language: "en", postHeight: "regular" }),
    );
    expect(await getCreateGoalDraft(redis, "t2_mod")).toBeNull();

    values.set(
      getCreateGoalDraftKey("t2_mod"),
      JSON.stringify({ version: 1, language: "xx", postHeight: "giant" }),
    );
    expect(await getCreateGoalDraft(redis, "t2_mod")).toBeNull();
  });

  it("isolates drafts by moderator and deletes only the selected draft", async () => {
    await saveCreateGoalDraft(redis, "t2_first", {
      language: "en",
      postHeight: "regular",
    });
    await saveCreateGoalDraft(redis, "t2_second", {
      language: "fr",
      postHeight: "tiny",
    });

    await deleteCreateGoalDraft(redis, "t2_first");

    expect(await getCreateGoalDraft(redis, "t2_first")).toBeNull();
    expect(await getCreateGoalDraft(redis, "t2_second")).toEqual({
      version: 1,
      language: "fr",
      postHeight: "tiny",
    });
  });
});
