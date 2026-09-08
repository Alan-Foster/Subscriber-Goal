import { EntrypointHeight, reddit } from "@devvit/web/server";
import type { SubGoalPostHeight } from "../../shared/subGoalPostHeight";
import { logDiagnostic } from "../../shared/diagnostics";
import {
  resolveSubGoalPostHeight,
  shortSubGoalPostHeightPixels,
  tinySubGoalPostHeightPixels,
} from "../../shared/subGoalPostHeight";
import {
  ctaOnlyPostKind,
  subscriberGoalPostKind,
  subscribeOnlyPostKind,
} from "../../shared/postKind";

type CreateGoalPostParams = {
  title: string;
  subredditName: string;
  textFallback: string;
  postHeight?: SubGoalPostHeight;
  submitAsUser?: boolean;
  flairId?: string;
};

export const createGoalPost = async ({
  title,
  subredditName,
  textFallback,
  postHeight = "regular",
  submitAsUser = false,
  flairId,
}: CreateGoalPostParams) => {
  const isCompactActionPost = postHeight === "tiny" || postHeight === "cta";
  return await reddit.submitCustomPost({
    title,
    subredditName,
    entry: isCompactActionPost ? "subscribe-only" : "default",
    postData: {
      postKind:
        postHeight === "cta"
          ? ctaOnlyPostKind
          : postHeight === "tiny"
            ? subscribeOnlyPostKind
            : subscriberGoalPostKind,
    },
    styles: isCompactActionPost
      ? {
          height: EntrypointHeight.HEIGHT_UNSPECIFIED,
          heightPixels: tinySubGoalPostHeightPixels,
        }
      : { height: EntrypointHeight.REGULAR },
    textFallback: { text: textFallback },
    ...(flairId ? { flairId } : {}),
    ...(submitAsUser
      ? {
          runAs: "USER" as const,
          userGeneratedContent: {
            text: `Subscriber Goal post: ${title}`,
          },
        }
      : {}),
  });
};

type CustomPostStyleTarget = {
  id?: string;
  setCustomPostStyles?: (styles: {
    height?: EntrypointHeight;
    heightPixels?: number;
  }) => Promise<void>;
};

export async function applyGoalPostFrameStyle(
  post: CustomPostStyleTarget,
  postHeight: SubGoalPostHeight,
): Promise<void> {
  const resolvedPostHeight = resolveSubGoalPostHeight(postHeight);
  if (resolvedPostHeight === "regular") {
    return;
  }
  const heightPixels =
    resolvedPostHeight === "tiny" || resolvedPostHeight === "cta"
      ? tinySubGoalPostHeightPixels
      : shortSubGoalPostHeightPixels;
  if (typeof post.setCustomPostStyles !== "function") {
    logDiagnostic("warn", "post_style_unavailable", {
      workflow: "post_style",
      phase: "set_height",
      postId: post.id,
      category: resolvedPostHeight,
    });
    return;
  }

  try {
    await post.setCustomPostStyles({
      height: EntrypointHeight.HEIGHT_UNSPECIFIED,
      heightPixels,
    });
  } catch (error) {
    logDiagnostic(
      "warn",
      "post_style_failed",
      { workflow: "post_style", phase: "set_height", postId: post.id },
      error,
    );
  }
}
