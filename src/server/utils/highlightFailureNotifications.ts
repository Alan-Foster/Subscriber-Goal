import { logDiagnostic } from "../../shared/diagnostics";
import { translate } from "../../shared/i18n/catalog";
import type { LinkId, RedditClient, RedisClient, SubredditId } from "../types";
import type { HighlightResult } from "./communityHighlights";

const highlightIncidentKeyPrefix = "highlight_failure_incident_v1";
const activeHighlightIncidentKey = "highlight_failure_incident_active_v1";
const highlightIncidentRetryMs = 60 * 60 * 1000;
const highlightIncidentLockMs = 5 * 60 * 1000;
const highlightIncidentRetentionSeconds = 30 * 24 * 60 * 60;

export type HighlightNotificationOutcome =
  | "sent"
  | "failed"
  | "skipped_duplicate"
  | "not_requested";

type HighlightFailureNotificationParams = {
  reddit: RedditClient;
  subredditId: SubredditId;
  subredditName: string;
  moderatorUsername?: string | undefined;
  postTitle: string;
  postUrl?: string | undefined;
  errorMessage?: string | undefined;
  postOrigin?: "created" | "existing";
  highlightResult?: HighlightResult;
  language?: unknown;
};

export type HighlightFailureMessage = {
  subject: string;
  body: string;
};

export function buildHighlightFailureMessage({
  subredditName,
  moderatorUsername,
  postTitle,
  postUrl,
  errorMessage,
  postOrigin = "created",
  highlightResult,
  language,
}: Omit<
  HighlightFailureNotificationParams,
  "reddit" | "subredditId"
>): HighlightFailureMessage {
  const degraded = highlightResult?.status === "highlighted";
  const subject = degraded
    ? translate(language, "outbound.highlight.subjectAttention", {
        subredditName,
      })
    : translate(language, "outbound.highlight.subjectMissing", {
        subredditName,
      });
  const moderatorLine = moderatorUsername
    ? translate(language, "outbound.highlight.moderatorKnown", {
        moderatorUsername,
      })
    : translate(language, "outbound.highlight.moderatorUnknown");
  const postUrlLine = postUrl ? `\n${postUrl}` : "";
  const technicalNote = errorMessage
    ? `\n\n${translate(language, "outbound.highlight.technicalNote", { errorMessage })}`
    : "";

  const isExisting = postOrigin === "existing";
  return {
    subject,
    body:
      (degraded
        ? `${translate(language, "outbound.highlight.degradedIntro", { subredditName })}\n\n${describeHighlightResult(highlightResult, language)}\n\n`
        : isExisting
          ? `${translate(language, "outbound.highlight.existingIntro", { subredditName })}\n\n`
          : `${translate(language, "outbound.highlight.newIntro", { subredditName })}\n\n`) +
      (degraded
        ? `${translate(language, "outbound.highlight.manualReview")}\n\n`
        : `${translate(language, "outbound.highlight.manualAction", { origin: isExisting ? "existing" : "new" })}\n\n`) +
      `${translate(language, "outbound.highlight.preservation")}\n\n` +
      `${translate(language, "outbound.highlight.subreddit", { subredditName })}\n` +
      `${moderatorLine}\n\n` +
      `${translate(language, "outbound.highlight.goalHeading", { origin: isExisting ? "Existing" : "New" })}\n${postTitle}${postUrlLine}` +
      technicalNote,
  };
}

export function describeHighlightResult(
  result: HighlightResult,
  language?: unknown,
): string {
  if (result.status === "not_highlighted") {
    if (result.rollbackOutcome === "failed") {
      return translate(
        language,
        "outbound.highlight.result.notHighlightedRollback",
      );
    }
    if (
      result.capacityOutcome === "blocked" ||
      result.capacityOutcome === "concurrent_change"
    ) {
      return translate(language, "outbound.highlight.result.noCapacity");
    }
    return translate(language, "outbound.highlight.result.notConfirmed");
  }
  if (result.rollbackOutcome === "failed") {
    return translate(language, "outbound.highlight.result.rollback");
  }
  if (result.cleanupOutcome === "failed") {
    return translate(language, "outbound.highlight.result.cleanup");
  }
  if (result.reorderOutcome === "failed") {
    return translate(language, "outbound.highlight.result.reorder");
  }
  if (result.capacityOutcome === "concurrent_change") {
    return translate(language, "outbound.highlight.result.concurrent");
  }
  return translate(language, "outbound.highlight.result.review");
}

export function getPostUrl(post: {
  permalink?: string;
  url?: string;
}): string | undefined {
  const postUrl = post.permalink || post.url;
  if (!postUrl) {
    return undefined;
  }

  return postUrl.startsWith("http") ? postUrl : `https://reddit.com${postUrl}`;
}

export async function notifyHighlightFailure({
  reddit,
  subredditId,
  subredditName,
  moderatorUsername,
  postTitle,
  postUrl,
  errorMessage,
  postOrigin = "created",
  highlightResult,
  language,
}: HighlightFailureNotificationParams): Promise<"sent" | "failed"> {
  const message = buildHighlightFailureMessage({
    subredditName,
    moderatorUsername,
    postTitle,
    postUrl,
    errorMessage,
    postOrigin,
    ...(highlightResult ? { highlightResult } : {}),
    language,
  });

  console.info(
    `[highlight] sending highlight failure modmail: subreddit=${subredditName} subredditId=${subredditId}`,
  );
  let modmailOutcome: "sent" | "failed" = "sent";
  try {
    await reddit.modMail.createModNotification({
      subredditId,
      subject: message.subject,
      bodyMarkdown: message.body,
    });
    console.info(
      `[highlight] highlight failure modmail sent: subreddit=${subredditName} subredditId=${subredditId}`,
    );
  } catch (error) {
    modmailOutcome = "failed";
    logDiagnostic(
      "warn",
      "highlight_notification_failed",
      { workflow: "highlight_notification", phase: "modmail" },
      error,
    );
  }

  if (!moderatorUsername) {
    logDiagnostic("warn", "highlight_notification_skipped", {
      workflow: "highlight_notification",
      phase: "missing_moderator",
    });
    return modmailOutcome;
  }

  logDiagnostic("info", "highlight_notification_started", {
    workflow: "highlight_notification",
    phase: "direct_message",
  });
  try {
    await reddit.sendPrivateMessage({
      to: moderatorUsername,
      subject: message.subject,
      text: message.body,
    });
    logDiagnostic("info", "highlight_notification_completed", {
      workflow: "highlight_notification",
      phase: "direct_message",
    });
  } catch (error) {
    logDiagnostic(
      "warn",
      "highlight_notification_failed",
      { workflow: "highlight_notification", phase: "direct_message" },
      error,
    );
  }
  return modmailOutcome;
}

function incidentKey(postId: LinkId): string {
  return `${highlightIncidentKeyPrefix}:${postId}`;
}

function incidentFingerprint(result: HighlightResult): string {
  return JSON.stringify({
    status: result.status,
    categories: [
      ...new Set(result.issues.map(({ category }) => category)),
    ].sort(),
    capacityOutcome: result.capacityOutcome,
    cleanupOutcome: result.cleanupOutcome,
    rollbackOutcome: result.rollbackOutcome,
    reorderOutcome: result.reorderOutcome,
  });
}

export async function clearHighlightFailureIncident(
  redis: RedisClient,
  postId: LinkId,
): Promise<void> {
  await redis.del(incidentKey(postId));
  const activePostId = await redis.get(activeHighlightIncidentKey);
  if (activePostId && activePostId !== postId) {
    await redis.del(incidentKey(activePostId as LinkId));
  }
  if (activePostId) await redis.del(activeHighlightIncidentKey);
}

export async function clearActiveHighlightFailureIncident(
  redis: RedisClient,
): Promise<void> {
  const activePostId = await redis.get(activeHighlightIncidentKey);
  if (activePostId) {
    await redis.del(incidentKey(activePostId as LinkId));
    await redis.del(activeHighlightIncidentKey);
  }
}

export async function notifyHighlightFailureIncident({
  redis,
  postId,
  result,
  nowMs = Date.now(),
  ...notification
}: HighlightFailureNotificationParams & {
  redis: RedisClient;
  postId: LinkId;
  result: HighlightResult;
  nowMs?: number;
}): Promise<Exclude<HighlightNotificationOutcome, "not_requested">> {
  const key = incidentKey(postId);
  const fingerprint = incidentFingerprint(result);
  const activePostId = await redis.get(activeHighlightIncidentKey);
  if (activePostId && activePostId !== postId) {
    await redis.del(incidentKey(activePostId as LinkId));
  }
  await redis.set(activeHighlightIncidentKey, postId, {
    expiration: new Date(nowMs + highlightIncidentRetentionSeconds * 1000),
  });
  const existing = await redis.hGetAll(key);
  if (
    existing.fingerprint === fingerprint &&
    (existing.notifiedAt || Number(existing.nextAttemptAt ?? "0") > nowMs)
  ) {
    return "skipped_duplicate";
  }

  const lockKey = `${key}:lock`;
  const token = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  await redis.set(lockKey, token, {
    nx: true,
    expiration: new Date(nowMs + highlightIncidentLockMs),
  });
  if ((await redis.get(lockKey)) !== token) return "skipped_duplicate";

  try {
    const latest = await redis.hGetAll(key);
    if (
      latest.fingerprint === fingerprint &&
      (latest.notifiedAt || Number(latest.nextAttemptAt ?? "0") > nowMs)
    ) {
      return "skipped_duplicate";
    }
    const outcome = await notifyHighlightFailure({
      ...notification,
      highlightResult: result,
    });
    await redis.hSet(key, {
      fingerprint,
      postId,
      lastAttemptAt: String(nowMs),
      ...(outcome === "sent"
        ? { notifiedAt: String(nowMs), nextAttemptAt: "" }
        : {
            notifiedAt: "",
            nextAttemptAt: String(nowMs + highlightIncidentRetryMs),
          }),
    });
    await redis.expire(key, highlightIncidentRetentionSeconds);
    return outcome;
  } finally {
    if ((await redis.get(lockKey)) === token) await redis.del(lockKey);
  }
}
