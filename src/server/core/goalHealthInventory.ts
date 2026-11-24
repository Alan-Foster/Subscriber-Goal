import { ctaOnlyPostKind, subscribeOnlyPostKind } from "../../shared/postKind";
import {
  postAutomaticSuccessorSuppressionSuffix,
  postCompletedTimeSuffix,
  postGoalSuffix,
  postHeightSuffix,
  postKindSuffix,
  subscriberGoalsKey,
} from "../data/subGoalData";
import { isLinkId, type LinkId, type RedisClient } from "../types";
import { retiredSubscriberGoalKeyPrefix } from "./postRetirement";

export type GoalHealthPost = {
  id: LinkId;
  status: "active" | "completed" | "retired" | "alternative";
  completedAt: number | undefined;
  retiredAt: number | undefined;
  retiredReason: string | undefined;
  suppression: string | undefined;
};

export type GoalHealthScan = {
  cursor: number;
  completedId?: LinkId;
  completedAt?: number;
  alternativeId?: LinkId;
};

export function positiveTime(raw: unknown): number | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function isAlternative(kind: unknown, height: unknown): boolean {
  return (
    kind === ctaOnlyPostKind ||
    kind === subscribeOnlyPostKind ||
    height === "tiny" ||
    height === "cta"
  );
}

export async function readGoalHealthPosts(
  redis: RedisClient,
  ids: readonly LinkId[],
): Promise<GoalHealthPost[]> {
  if (ids.length === 0) return [];
  const healthPostFields = [
    postGoalSuffix,
    postCompletedTimeSuffix,
    postKindSuffix,
    postHeightSuffix,
    postAutomaticSuccessorSuppressionSuffix,
  ];
  const fieldsPerPost = healthPostFields.length;
  const [fields, tombstones] = await Promise.all([
    redis.hMGet(
      subscriberGoalsKey,
      ids.flatMap((id) => healthPostFields.map((suffix) => id + suffix)),
    ),
    redis.mGet(ids.map((id) => `${retiredSubscriberGoalKeyPrefix}:${id}`)),
  ]);
  return ids.flatMap<GoalHealthPost>((id, index) => {
    const offset = index * fieldsPerPost;
    const [goal, completion, kind, height, suppression] = fields.slice(
      offset,
      offset + fieldsPerPost,
    );
    const retired = tombstones[index];
    const completedAt = positiveTime(completion);
    const base = { id, completedAt, suppression: suppression || undefined };
    if (retired) {
      const record = JSON.parse(retired) as {
        retiredAt?: unknown;
        reason?: unknown;
      };
      return [
        {
          ...base,
          status: "retired" as const,
          retiredAt: positiveTime(record.retiredAt),
          retiredReason:
            typeof record.reason === "string" ? record.reason : undefined,
        },
      ];
    }
    const live = { ...base, retiredAt: undefined, retiredReason: undefined };
    if (isAlternative(kind, height))
      return [{ ...live, status: "alternative" as const }];
    if (!positiveTime(goal)) return [];
    return [
      {
        ...live,
        status:
          completedAt === undefined
            ? ("active" as const)
            : ("completed" as const),
      },
    ];
  });
}

function scanPostId(field: string, value: string): LinkId | undefined {
  const suffix =
    field.endsWith(postGoalSuffix) && positiveTime(value)
      ? postGoalSuffix
      : [postKindSuffix, postHeightSuffix].find(
          (candidate) =>
            field.endsWith(candidate) && isAlternative(value, value),
        );
  if (!suffix) return;
  const id = field.slice(0, -suffix.length);
  if (isLinkId(id)) return id;
}

export async function scanGoalHealthInventory(
  redis: RedisClient,
  prior: GoalHealthScan,
  canRead: () => boolean,
): Promise<{
  scan: GoalHealthScan;
  complete: boolean;
  active?: GoalHealthPost;
}> {
  const scan = { ...prior };
  for (let remaining = 6; remaining > 0 && canRead(); remaining -= 1) {
    const page = await redis.hScan(
      subscriberGoalsKey,
      scan.cursor,
      undefined,
      500,
    );
    if (!canRead()) break;
    const ids = new Set<LinkId>();
    for (const row of page.fieldValues) {
      const id = scanPostId(row.field, row.value);
      if (id) ids.add(id);
    }
    const posts = await readGoalHealthPosts(redis, [...ids]);
    for (const post of posts) {
      if (post.status === "active")
        return { scan: { cursor: 0 }, complete: true, active: post };
      if (post.status === "alternative") scan.alternativeId ??= post.id;
      if (post.completedAt && post.completedAt > (scan.completedAt ?? 0)) {
        scan.completedAt = post.completedAt;
        scan.completedId = post.id;
      }
    }
    scan.cursor = page.cursor;
    if (page.cursor === 0) return { scan, complete: true };
  }
  return { scan, complete: false };
}
