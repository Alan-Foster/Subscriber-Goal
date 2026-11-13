import { logDiagnostic } from "../../shared/diagnostics";
import type { LinkId, RedisClient, SubredditId } from "../types";

export const sourcePostDeletionIntentsKey = "source_post_deletion_intents_v1";
export const sourcePostDeletionDueKey = "source_post_deletion_due_v1";

export type SourcePostDeletionStatus =
  | "ready_to_delete"
  | "verify_source"
  | "dispatch_pending"
  | "dispatched"
  | "terminal_failed";

export type SourcePostDeletionIntent = {
  id: string;
  postId: LinkId;
  subredditId: SubredditId;
  subredditName: string;
  status: SourcePostDeletionStatus;
  createdAtMs: number;
  updatedAtMs: number;
  nextAttemptMs: number;
  attemptCount: number;
  deleteAttemptCount: number;
  lastError: string | null;
  dispatchedAtMs?: number;
};

export function sourcePostDeletionIntentId(
  subredditId: string,
  postId: string,
): string {
  return `${subredditId}:${postId}`;
}

function parseIntent(
  raw: string | undefined,
): SourcePostDeletionIntent | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<SourcePostDeletionIntent>;
    if (
      typeof value.id !== "string" ||
      typeof value.postId !== "string" ||
      typeof value.subredditId !== "string" ||
      typeof value.subredditName !== "string" ||
      ![
        "ready_to_delete",
        "verify_source",
        "dispatch_pending",
        "dispatched",
        "terminal_failed",
      ].includes(value.status ?? "") ||
      typeof value.createdAtMs !== "number" ||
      typeof value.updatedAtMs !== "number" ||
      typeof value.nextAttemptMs !== "number" ||
      typeof value.attemptCount !== "number" ||
      typeof value.deleteAttemptCount !== "number"
    ) {
      return undefined;
    }
    return value as SourcePostDeletionIntent;
  } catch (error) {
    logDiagnostic(
      "warn",
      "persisted_json_invalid",
      { workflow: "source_post_deletion", phase: "intent_decode" },
      error,
    );
    return undefined;
  }
}

export async function getSourcePostDeletionIntent(
  redis: RedisClient,
  intentId: string,
): Promise<SourcePostDeletionIntent | undefined> {
  return parseIntent(await redis.hGet(sourcePostDeletionIntentsKey, intentId));
}

/**
 * Writes both the record and its discoverability index and then reads the
 * record back. Callers must not perform an irreversible action unless this
 * function resolves; a rejected/unknown write therefore remains fail closed.
 */
export async function saveSourcePostDeletionIntent(
  redis: RedisClient,
  intent: SourcePostDeletionIntent,
): Promise<SourcePostDeletionIntent> {
  await redis.hSet(sourcePostDeletionIntentsKey, {
    [intent.id]: JSON.stringify(intent),
  });
  if (intent.status === "dispatched" || intent.status === "terminal_failed") {
    await redis.zRem(sourcePostDeletionDueKey, [intent.id]);
  } else {
    await redis.zAdd(sourcePostDeletionDueKey, {
      member: intent.id,
      score: intent.nextAttemptMs,
    });
  }
  const persisted = await getSourcePostDeletionIntent(redis, intent.id);
  if (!persisted || JSON.stringify(persisted) !== JSON.stringify(intent)) {
    throw new Error("Source deletion intent persistence was not confirmed.");
  }
  return persisted;
}

export async function listDueSourcePostDeletionIntents(
  redis: RedisClient,
  options: { nowMs?: number; limit?: number } = {},
): Promise<SourcePostDeletionIntent[]> {
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(1, Math.min(25, Math.floor(options.limit ?? 10)));
  const indexed = await redis.zRange(sourcePostDeletionDueKey, 0, limit - 1);
  const ids = indexed
    .filter((entry) => Number(entry.score) <= nowMs)
    .slice(0, limit)
    .map((entry) => entry.member);
  if (ids.length === 0) return [];
  const intents: SourcePostDeletionIntent[] = [];
  const stale: string[] = [];
  for (const id of ids) {
    const intent = await getSourcePostDeletionIntent(redis, id);
    if (intent) intents.push(intent);
    else stale.push(id);
  }
  if (stale.length > 0) await redis.zRem(sourcePostDeletionDueKey, stale);
  return intents;
}
