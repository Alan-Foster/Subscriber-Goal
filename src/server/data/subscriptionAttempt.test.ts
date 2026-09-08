import { describe, expect, it, vi } from "vitest";
import type { RedisClient } from "../types";
import {
  hasSubscriptionAttemptReceipt,
  isValidSubscriptionAttemptId,
  storeSubscriptionAttemptReceipt,
  subscriptionAttemptReceiptTtlMs,
} from "./subscriptionAttempt";

const attemptId = "123e4567-e89b-42d3-a456-426614174000";

describe("subscription attempt receipts", () => {
  it("validates UUID attempt IDs", () => {
    expect(isValidSubscriptionAttemptId(attemptId)).toBe(true);
    expect(isValidSubscriptionAttemptId("not-an-attempt-id")).toBe(false);
    expect(isValidSubscriptionAttemptId(undefined)).toBe(false);
  });

  it("stores a receipt with a two-minute expiration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const set = vi.fn().mockResolvedValue("OK");

    await storeSubscriptionAttemptReceipt(
      { set } as unknown as RedisClient,
      attemptId,
      "t3_post",
      "t2_user",
    );

    expect(set).toHaveBeenCalledWith(
      `subscription_attempt:${attemptId}`,
      JSON.stringify({ postId: "t3_post", userId: "t2_user" }),
      { expiration: new Date(1_000 + subscriptionAttemptReceiptTtlMs) },
    );
    vi.useRealTimers();
  });

  it("requires the receipt to match both user and post", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify({ postId: "t3_post", userId: "t2_user" }),
      );
    const redis = { get } as unknown as RedisClient;

    await expect(
      hasSubscriptionAttemptReceipt(redis, attemptId, "t3_post", "t2_user"),
    ).resolves.toBe(true);
    await expect(
      hasSubscriptionAttemptReceipt(redis, attemptId, "t3_other", "t2_user"),
    ).resolves.toBe(false);
    await expect(
      hasSubscriptionAttemptReceipt(redis, attemptId, "t3_post", "t2_other"),
    ).resolves.toBe(false);
    await expect(
      hasSubscriptionAttemptReceipt(redis, attemptId, "t3_post", null),
    ).resolves.toBe(false);
  });

  it("treats an expired or malformed receipt as unconfirmed", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("not-json");
    const redis = { get } as unknown as RedisClient;
    await expect(
      hasSubscriptionAttemptReceipt(redis, attemptId, "t3_post", "t2_user"),
    ).resolves.toBe(false);
    await expect(
      hasSubscriptionAttemptReceipt(redis, attemptId, "t3_post", "t2_user"),
    ).resolves.toBe(false);
  });
});
