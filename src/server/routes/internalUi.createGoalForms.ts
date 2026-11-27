import type { UiResponse } from "@devvit/web/shared";
import { reddit, redis } from "@devvit/web/server";
import {
  defaultSubGoalColorTheme,
  subGoalColorThemes,
} from "../../shared/subGoalColorTheme";
import {
  getAfterSubscribePresetMessages,
  getSubGoalPostMessages,
  defaultSubGoalLanguage,
  resolveSubGoalLanguage,
  subGoalLanguages,
  type SubGoalLanguage,
} from "../../shared/subGoalPostI18n";
import { getLanguageMetadata } from "../../shared/i18n/catalog";
import { formNames } from "../../shared/routes";
import type { CreateGoalDraft } from "../data/createGoalDraft";
import { getSavedSubredditDisplayName } from "../data/subredditDisplayNameData";
import { getAppSettings } from "../settings";
import { getDefaultSubscriberGoal } from "../utils/numberUtils";
import { createOperationId } from "../../shared/diagnostics";
import { isCrosspostEligible, isNsfwOrUnknown } from "../utils/subredditSafety";
import { translate } from "../../shared/i18n/catalog";
import {
  defaultAfterSubscribeColorTheme,
  getDefaultAfterSubscribePreset,
  type AfterSubscribePreset,
} from "../../shared/afterSubscribeAction";
import {
  creationAttemptFieldName,
  type CreateGoalFollowUpValues,
} from "./internalUi.createGoalFields";

export async function buildCreateGoalSetupForm(
  initialPostHeight: "regular" | "cta" = "regular",
  creationAttemptId = createOperationId("create-goal"),
): Promise<NonNullable<UiResponse["showForm"]>> {
  const subreddit = await reddit.getCurrentSubreddit();
  const defaultLanguage = resolveSubGoalLanguage(subreddit.language);
  const savedDisplayName = await getSavedSubredditDisplayName(redis);
  return {
    name: formNames.createGoalSetup,
    form: {
      title: translate(defaultLanguage, "moderator.setup.title"),
      description: translate(defaultLanguage, "moderator.setup.description"),
      acceptLabel: translate(defaultLanguage, "moderator.common.next"),
      cancelLabel: translate(defaultLanguage, "moderator.common.cancel"),
      fields: [
        {
          name: "language",
          label: translate(defaultLanguage, "moderator.setup.language"),
          type: "select",
          defaultValue: [defaultLanguage],
          options: subGoalLanguages.map((language) => ({
            label: getLanguageMetadata(language).label,
            value: language,
          })),
          helpText: translate(defaultLanguage, "moderator.setup.languageHelp"),
          required: true,
        },
        {
          name: "subredditDisplayName",
          label: translate(defaultLanguage, "moderator.setup.displayName"),
          type: "string",
          defaultValue: savedDisplayName ?? subreddit.name,
          helpText: translate(
            defaultLanguage,
            "moderator.setup.displayNameHelp",
          ),
          required: true,
        },
        {
          name: creationAttemptFieldName("postHeight", creationAttemptId),
          label: translate(defaultLanguage, "moderator.setup.postHeight"),
          type: "select",
          defaultValue: [initialPostHeight],
          options: [
            {
              label: translate(defaultLanguage, "moderator.setup.regular"),
              value: "regular",
            },
            {
              label: translate(defaultLanguage, "moderator.setup.short"),
              value: "short",
            },
            {
              label: translate(defaultLanguage, "moderator.setup.tiny"),
              value: "tiny",
            },
            {
              label: translate(defaultLanguage, "moderator.setup.cta"),
              value: "cta",
            },
          ],
          helpText: translate(defaultLanguage, "moderator.setup.help"),
          required: true,
        },
      ],
    },
  };
}

export function buildCreateGoalDetailsForm(
  draft: Pick<
    Extract<CreateGoalDraft, { stage: "details" }>,
    "creationAttemptId" | "language" | "postHeight" | "subredditDisplayName"
  >,
  subreddit: {
    name: string;
    numberOfSubscribers: number;
    type?: unknown;
    nsfw?: unknown;
  },
): NonNullable<UiResponse["showForm"]> {
  const defaultPostTitle = getSubGoalPostMessages(
    draft.language,
  ).defaultPostTitle({ subredditName: draft.subredditDisplayName });
  const commonFields = {
    postTitle: {
      name: creationAttemptFieldName("postTitle", draft.creationAttemptId),
      label: translate(draft.language, "moderator.details.postTitle"),
      type: "string" as const,
      defaultValue: defaultPostTitle,
      helpText: translate(draft.language, "moderator.details.postTitleHelp"),
      required: true,
    },
  };
  const colorOptions = getColorOptions(draft.language);

  if (draft.postHeight === "tiny") {
    return {
      name: formNames.createSubscribeOnly,
      form: {
        title: translate(draft.language, "moderator.details.joinOnlyTitle"),
        description: translate(
          draft.language,
          "moderator.details.joinOnlyDescription",
        ),
        acceptLabel: translate(draft.language, "moderator.common.next"),
        cancelLabel: translate(draft.language, "moderator.common.cancel"),
        fields: [
          commonFields.postTitle,
          {
            name: "colorTheme",
            label: translate(draft.language, "moderator.details.joinColor"),
            type: "select",
            defaultValue: [defaultSubGoalColorTheme],
            options: colorOptions,
            helpText: translate(
              draft.language,
              "moderator.details.joinColorHelp",
            ),
            required: true,
          },
          getAfterSubscribeActionField(
            subreddit,
            "after-subscribe",
            draft.language,
          ),
        ],
      },
    };
  }

  if (draft.postHeight === "cta") {
    return {
      name: formNames.createCtaOnly,
      form: {
        title: translate(draft.language, "moderator.details.ctaTitle"),
        description: translate(
          draft.language,
          "moderator.details.ctaDescription",
        ),
        acceptLabel: translate(draft.language, "moderator.common.next"),
        cancelLabel: translate(draft.language, "moderator.common.cancel"),
        fields: [
          commonFields.postTitle,
          getAfterSubscribeActionField(subreddit, "cta", draft.language),
        ],
      },
    };
  }

  const appSettings = getAppSettings();
  const shouldCrosspost = isCrosspostEligible(
    subreddit,
    appSettings.promoSubreddit,
  );

  return {
    name: formNames.createSubscriberGoal,
    form: {
      title: translate(draft.language, "moderator.details.goalTitle"),
      description: translate(
        draft.language,
        "moderator.details.goalDescription",
        { height: draft.postHeight === "short" ? "Short" : "Regular" },
      ),
      acceptLabel: translate(draft.language, "moderator.common.next"),
      cancelLabel: translate(draft.language, "moderator.common.cancel"),
      fields: [
        commonFields.postTitle,
        {
          name: "subscriberGoal",
          label: translate(draft.language, "moderator.details.goal"),
          type: "number",
          defaultValue: getDefaultSubscriberGoal(subreddit.numberOfSubscribers),
          helpText: translate(draft.language, "moderator.details.goalHelp"),
          required: true,
        },
        {
          name: "colorTheme",
          label: translate(draft.language, "moderator.details.joinColor"),
          type: "select",
          defaultValue: [defaultSubGoalColorTheme],
          options: colorOptions,
          helpText: translate(
            draft.language,
            "moderator.details.goalColorHelp",
          ),
          required: true,
        },
        getAfterSubscribeActionField(
          subreddit,
          "after-subscribe",
          draft.language,
        ),
        ...(shouldCrosspost
          ? [
              {
                name: "crosspost",
                label: translate(
                  draft.language,
                  "moderator.details.crosspost",
                  { subredditName: appSettings.promoSubreddit },
                ),
                type: "boolean" as const,
                helpText: translate(
                  draft.language,
                  "moderator.details.crosspostHelp",
                  { subredditName: appSettings.promoSubreddit },
                ),
                defaultValue: true,
              },
            ]
          : []),
      ],
    },
  };
}

export function buildCreateGoalFollowUpForm(
  draft: Extract<CreateGoalDraft, { stage: "follow-up" }>,
  submittedValues?: CreateGoalFollowUpValues,
): NonNullable<UiResponse["showForm"]> {
  const presetDefaults = getAfterSubscribePresetDefaults(
    draft.details.afterSubscribePreset,
    draft.language,
  );
  const isCtaOnly = draft.details.kind === "cta-only";
  const submittedButtonText = submittedValues?.afterSubscribeButtonText;
  const submittedUrl = submittedValues?.afterSubscribeUrl;
  const submittedColorTheme = submittedValues?.afterSubscribeColorTheme;
  const sharedFields = [
    {
      name: creationAttemptFieldName(
        "afterSubscribeButtonText",
        draft.creationAttemptId,
      ),
      label: isCtaOnly
        ? translate(draft.language, "moderator.followUp.ctaText")
        : translate(draft.language, "moderator.followUp.buttonText"),
      type: "string" as const,
      ...(submittedButtonText !== undefined || presetDefaults.buttonText
        ? { defaultValue: submittedButtonText ?? presetDefaults.buttonText }
        : {}),
      helpText: translate(draft.language, "moderator.followUp.textHelp"),
      required: true,
    },
    ...(presetDefaults.showUrl
      ? [
          {
            name: "afterSubscribeUrl",
            label: translate(draft.language, "moderator.followUp.url"),
            type: "string" as const,
            ...(submittedUrl !== undefined
              ? { defaultValue: submittedUrl }
              : {}),
            helpText: translate(draft.language, "moderator.followUp.urlHelp"),
            required: true,
          },
        ]
      : []),
    {
      name: "afterSubscribeColorTheme",
      label: isCtaOnly
        ? translate(draft.language, "moderator.followUp.ctaColor")
        : translate(draft.language, "moderator.followUp.buttonColor"),
      type: "select" as const,
      defaultValue: submittedColorTheme ?? [presetDefaults.colorTheme],
      options: getColorOptions(draft.language),
      helpText: translate(draft.language, "moderator.followUp.buttonColorHelp"),
      required: true,
    },
  ];

  if (draft.details.kind === "subscribe-only") {
    return {
      name: formNames.createSubscribeOnlyFollowUp,
      form: {
        title: translate(draft.language, "moderator.followUp.title"),
        description: translate(
          draft.language,
          "moderator.followUp.description",
        ),
        acceptLabel: translate(draft.language, "moderator.common.create"),
        cancelLabel: translate(draft.language, "moderator.common.cancel"),
        fields: sharedFields,
      },
    };
  }

  if (draft.details.kind === "cta-only") {
    return {
      name: formNames.createCtaOnlyFollowUp,
      form: {
        title: translate(draft.language, "moderator.followUp.ctaTitle"),
        description: translate(
          draft.language,
          "moderator.followUp.ctaDescription",
        ),
        acceptLabel: translate(draft.language, "moderator.common.create"),
        cancelLabel: translate(draft.language, "moderator.common.cancel"),
        fields: sharedFields,
      },
    };
  }

  return {
    name: formNames.createSubscriberGoalFollowUp,
    form: {
      title: translate(draft.language, "moderator.followUp.goalTitle"),
      description: translate(
        draft.language,
        "moderator.followUp.goalDescription",
      ),
      acceptLabel: translate(draft.language, "moderator.common.create"),
      cancelLabel: translate(draft.language, "moderator.common.cancel"),
      fields: sharedFields,
    },
  };
}

function getColorOptions(
  language: SubGoalLanguage = defaultSubGoalLanguage,
): Array<{ label: string; value: string }> {
  const labels: Record<(typeof subGoalColorThemes)[number], string> = {
    red: translate(language, "moderator.color.red"),
    green: translate(language, "moderator.color.green"),
    purple: translate(language, "moderator.color.purple"),
    blue: translate(language, "moderator.color.blue"),
    pink: translate(language, "moderator.color.pink"),
  };
  return subGoalColorThemes.map((value) => ({ label: labels[value], value }));
}

function getAfterSubscribeActionField(
  subreddit: { type?: unknown; nsfw?: unknown },
  context: "after-subscribe" | "cta" = "after-subscribe",
  language: SubGoalLanguage = defaultSubGoalLanguage,
) {
  const isNsfw = isNsfwOrUnknown(subreddit.nsfw);
  const options = [
    {
      label: translate(language, "moderator.followUp.topPost"),
      value: "top-post-day",
    },
    {
      label: translate(language, "moderator.followUp.newestPost"),
      value: "newest-post",
    },
    {
      label: translate(language, "moderator.followUp.createPost"),
      value: "create-post",
    },
    {
      label: translate(language, "moderator.followUp.sharePicture"),
      value: "share-picture",
    },
    {
      label: translate(language, "moderator.followUp.discord"),
      value: "discord",
    },
    {
      label: translate(language, "moderator.followUp.web"),
      value: "web-link",
    },
    {
      label: translate(language, "moderator.followUp.wiki"),
      value: "wiki",
    },
  ].filter(({ value }) => !isNsfw || value !== "top-post-day");
  return {
    name: "afterSubscribePreset",
    label:
      context === "cta"
        ? translate(language, "moderator.followUp.actionCta")
        : translate(language, "moderator.followUp.action"),
    type: "select" as const,
    defaultValue: [getDefaultAfterSubscribePreset(subreddit.type, isNsfw)],
    options,
    helpText:
      context === "cta"
        ? translate(language, "moderator.followUp.actionCtaHelp")
        : translate(language, "moderator.followUp.actionHelp"),
    required: true,
  };
}

export function getAfterSubscribePresetDefaults(
  preset: AfterSubscribePreset,
  language: (typeof subGoalLanguages)[number],
): {
  buttonText: string;
  colorTheme: (typeof subGoalColorThemes)[number];
  showUrl: boolean;
} {
  const messages = getAfterSubscribePresetMessages(language);
  switch (preset) {
    case "discord":
      return {
        buttonText: messages.joinDiscord,
        colorTheme: defaultAfterSubscribeColorTheme,
        showUrl: true,
      };
    case "top-post-day":
      return {
        buttonText: messages.viewTopPostToday,
        colorTheme: defaultAfterSubscribeColorTheme,
        showUrl: false,
      };
    case "wiki":
      return {
        buttonText: messages.readWiki,
        colorTheme: defaultAfterSubscribeColorTheme,
        showUrl: true,
      };
    case "create-post":
      return {
        buttonText: messages.createNewPost,
        colorTheme: defaultAfterSubscribeColorTheme,
        showUrl: false,
      };
    case "share-picture":
      return {
        buttonText: messages.sharePicture,
        colorTheme: defaultAfterSubscribeColorTheme,
        showUrl: false,
      };
    case "newest-post":
      return {
        buttonText: messages.viewMostRecentPostToday,
        colorTheme: defaultAfterSubscribeColorTheme,
        showUrl: false,
      };
    case "web-link":
      return {
        buttonText: "",
        colorTheme: defaultAfterSubscribeColorTheme,
        showUrl: true,
      };
  }
}
