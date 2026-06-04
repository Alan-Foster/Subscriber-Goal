import { reddit } from "@devvit/web/server";

type CreateGoalPostParams = {
  title: string;
  subredditName: string;
  submitAsUser?: boolean;
};

export const createGoalPost = async ({
  title,
  subredditName,
  submitAsUser = false,
}: CreateGoalPostParams) => {
  return await reddit.submitCustomPost({
    title,
    subredditName,
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
