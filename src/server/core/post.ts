import { reddit } from "@devvit/web/server";

type CreateGoalPostParams = {
  title: string;
  subredditName: string;
  textFallback: string;
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
