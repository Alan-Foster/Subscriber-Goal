import type { ServerAppSettings } from "../settings";
import type { RedditClient, RedisClient } from "../types";
import type { SubGoalColorTheme } from "../../shared/subGoalColorTheme";
import type { SubGoalLanguage } from "../../shared/subGoalPostI18n";
import type { SubGoalPostHeight } from "../../shared/subGoalPostHeight";
import type { createGoalPost } from "./post";
import type { CrosspostDispatchResult } from "../data/subGoalData";
import {
  createFailedHighlightResult,
  type HighlightResult,
  type HighlightVerificationOptions,
} from "../utils/communityHighlights";
import { translate } from "../../shared/i18n/catalog";
import type {
  AfterSubscribeAction,
  AfterSubscribePreset,
} from "../../shared/afterSubscribeAction";
import type { CommunityGoalMutationLease } from "./communityGoalMutation";
import type { HighlightReconciliationContext } from "../data/highlightManagement";
import { isRecord } from "../utils/runtimeValidation";

export type CreateSubscriberGoalOptions = {
  title: string;
  goal?: number;
  subredditDisplayName: string;
  crosspost: boolean;
  colorTheme: SubGoalColorTheme;
  postHeight: SubGoalPostHeight;
  autoCreateNextGoal: boolean;
  language: SubGoalLanguage;
  cancelPendingAutoCreateGoals?: boolean;
  submitAsUser?: boolean;
  headerText?: string;
  afterSubscribeAction?: AfterSubscribeAction;
  afterSubscribePreset?: AfterSubscribePreset;
  operationId?: string;
  automaticPermissionCheck?: boolean;
  highlightVerification?: Partial<HighlightVerificationOptions>;
  reconciliationContext?: HighlightReconciliationContext;
  mutationLease?: CommunityGoalMutationLease;
  reconciliationNowMs?: number;
  canStartSubmissionReconciliation?: () => boolean;
  /** Trusted server-only identity for an interactive/manual invocation. */
  manualActorUserId?: string;
};

export type CreateSubscriberGoalResult = {
  outcome: "created" | "superseded" | "retired";
  post: GoalPost;
  crosspostDispatchResult: CrosspostDispatchResult;
  highlightResult: HighlightResult;
  flairResult: SubscriberGoalFlairResult | { status: "unknown" };
  supersedingPostId?: `t3_${string}`;
};

export type SubscriberGoalFlairResult =
  | { status: "applied"; flairId: string }
  | {
      status: "omitted";
      reason: "missing_permission" | "preparation_failed";
    };

export function isSubscriberGoalFlairResult(
  value: unknown,
): value is CreateSubscriberGoalResult["flairResult"] {
  if (!isRecord(value)) return false;
  if (value.status === "applied") return typeof value.flairId === "string";
  if (value.status === "omitted") {
    return (
      value.reason === "missing_permission" ||
      value.reason === "preparation_failed"
    );
  }
  return value.status === "unknown";
}

export class SubscriberGoalModeratorPermissionError extends Error {
  constructor(
    appUsername: string | undefined,
    subredditName: string,
    language?: SubGoalLanguage,
  ) {
    const appAccount = appUsername
      ? `u/${appUsername}`
      : "the Subscriber Goal app account";
    super(
      translate(language, "errors.create.moderatorPermission", {
        appAccount,
        subredditName,
      }),
    );
    this.name = "SubscriberGoalModeratorPermissionError";
  }
}

export class SubscriberGoalCreationOutcomeUnknownError extends Error {
  readonly reconciliationStatus: "pending" | "exhausted";
  readonly reconciliationAttempts: number;
  readonly reconciliationNextAt?: number;

  constructor(
    language?: SubGoalLanguage,
    reconciliation: {
      status: "pending" | "exhausted";
      attempts: number;
      nextAt?: number;
    } = { status: "pending", attempts: 0 },
  ) {
    super(translate(language, "errors.create.outcomeUnknown"));
    this.name = "SubscriberGoalCreationOutcomeUnknownError";
    this.reconciliationStatus = reconciliation.status;
    this.reconciliationAttempts = reconciliation.attempts;
    if (reconciliation.nextAt !== undefined) {
      this.reconciliationNextAt = reconciliation.nextAt;
    }
  }
}

export const submissionReconciliationDelayMs = [
  1 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
  120 * 60 * 1000,
] as const;

export class SubscriberGoalPermissionVerificationError extends Error {
  constructor(subredditName: string, language?: SubGoalLanguage) {
    super(
      translate(language, "errors.create.permissionVerification", {
        subredditName,
      }),
    );
    this.name = "SubscriberGoalPermissionVerificationError";
  }
}

export type GoalPost = Awaited<ReturnType<typeof createGoalPost>>;

export type CreationSubreddit = Awaited<
  ReturnType<RedditClient["getCurrentSubreddit"]>
>;

export type GoalCreationInput = {
  reddit: RedditClient;
  redis: RedisClient;
  appSettings: ServerAppSettings;
  options: CreateSubscriberGoalOptions;
};

export type GoalCreationRecoveryHooks = {
  recoveredPost?: GoalPost;
  recoveredCrosspostDispatchResult?: CrosspostDispatchResult;
  submissionMarker: string;
  onSubmissionStarted: (
    subredditName: string,
    subredditId: string,
  ) => Promise<void>;
  onPostSubmitted: (postId: string) => Promise<void>;
  onSubmissionUnknown: () => Promise<void>;
  onRegistrationCompleted: (
    postId: GoalPost["id"],
    result: CrosspostDispatchResult,
  ) => Promise<void>;
};

export function createTerminalCreationResult(
  outcome: "superseded" | "retired",
  postId: `t3_${string}`,
  supersedingPostId?: `t3_${string}`,
): CreateSubscriberGoalResult {
  return {
    outcome,
    post: { id: postId } as GoalPost,
    crosspostDispatchResult: { status: "skipped" },
    highlightResult: createFailedHighlightResult(
      postId,
      "write",
      outcome === "retired"
        ? "The recovered post is retired."
        : "The recovered post was superseded by newer community state.",
    ),
    flairResult: { status: "omitted", reason: "preparation_failed" },
    ...(supersedingPostId ? { supersedingPostId } : {}),
  };
}
