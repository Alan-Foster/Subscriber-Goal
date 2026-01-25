type CreateGoalPostParams = {
    title: string;
    subredditName: string;
};
export declare const createGoalPost: ({ title, subredditName, }: CreateGoalPostParams) => Promise<import("@devvit/reddit").Post>;
export {};
