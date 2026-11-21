import {
  requireCurrentActorAuthority,
  resolveCurrentSubredditLanguage,
} from "./internalUi.common";
import type { Response, Router, Request } from "express";
import type { UiResponse } from "@devvit/web/shared";
import { context, reddit, redis } from "@devvit/web/server";
import type {
  CreateGoalSetupFormValues,
  CreateCtaOnlyFollowUpFormValues,
  CreateCtaOnlyFormValues,
  CreateSubscribeOnlyFollowUpFormValues,
  CreateSubscribeOnlyFormValues,
  CreateSubscriberGoalFollowUpFormValues,
  CreateSubscriberGoalFormValues,
} from "../../shared/types/api";
import { resolveSubGoalColorTheme } from "../../shared/subGoalColorTheme";
import { subGoalPostHeights } from "../../shared/subGoalPostHeight";
import {
  subGoalLanguages,
  type SubGoalLanguage,
} from "../../shared/subGoalPostI18n";
import { internalRoutes } from "../../shared/routes";
import {
  createSubscriberGoal,
  recoverSubscriberGoalCreation,
  SubscriberGoalCreationInProgressError,
  SubscriberGoalCreationOutcomeUnknownError,
  SubscriberGoalActorAuthorizationError,
  SubscriberGoalModeratorPermissionError,
} from "../core/createSubscriberGoal";
import {
  CreateGoalDraftLeaseInProgressError,
  deleteCreateGoalDraft,
  getCreateGoalDraft,
  saveCreateGoalDraft,
  withCreateGoalDraftLease,
  type CreateGoalDraft,
  type CreateGoalDraftDetails,
} from "../data/createGoalDraft";
import { getAppSettings } from "../settings";
import {
  describeHighlightResult,
  getPostUrl,
  notifyHighlightFailure,
} from "../utils/highlightFailureNotifications";
import { validateSubredditDisplayName } from "../utils/subredditDisplayName";
import { parseDeveloperCommands } from "../utils/developerCommands";
import { ProhibitedSubredditError } from "../utils/subredditBlacklist";
import { createOperationId, logDiagnostic } from "../../shared/diagnostics";
import { isCrosspostEligible, isNsfwOrUnknown } from "../utils/subredditSafety";
import { translate } from "../../shared/i18n/catalog";
import {
  defaultAfterSubscribeColorTheme,
  getDefaultAfterSubscribePreset,
  isAfterSubscribePreset,
  resolveAfterSubscribeAction,
  type AfterSubscribeActionType,
  type AfterSubscribePreset,
} from "../../shared/afterSubscribeAction";
import {
  buildCreateGoalSetupForm,
  buildCreateGoalDetailsForm,
  buildCreateGoalFollowUpForm,
  getAfterSubscribePresetDefaults,
} from "./internalUi.createGoalForms";
import {
  readCreationAttemptCallback,
  type CreateGoalFollowUpValues,
} from "./internalUi.createGoalFields";

export function registerCreateGoalRoutes(router: Router): void {
  registerCreateGoalMenuRoute(
    router,
    internalRoutes.menu.createGoal,
    "regular",
  );
  registerCreateGoalMenuRoute(router, internalRoutes.menu.createCta, "cta");
  router.post(internalRoutes.forms.createGoalSetup, submitCreateGoalSetup);
  registerCreateGoalDetailsRoutes(router);
  registerCreateGoalFollowUpRoutes(router);
}

function registerCreateGoalDetailsRoutes(router: Router): void {
  router.post(
    internalRoutes.forms.createSubscriberGoal,
    async (req, res: Response<UiResponse>) => {
      await submitCreateGoalStepTwo(
        req.body as CreateSubscriberGoalFormValues,
        "subscriber-goal",
        res,
      );
    },
  );
  router.post(
    internalRoutes.forms.createSubscribeOnly,
    async (req, res: Response<UiResponse>) => {
      await submitCreateGoalStepTwo(
        req.body as CreateSubscribeOnlyFormValues,
        "subscribe-only",
        res,
      );
    },
  );
  router.post(
    internalRoutes.forms.createCtaOnly,
    async (req, res: Response<UiResponse>) => {
      await submitCreateGoalStepTwo(
        req.body as CreateCtaOnlyFormValues,
        "cta-only",
        res,
      );
    },
  );
}

function registerCreateGoalFollowUpRoutes(router: Router): void {
  router.post(
    internalRoutes.forms.createSubscriberGoalFollowUp,
    async (req, res: Response<UiResponse>) => {
      await submitCreateGoalFollowUp(
        req.body as CreateSubscriberGoalFollowUpFormValues,
        "subscriber-goal",
        res,
      );
    },
  );
  router.post(
    internalRoutes.forms.createSubscribeOnlyFollowUp,
    async (req, res: Response<UiResponse>) => {
      await submitCreateGoalFollowUp(
        req.body as CreateSubscribeOnlyFollowUpFormValues,
        "subscribe-only",
        res,
      );
    },
  );
  router.post(
    internalRoutes.forms.createCtaOnlyFollowUp,
    async (req, res: Response<UiResponse>) => {
      await submitCreateGoalFollowUp(
        req.body as CreateCtaOnlyFollowUpFormValues,
        "cta-only",
        res,
      );
    },
  );
}

function registerCreateGoalMenuRoute(
  router: Router,
  route: string,
  defaultPostHeight: "regular" | "cta",
): void {
  router.post(route, async (_req, res: Response<UiResponse>) => {
    try {
      const creationAttemptId = createOperationId("create-goal");
      if (context.userId) {
        await saveCreateGoalDraft(redis, context.userId, {
          stage: "setup",
          creationAttemptId,
        });
      }
      res.json({
        showForm: await buildCreateGoalSetupForm(
          defaultPostHeight,
          creationAttemptId,
        ),
      });
    } catch (error) {
      logDiagnostic(
        "error",
        "internal_ui_failed",
        { workflow: "create_goal", phase: "setup_form" },
        error,
      );
      res.json({
        showToast: translate(
          await resolveCurrentSubredditLanguage(),
          "moderator.form.prepareSetupFailed",
        ),
      });
    }
  });
}

async function submitCreateGoalSetup(
  req: Request,
  res: Response<UiResponse>,
): Promise<void> {
  const callback = readCreationAttemptCallback(
    req.body as Record<string, unknown>,
    "postHeight",
  );
  const values = callback?.values as CreateGoalSetupFormValues | undefined;
  const creationAttemptId = callback?.creationAttemptId;
  const language = values?.language?.[0];
  const postHeight = values?.postHeight?.[0];
  const subredditDisplayName = values?.subredditDisplayName?.trim();
  const userId = context.userId;
  if (
    !values ||
    !language ||
    !subGoalLanguages.includes(language as (typeof subGoalLanguages)[number]) ||
    !postHeight ||
    !subGoalPostHeights.includes(
      postHeight as (typeof subGoalPostHeights)[number],
    )
  ) {
    res.json({
      showToast: translate(
        await resolveCurrentSubredditLanguage(),
        "moderator.form.invalidLanguageHeight",
      ),
    });
    return;
  }
  if (!userId) {
    res.json({
      showToast: translate(language, "moderator.form.loginRequired"),
    });
    return;
  }
  try {
    if (!creationAttemptId) {
      res.json({
        showToast: translate(language, "moderator.form.expired"),
      });
      return;
    }
    await withCreateGoalDraftLease(
      redis,
      userId,
      creationAttemptId,
      async () => {
        const existingDraft = await getCreateGoalDraft(
          redis,
          userId,
          creationAttemptId,
        );
        if (!existingDraft) {
          res.json({
            showToast: translate(language, "moderator.form.expired"),
          });
          return;
        }
        const subreddit = await reddit.getCurrentSubreddit();
        if (existingDraft.stage === "details") {
          res.json({
            showForm: buildCreateGoalDetailsForm(existingDraft, subreddit),
          });
          return;
        }
        if (existingDraft.stage === "follow-up") {
          res.json({
            showForm: buildCreateGoalFollowUpForm(existingDraft),
          });
          return;
        }
        const displayNameError = validateSubredditDisplayName(
          subredditDisplayName,
          subreddit.name,
          language,
        );
        if (displayNameError) {
          res.json({ showToast: displayNameError });
          return;
        }
        const draft = {
          stage: "details" as const,
          creationAttemptId,
          language: language as (typeof subGoalLanguages)[number],
          postHeight: postHeight as (typeof subGoalPostHeights)[number],
          subredditDisplayName: subredditDisplayName ?? subreddit.name,
          customDeveloperField: "",
        };
        await saveCreateGoalDraft(redis, userId, draft);
        res.json({
          showForm: buildCreateGoalDetailsForm(draft, subreddit),
        });
      },
    );
  } catch (error) {
    if (error instanceof CreateGoalDraftLeaseInProgressError) {
      res.json({
        showToast: translate(language, "errors.create.inProgress"),
      });
      return;
    }
    logDiagnostic(
      "error",
      "internal_ui_failed",
      { workflow: "create_goal", phase: "details_form" },
      error,
    );
    res.json({
      showToast: translate(language, "moderator.form.prepareDetailsFailed"),
    });
  }
}

function manualCreationOperationId(
  subredditId: string,
  userId: string,
  creationAttemptId: string,
): string {
  return `manual-v2:${subredditId}:${userId}:${creationAttemptId}`;
}

type CreateGoalPostKind = "subscriber-goal" | "subscribe-only" | "cta-only";

type CreateGoalDetailsValues =
  | CreateSubscriberGoalFormValues
  | CreateSubscribeOnlyFormValues
  | CreateCtaOnlyFormValues;

async function submitCreateGoalStepTwo(
  rawValues: CreateGoalDetailsValues,
  expectedKind: CreateGoalPostKind,
  res: Response<UiResponse>,
): Promise<void> {
  const userId = context.userId;
  let requestLanguage: unknown = await resolveCurrentSubredditLanguage();
  if (!userId) {
    await respondWithCreateGoalRestart(
      res,
      translate(requestLanguage, "moderator.form.restartLogin"),
    );
    return;
  }
  try {
    const callback = readCreationAttemptCallback(
      rawValues as Record<string, unknown>,
      "postTitle",
    );
    const values = callback?.values as CreateGoalDetailsValues | undefined;
    if (!callback || !values) {
      res.json({
        showToast: translate(requestLanguage, "moderator.form.expired"),
      });
      return;
    }
    await withCreateGoalDraftLease(
      redis,
      userId,
      callback.creationAttemptId,
      async () => {
        const savedDraft = await getCreateGoalDraft(
          redis,
          userId,
          callback.creationAttemptId,
        );
        const draft = savedDraft?.stage === "details" ? savedDraft : undefined;
        requestLanguage = draft?.language ?? requestLanguage;
        const draftKind =
          draft?.postHeight === "tiny"
            ? "subscribe-only"
            : draft?.postHeight === "cta"
              ? "cta-only"
              : "subscriber-goal";
        if (!draft || draftKind !== expectedKind) {
          res.json({
            showToast: translate(draft?.language, "moderator.form.expired"),
          });
          return;
        }

        const postTitle = values.postTitle?.trim();
        if (!postTitle) {
          res.json({
            showToast: translate(
              draft.language,
              "moderator.form.postTitleRequired",
            ),
          });
          return;
        }
        const maxPostTitleCharacters = 300;
        if (Array.from(postTitle).length > maxPostTitleCharacters) {
          res.json({
            showToast: translate(
              draft.language,
              "moderator.form.postTitleTooLong",
              {
                max: maxPostTitleCharacters,
              },
            ),
          });
          return;
        }
        const subreddit = await reddit.getCurrentSubreddit();
        const details = resolveDraftDetails(
          values,
          expectedKind,
          draft,
          subreddit,
          postTitle,
          res,
        );
        if (!details) return;

        const nextDraft = {
          stage: "follow-up" as const,
          creationAttemptId: draft.creationAttemptId,
          language: draft.language,
          postHeight: draft.postHeight,
          subredditDisplayName: draft.subredditDisplayName,
          customDeveloperField: draft.customDeveloperField,
          details,
        };
        await saveCreateGoalDraft(redis, userId, nextDraft);
        res.json({
          showForm: buildCreateGoalFollowUpForm({ version: 5, ...nextDraft }),
        });
      },
    );
  } catch (error) {
    if (error instanceof CreateGoalDraftLeaseInProgressError) {
      res.json({
        showToast: translate(requestLanguage, "errors.create.inProgress"),
      });
      return;
    }
    logDiagnostic(
      "error",
      "internal_ui_failed",
      { workflow: "create_goal", phase: "follow_up_form" },
      error,
    );
    res.json({
      showToast: translate(
        requestLanguage,
        "moderator.form.prepareFollowUpFailed",
      ),
    });
  }
}

async function submitCreateGoalFollowUp(
  rawValues: CreateGoalFollowUpValues,
  expectedKind: CreateGoalPostKind,
  res: Response<UiResponse>,
): Promise<void> {
  const userId = context.userId;
  let requestLanguage: unknown = await resolveCurrentSubredditLanguage();
  if (!userId) {
    await respondWithCreateGoalRestart(
      res,
      translate(requestLanguage, "moderator.form.restartLogin"),
    );
    return;
  }
  try {
    const callback = readCreationAttemptCallback(
      rawValues as Record<string, unknown>,
      "afterSubscribeButtonText",
    );
    const values = callback?.values as CreateGoalFollowUpValues | undefined;
    if (!callback || !values) {
      res.json({
        showToast: translate(requestLanguage, "moderator.form.expired"),
      });
      return;
    }
    await withCreateGoalDraftLease(
      redis,
      userId,
      callback.creationAttemptId,
      async () => {
        const savedDraft = await getCreateGoalDraft(
          redis,
          userId,
          callback.creationAttemptId,
        );
        const draft =
          savedDraft?.stage === "follow-up" ? savedDraft : undefined;
        requestLanguage = draft?.language ?? requestLanguage;
        if (!draft || draft.details.kind !== expectedKind) {
          await respondToMissingFollowUpDraft(
            callback,
            userId,
            draft?.language,
            res,
          );
          return;
        }

        const prepared = await prepareFollowUpCreation(
          values,
          draft,
          userId,
          res,
        );
        if (!prepared) return;
        await createFromFollowUpDraft(values, draft, userId, res, prepared);
      },
    );
  } catch (error) {
    if (error instanceof CreateGoalDraftLeaseInProgressError) {
      res.json({
        showToast: translate(requestLanguage, "errors.create.inProgress"),
      });
      return;
    }
    logDiagnostic(
      "error",
      "create_goal_failed",
      {
        workflow: "create_goal",
        phase: "post_creation",
        postId: context.postId,
      },
      error,
    );
    res.json({
      showToast:
        error instanceof ProhibitedSubredditError ||
        error instanceof SubscriberGoalActorAuthorizationError ||
        error instanceof SubscriberGoalModeratorPermissionError ||
        error instanceof SubscriberGoalCreationInProgressError ||
        error instanceof SubscriberGoalCreationOutcomeUnknownError
          ? error.message
          : translate(requestLanguage, "moderator.form.creationFailed"),
    });
  }
}

function resolvePresetActionInput(
  preset: AfterSubscribePreset,
  subredditName: string,
  submittedUrl: string | undefined,
): { type: AfterSubscribeActionType; url?: string } {
  if (preset === "top-post-day" || preset === "newest-post") {
    return { type: preset };
  }
  if (preset === "create-post" || preset === "share-picture") {
    return {
      type: "link",
      url: `https://www.reddit.com/r/${subredditName}/submit/`,
    };
  }
  return {
    type: "link",
    ...(submittedUrl !== undefined ? { url: submittedUrl } : {}),
  };
}

async function respondWithCreateGoalRestart(
  res: Response<UiResponse>,
  showToast: string,
): Promise<void> {
  try {
    const creationAttemptId = createOperationId("create-goal");
    if (context.userId) {
      await saveCreateGoalDraft(redis, context.userId, {
        stage: "setup",
        creationAttemptId,
      });
    }
    res.json({
      showToast,
      showForm: await buildCreateGoalSetupForm("regular", creationAttemptId),
    });
  } catch (error) {
    logDiagnostic(
      "error",
      "internal_ui_failed",
      { workflow: "create_goal", phase: "restart_form" },
      error,
    );
    res.json({ showToast });
  }
}

async function safelyDeleteCreateGoalDraft(
  userId: string,
  creationAttemptId: string,
): Promise<void> {
  try {
    await deleteCreateGoalDraft(redis, userId, creationAttemptId);
  } catch (error) {
    logDiagnostic(
      "warn",
      "create_goal_draft_cleanup_failed",
      { workflow: "create_goal", phase: "completed_draft_cleanup" },
      error,
    );
  }
}

async function resolveCurrentUsername(): Promise<string | undefined> {
  try {
    const username = await reddit.getCurrentUsername();
    if (username) {
      return username;
    }
  } catch (error) {
    logDiagnostic(
      "warn",
      "username_resolution_failed",
      { workflow: "highlight_notification", phase: "username_lookup" },
      error,
    );
  }

  return undefined;
}

async function submitExperimentalSelfPost(
  subreddit: {
    name: string;
    numberOfSubscribers: number;
    language?: unknown;
  },
  res: Response<UiResponse>,
): Promise<boolean> {
  let username: string | undefined;
  try {
    username = await reddit.getCurrentUsername();
  } catch (error) {
    logDiagnostic(
      "warn",
      "developer_command_failed",
      { workflow: "self_post", phase: "username_lookup" },
      error,
    );
  }

  if (!username) {
    res.json({
      showToast: translate(
        subreddit.language,
        "moderator.developer.loginRequired",
      ),
    });
    return false;
  }

  const targetSubreddit = `u_${username}`;
  const title = translate(subreddit.language, "moderator.developer.title", {
    subredditName: subreddit.name,
  });
  const text = translate(subreddit.language, "moderator.developer.body", {
    subredditName: subreddit.name,
    subscriberCount: subreddit.numberOfSubscribers,
    username,
    targetSubreddit,
  });

  try {
    const post = await reddit.submitPost({
      subredditName: targetSubreddit,
      title,
      text,
      runAs: "USER",
    });
    const postUrl =
      getPostUrl(post) ??
      (post.id
        ? `https://reddit.com/r/${targetSubreddit}/comments/${post.id}`
        : undefined);

    res.json({
      showToast: translate(subreddit.language, "moderator.developer.success", {
        targetSubreddit,
      }),
      ...(postUrl ? { navigateTo: postUrl } : {}),
    });
    return true;
  } catch (error) {
    logDiagnostic(
      "error",
      "developer_command_failed",
      { workflow: "self_post", phase: "submission" },
      error,
    );
    res.json({
      showToast: translate(subreddit.language, "moderator.developer.failed"),
    });
    return false;
  }
}

function resolveDraftDetails(
  values: CreateGoalDetailsValues,
  expectedKind: CreateGoalPostKind,
  draft: Extract<CreateGoalDraft, { stage: "details" }>,
  subreddit: Awaited<ReturnType<typeof reddit.getCurrentSubreddit>>,
  postTitle: string,
  res: Response<UiResponse>,
): CreateGoalDraftDetails | undefined {
  const colorTheme = resolveSubGoalColorTheme(
    "colorTheme" in values ? values.colorTheme?.[0] : undefined,
  );
  const requestedPreset = values.afterSubscribePreset?.[0];
  const isNsfw = isNsfwOrUnknown(subreddit.nsfw);
  const afterSubscribePreset =
    isAfterSubscribePreset(requestedPreset) &&
    !(isNsfw && requestedPreset === "top-post-day")
      ? requestedPreset
      : getDefaultAfterSubscribePreset(subreddit.type, isNsfw);
  let details: CreateGoalDraftDetails;
  if (expectedKind === "subscribe-only") {
    details = {
      kind: "subscribe-only",
      postTitle,
      colorTheme,
      afterSubscribePreset,
    };
  } else if (expectedKind === "cta-only") {
    details = {
      kind: "cta-only",
      postTitle,
      afterSubscribePreset,
    };
  } else {
    const subscriberGoal =
      "subscriberGoal" in values ? values.subscriberGoal : undefined;
    if (
      typeof subscriberGoal !== "number" ||
      !Number.isFinite(subscriberGoal) ||
      subscriberGoal <= 0
    ) {
      res.json({
        showToast: translate(draft.language, "moderator.form.goalInvalid"),
      });
      return;
    }
    if (subreddit.numberOfSubscribers >= subscriberGoal) {
      res.json({
        showToast: translate(
          draft.language,
          "moderator.form.goalNotAboveCurrent",
        ),
      });
      return;
    }
    const appSettings = getAppSettings();
    const crosspostEligible = isCrosspostEligible(
      subreddit,
      appSettings.promoSubreddit,
    );
    details = {
      kind: "subscriber-goal",
      postTitle,
      subscriberGoal,
      colorTheme,
      crosspost:
        crosspostEligible && "crosspost" in values && values.crosspost === true,
      afterSubscribePreset,
    };
  }
  return details;
}

type FollowUpDraft = Extract<CreateGoalDraft, { stage: "follow-up" }>;

async function respondToMissingFollowUpDraft(
  callback: { creationAttemptId: string } | undefined,
  userId: NonNullable<typeof context.userId>,
  language: SubGoalLanguage | undefined,
  res: Response<UiResponse>,
): Promise<void> {
  if (callback) {
    const subreddit = await reddit.getCurrentSubreddit();
    const recovery = await recoverSubscriberGoalCreation({
      reddit,
      redis,
      operationId: manualCreationOperationId(
        subreddit.id,
        userId,
        callback.creationAttemptId,
      ),
      actorUserId: userId,
      subredditId: subreddit.id,
      subredditName: subreddit.name,
    });
    if (recovery.status === "complete") {
      res.json({
        showToast: translate(language, "moderator.create.success", {
          postType: translate(language, "moderator.create.goalLabel"),
        }),
        navigateTo: `https://reddit.com/r/${subreddit.name}/comments/${recovery.result.post.id}`,
      });
      return;
    }
    if (recovery.status === "unknown") {
      res.json({
        showToast: translate(language, "errors.create.outcomeUnknownExpired"),
      });
      return;
    }
    if (recovery.status === "superseded" || recovery.status === "retired") {
      res.json({
        showToast: translate(language, "moderator.form.expired"),
      });
      return;
    }
  }
  res.json({
    showToast: translate(language, "moderator.form.expired"),
  });
  return;
}

async function prepareFollowUpCreation(
  values: CreateGoalFollowUpValues,
  draft: FollowUpDraft,
  userId: NonNullable<typeof context.userId>,
  res: Response<UiResponse>,
) {
  const developerCommands = parseDeveloperCommands(
    values.customDeveloperField ?? "",
  );
  for (const command of developerCommands.ignoredCommands) {
    console.info(
      `[developerField] ignored unknown create-goal command: command=${command}`,
    );
  }
  for (const warning of developerCommands.warnings) {
    logDiagnostic("warn", "developer_command_warning", {
      workflow: "developer_command",
      phase: "validation",
      category: warning,
    });
  }

  const subreddit = await reddit.getCurrentSubreddit();
  const displayNameError = validateSubredditDisplayName(
    draft.subredditDisplayName,
    subreddit.name,
    draft.language,
  );
  if (displayNameError) {
    res.json({ showToast: displayNameError });
    return;
  }
  if (
    draft.details.kind === "subscriber-goal" &&
    subreddit.numberOfSubscribers >= draft.details.subscriberGoal
  ) {
    res.json({
      showToast: translate(
        draft.language,
        "moderator.form.goalNotAboveCurrent",
      ),
    });
    return;
  }
  if (developerCommands.selfPost) {
    const actorAuthority = await requireCurrentActorAuthority({
      requirement: "manage-posts",
      language: draft.language,
    });
    if (!actorAuthority.authorized) {
      res.json({ showToast: actorAuthority.message });
      return;
    }
    const submitted = await submitExperimentalSelfPost(subreddit, res);
    if (submitted) {
      await safelyDeleteCreateGoalDraft(userId, draft.creationAttemptId);
    }
    return;
  }
  return { subreddit, developerCommands };
}

async function createFromFollowUpDraft(
  values: CreateGoalFollowUpValues,
  draft: FollowUpDraft,
  userId: NonNullable<typeof context.userId>,
  res: Response<UiResponse>,
  {
    subreddit,
    developerCommands,
  }: NonNullable<Awaited<ReturnType<typeof prepareFollowUpCreation>>>,
): Promise<void> {
  const presetChanged =
    draft.details.afterSubscribePreset === "top-post-day" &&
    isNsfwOrUnknown(subreddit.nsfw);
  const persistedAfterSubscribePreset = presetChanged
    ? "newest-post"
    : draft.details.afterSubscribePreset;
  const presetDefaults = getAfterSubscribePresetDefaults(
    persistedAfterSubscribePreset,
    draft.language,
  );
  const resolvedActionInput = resolvePresetActionInput(
    persistedAfterSubscribePreset,
    subreddit.name,
    values.afterSubscribeUrl,
  );
  const afterSubscribeResult = resolveAfterSubscribeAction({
    type: resolvedActionInput.type,
    buttonText: presetChanged
      ? presetDefaults.buttonText
      : (values.afterSubscribeButtonText ?? presetDefaults.buttonText),
    url: resolvedActionInput.url,
    colorTheme:
      values.afterSubscribeColorTheme?.[0] ?? presetDefaults.colorTheme,
    fallbackColorTheme:
      draft.details.kind === "cta-only"
        ? defaultAfterSubscribeColorTheme
        : draft.details.colorTheme,
  });
  if (afterSubscribeResult.invalidConfiguration) {
    res.json({
      showToast: translate(
        draft.language,
        "moderator.form.actionConfigurationInvalid",
      ),
      showForm: buildCreateGoalFollowUpForm(draft, values),
    });
    return;
  }
  const appSettings = getAppSettings();
  const crosspostEligible = isCrosspostEligible(
    subreddit,
    appSettings.promoSubreddit,
  );
  const crosspostBecameIneligible =
    draft.details.kind === "subscriber-goal" &&
    draft.details.crosspost &&
    !crosspostEligible;
  const crosspost =
    draft.details.kind === "subscriber-goal" &&
    draft.details.crosspost &&
    crosspostEligible;
  const creation = await createSubscriberGoal({
    reddit,
    redis,
    appSettings,
    options: {
      title: draft.details.postTitle,
      ...(draft.details.kind === "subscriber-goal"
        ? { goal: draft.details.subscriberGoal }
        : {}),
      subredditDisplayName: draft.subredditDisplayName,
      crosspost,
      colorTheme:
        draft.details.kind === "cta-only" &&
        afterSubscribeResult.action.type !== "disabled"
          ? afterSubscribeResult.action.colorTheme
          : draft.details.kind === "cta-only"
            ? defaultAfterSubscribeColorTheme
            : draft.details.colorTheme,
      postHeight: draft.postHeight,
      autoCreateNextGoal: draft.details.kind === "subscriber-goal",
      language: draft.language,
      afterSubscribeAction: afterSubscribeResult.action,
      afterSubscribePreset: persistedAfterSubscribePreset,
      cancelPendingAutoCreateGoals: true,
      operationId: manualCreationOperationId(
        subreddit.id,
        userId,
        draft.creationAttemptId,
      ),
      manualActorUserId: userId,
      submitAsUser: developerCommands.submitAsUser,
      ...(developerCommands.headerText
        ? { headerText: developerCommands.headerText }
        : {}),
    },
  });
  await respondToCreatedGoal({
    creation,
    appSettings,
    subreddit,
    draft,
    userId,
    crosspost,
    crosspostBecameIneligible,
    res,
  });
}

async function respondToCreatedGoal({
  creation,
  appSettings,
  subreddit,
  draft,
  userId,
  crosspost,
  crosspostBecameIneligible,
  res,
}: {
  creation: Awaited<ReturnType<typeof createSubscriberGoal>>;
  appSettings: ReturnType<typeof getAppSettings>;
  subreddit: Awaited<ReturnType<typeof reddit.getCurrentSubreddit>>;
  draft: FollowUpDraft;
  userId: NonNullable<typeof context.userId>;
  crosspost: boolean;
  crosspostBecameIneligible: boolean;
  res: Response<UiResponse>;
}): Promise<void> {
  if (creation.outcome === "superseded" || creation.outcome === "retired") {
    await safelyDeleteCreateGoalDraft(userId, draft.creationAttemptId);
    res.json({
      showToast: translate(draft.language, "moderator.form.expired"),
    });
    return;
  }
  const { post, crosspostDispatchResult, highlightResult, flairResult } =
    creation;

  await safelyDeleteCreateGoalDraft(userId, draft.creationAttemptId);
  console.info(
    `[crosspost] goal post created: postId=${post.id} subreddit=${subreddit.name} promoSubreddit=${appSettings.promoSubreddit} crosspost=${crosspost}`,
  );
  if (highlightResult.issues.length > 0) {
    logDiagnostic("warn", "manual_goal_highlight_degraded", {
      workflow: "internal_ui",
      phase: "highlight",
      postId: post.id,
      failureCategories: highlightResult.issues
        .map(({ category }) => category)
        .join(","),
      capacityOutcome: highlightResult.capacityOutcome,
      cleanupOutcome: highlightResult.cleanupOutcome,
      rollbackOutcome: highlightResult.rollbackOutcome,
    });
    const moderatorUsername = await resolveCurrentUsername();
    await notifyHighlightFailure({
      reddit,
      subredditId: subreddit.id,
      subredditName: subreddit.name,
      moderatorUsername,
      postTitle: post.title ?? draft.details.postTitle,
      postUrl: getPostUrl(post),
      errorMessage: highlightResult.errorMessage,
      highlightResult,
      language: draft.language,
    });
  }

  const createdPostLabel =
    draft.details.kind === "cta-only"
      ? translate(draft.language, "moderator.create.ctaLabel")
      : translate(draft.language, "moderator.create.goalLabel");
  const baseToast =
    highlightResult.issues.length > 0
      ? translate(draft.language, "moderator.create.degraded", {
          postType: createdPostLabel,
          details: describeHighlightResult(highlightResult, draft.language),
        })
      : crosspostDispatchResult.status === "failed"
        ? translate(draft.language, "moderator.create.crosspostFailed", {
            postType: createdPostLabel,
            subredditName: appSettings.promoSubreddit,
          })
        : translate(draft.language, "moderator.create.success", {
            postType: createdPostLabel,
          });
  const flairWarning =
    flairResult.status === "omitted"
      ? ` ${translate(draft.language, "moderator.create.flairWarning")}`
      : "";
  const crosspostEligibilityWarning = crosspostBecameIneligible
    ? ` ${translate(draft.language, "moderator.create.crosspostIneligible")}`
    : "";
  res.json({
    showToast: `${baseToast}${flairWarning}${crosspostEligibilityWarning}`,
    navigateTo: `https://reddit.com/r/${subreddit.name}/comments/${post.id}`,
  });
}
