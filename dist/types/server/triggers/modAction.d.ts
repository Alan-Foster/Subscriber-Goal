export type ModActionEvent = {
    action?: string;
    targetPost?: {
        id: string;
        authorId?: string;
        subredditId?: string;
        nsfw?: boolean;
        subredditName?: string;
    };
    moderator?: {
        name?: string;
    };
};
export declare function onModAction(event: ModActionEvent): Promise<void>;
