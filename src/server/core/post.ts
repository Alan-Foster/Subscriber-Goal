import { reddit } from '@devvit/web/server';

type CreateGoalPostParams = {
  title: string;
  subredditName: string;
};

export const createGoalPost = async ({
  title,
  subredditName,
}: CreateGoalPostParams) => {
  return await reddit.submitCustomPost({
    title,
    subredditName,
  });
};
