import {RedditAPIClient} from '@devvit/public-api';

export async function getSubredditIcon (reddit: RedditAPIClient, subredditId: string, defaultIconUrl: string = 'https://i.redd.it/xaaj3xsdy0re1.png'): Promise<string> {
  const subredditStyles = await reddit.getSubredditStyles(subredditId);
  return subredditStyles.icon ?? defaultIconUrl;
}
