import type { RedditClient, SubredditId } from "../types";
import { logDiagnostic } from "../../shared/diagnostics";

type StickyFailureNotificationParams = {
  reddit: RedditClient;
  subredditId: SubredditId;
  subredditName: string;
  moderatorUsername?: string | undefined;
  postTitle: string;
  postUrl?: string | undefined;
  errorMessage?: string | undefined;
  postOrigin?: "created" | "existing";
};

export type StickyFailureMessage = {
  subject: string;
  body: string;
};

export function buildStickyFailureMessage({
  subredditName,
  moderatorUsername,
  postTitle,
  postUrl,
  errorMessage,
  postOrigin = "created",
}: Omit<
  StickyFailureNotificationParams,
  "reddit" | "subredditId"
>): StickyFailureMessage {
  const subject = `Action Required - SubGoal Not Pinned in r/${subredditName}`;
  const moderatorLine = moderatorUsername
    ? `Initiating moderator: u/${moderatorUsername}`
    : "Initiating moderator: unknown";
  const postUrlLine = postUrl ? `\n${postUrl}` : "";
  const technicalNote = errorMessage
    ? `\n\nTechnical note: ${errorMessage}`
    : "";

  const isExisting = postOrigin === "existing";
  return {
    subject,
    body:
      (isExisting
        ? `Subscriber Goal found an existing valid goal, but it could not be pinned in r/${subredditName}.\n\n`
        : `The new Subscriber Goal post was created successfully, but it could not be pinned in r/${subredditName}.\n\n`) +
      "The app attempted to pin it automatically, but could not confirm that the post was pinned. This usually means the subreddit already has too many pinned or stickied posts.\n\n" +
      `Manual moderator action is required. Please remove or unpin an existing pinned post if appropriate, then manually pin the ${isExisting ? "existing" : "new"} Subscriber Goal post.\n\n` +
      "The app removes only older classic Subscriber Goal pins during replacement; CTA, Tiny, ambiguous, and unrelated Community Highlights are preserved.\n\n" +
      `Subreddit: r/${subredditName}\n` +
      `${moderatorLine}\n\n` +
      `${isExisting ? "Existing" : "New"} Subscriber Goal:\n${postTitle}${postUrlLine}` +
      technicalNote,
  };
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

export async function notifyStickyFailure({
  reddit,
  subredditId,
  subredditName,
  moderatorUsername,
  postTitle,
  postUrl,
  errorMessage,
  postOrigin = "created",
}: StickyFailureNotificationParams): Promise<"sent" | "failed"> {
  const message = buildStickyFailureMessage({
    subredditName,
    moderatorUsername,
    postTitle,
    postUrl,
    errorMessage,
    postOrigin,
  });

  console.info(
    `[sticky] sending sticky failure modmail: subreddit=${subredditName} subredditId=${subredditId}`,
  );
  let modmailOutcome: "sent" | "failed" = "sent";
  try {
    await reddit.modMail.createModNotification({
      subredditId,
      subject: message.subject,
      bodyMarkdown: message.body,
    });
    console.info(
      `[sticky] sticky failure modmail sent: subreddit=${subredditName} subredditId=${subredditId}`,
    );
  } catch (error) {
    modmailOutcome = "failed";
    logDiagnostic(
      "warn",
      "sticky_notification_failed",
      { workflow: "sticky_notification", phase: "modmail" },
      error,
    );
  }

  if (!moderatorUsername) {
    logDiagnostic("warn", "sticky_notification_skipped", {
      workflow: "sticky_notification",
      phase: "missing_moderator",
    });
    return modmailOutcome;
  }

  logDiagnostic("info", "sticky_notification_started", {
    workflow: "sticky_notification",
    phase: "direct_message",
  });
  try {
    await reddit.sendPrivateMessage({
      to: moderatorUsername,
      subject: message.subject,
      text: message.body,
    });
    logDiagnostic("info", "sticky_notification_completed", {
      workflow: "sticky_notification",
      phase: "direct_message",
    });
  } catch (error) {
    logDiagnostic(
      "warn",
      "sticky_notification_failed",
      { workflow: "sticky_notification", phase: "direct_message" },
      error,
    );
  }
  return modmailOutcome;
}
