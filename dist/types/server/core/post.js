import { reddit } from '@devvit/web/server';
export const createGoalPost = async ({ title, subredditName, }) => {
    return await reddit.submitCustomPost({
        title,
        subredditName,
    });
};
//# sourceMappingURL=post.js.map