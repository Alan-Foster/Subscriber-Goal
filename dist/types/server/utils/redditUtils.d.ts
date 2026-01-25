import type { RedditClient } from '../types';
export type WikiPageRevision = {
    id: string;
    reason: string;
};
export declare function getSubredditIcon(reddit: RedditClient, subredditId: string, defaultIconUrl?: string): Promise<string>;
export declare function clearUserStickies(reddit: RedditClient, username: string): Promise<void>;
export declare function safeGetWikiPageRevisions(reddit: RedditClient, subredditName: string, page: string): Promise<WikiPageRevision[] | undefined>;
