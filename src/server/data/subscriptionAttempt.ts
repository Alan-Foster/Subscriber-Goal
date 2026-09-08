import type { RedisClient } from "../types";
import { logDiagnostic } from "../../shared/diagnostics";

export const subscriptionAttemptReceiptTtlMs = 2 * 60 * 1000;

type SubscriptionAttemptReceipt = {
  postId: string;
  userId: string;
};

const subscriptionAttemptKey = (attemptId: string): string =>
  `subscription_attempt:${attemptId}`;

export const isValidSubscriptionAttemptId = (
  attemptId: unknown,
): attemptId is string =>
  typeof attemptId === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    attemptId,
  );

export async function storeSubscriptionAttemptReceipt(
  redis: Pick<RedisClient, "set">,
  attemptId: string,
  postId: string,
  userId: string,
): Promise<void> {
  const receipt: SubscriptionAttemptReceipt = { postId, userId };
  await redis.set(subscriptionAttemptKey(attemptId), JSON.stringify(receipt), {
    expiration: new Date(Date.now() + subscriptionAttemptReceiptTtlMs),
  });
}

export async function hasSubscriptionAttemptReceipt(
  redis: Pick<RedisClient, "get">,
  attemptId: string,
  postId: string,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId) return false;
  const raw = await redis.get(subscriptionAttemptKey(attemptId));
  if (!raw) return false;
  try {
    const receipt = JSON.parse(raw) as Partial<SubscriptionAttemptReceipt>;
    return receipt.postId === postId && receipt.userId === userId;
  } catch (error) {
    logDiagnostic(
      "warn",
      "persisted_json_invalid",
      {
        workflow: "subscription_attempt",
        phase: "receipt_decode",
        recordId: attemptId.slice(0, 8),
      },
      error,
    );
    return false;
  }
}
