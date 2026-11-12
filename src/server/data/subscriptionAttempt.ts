import type { RedisClient } from "../types";
import { logDiagnostic } from "../../shared/diagnostics";

export const subscriptionAttemptReceiptTtlMs = 2 * 60 * 1000;

type SubscriptionAttemptReceipt = {
  postId: string;
  userId: string;
};

type SubscriptionAcceptanceEvidence = SubscriptionAttemptReceipt & {
  acceptedAt: number;
  expiresAt: number;
};

const subscriptionAttemptKey = (attemptId: string): string =>
  `subscription_attempt:${attemptId}`;

export const subscriptionAcceptanceKey = (attemptId: string): string =>
  `subscription_acceptance:${attemptId}`;

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
  expiresAt = Date.now() + subscriptionAttemptReceiptTtlMs,
): Promise<void> {
  const receipt: SubscriptionAttemptReceipt = { postId, userId };
  await redis.set(subscriptionAttemptKey(attemptId), JSON.stringify(receipt), {
    expiration: new Date(expiresAt),
  });
}

export function serializeSubscriptionAcceptanceEvidence(
  postId: string,
  userId: string,
  acceptedAt: number,
): { value: string; expiresAt: number } {
  const expiresAt = acceptedAt + subscriptionAttemptReceiptTtlMs;
  return {
    value: JSON.stringify({ postId, userId, acceptedAt, expiresAt }),
    expiresAt,
  };
}

export async function getSubscriptionAcceptanceEvidence(
  redis: Pick<RedisClient, "get">,
  attemptId: string,
  postId: string,
  userId: string | null | undefined,
): Promise<SubscriptionAcceptanceEvidence | undefined> {
  if (!userId) return;
  const raw = await redis.get(subscriptionAcceptanceKey(attemptId));
  if (!raw) return;
  try {
    const evidence = JSON.parse(raw) as Partial<SubscriptionAcceptanceEvidence>;
    if (
      evidence.postId === postId &&
      evidence.userId === userId &&
      typeof evidence.acceptedAt === "number" &&
      typeof evidence.expiresAt === "number" &&
      Date.now() <= evidence.expiresAt
    ) {
      return evidence as SubscriptionAcceptanceEvidence;
    }
  } catch (error) {
    logDiagnostic(
      "warn",
      "persisted_json_invalid",
      {
        workflow: "subscription_attempt",
        phase: "acceptance_decode",
        recordId: attemptId.slice(0, 8),
      },
      error,
    );
  }
}

export async function hasSubscriptionAttemptReceipt(
  redis: Pick<RedisClient, "get">,
  attemptId: string,
  postId: string,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId) return false;
  const raw = await redis.get(subscriptionAttemptKey(attemptId));
  if (raw)
    try {
      const receipt = JSON.parse(raw) as Partial<SubscriptionAttemptReceipt>;
      if (receipt.postId === postId && receipt.userId === userId) return true;
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
    }
  return Boolean(
    await getSubscriptionAcceptanceEvidence(redis, attemptId, postId, userId),
  );
}
