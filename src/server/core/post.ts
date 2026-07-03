import { EntrypointHeight, reddit } from "@devvit/web/server";
import type { SubGoalPostHeight } from "../../shared/subGoalPostHeight";
import {
  resolveSubGoalPostHeight,
  shortSubGoalPostHeightPixels,
} from "../../shared/subGoalPostHeight";

type CreateGoalPostParams = {
  title: string;
  subredditName: string;
  textFallback: string;
  postHeight?: SubGoalPostHeight;
  submitAsUser?: boolean;
};

export const createGoalPost = async ({
  title,
  subredditName,
  textFallback,
  submitAsUser = false,
}: CreateGoalPostParams) => {
  return await reddit.submitCustomPost({
    title,
    subredditName,
    entry: "default",
    styles: { height: EntrypointHeight.REGULAR },
    textFallback: { text: textFallback },
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
  if (resolveSubGoalPostHeight(postHeight) !== "short") {
    return;
  }
  if (typeof post.setCustomPostStyles !== "function") {
    console.warn(
      `[postHeight] cannot apply short post height; post.setCustomPostStyles is unavailable: postId=${post.id ?? "unknown"}`,
    );
    return;
  }

  try {
    await post.setCustomPostStyles({
      height: EntrypointHeight.HEIGHT_UNSPECIFIED,
      heightPixels: shortSubGoalPostHeightPixels,
    });
  } catch (error) {
    console.warn(
      `[postHeight] failed to apply short post height: postId=${post.id ?? "unknown"} error=${String(error)}`,
    );
  }
}
