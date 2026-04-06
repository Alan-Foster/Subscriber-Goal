export type BasicSubredditData = {
  id: string;
  name: string;
  icon: string;
  subscribers: number;
  isNsfw: boolean;
};

export type BasicUserData = {
  id: string;
  username: string;
};

export type AppSettings = {
  promoSubreddit: string;
  crosspostAuthoritySubreddit: string;
  crosspostMaxSourcePostAgeMinutes: number;
  crosspostIngestionEnabled: boolean;
  crosspostMaxRevisionAgeMinutes: number;
  maxCrosspostsPerRun: number;
  maxCrosspostsPerHour: number;
};

export type SubGoalState = {
  goal: number | null;
  recentSubscriber: string | null;
  completedTime: number | null;
  subscribed: boolean;
  user: BasicUserData | null;
  appSettings: AppSettings;
  subreddit: BasicSubredditData;
};

export type InitResponse = {
  type: 'init';
  postId: string;
  state: SubGoalState;
};

export type RefreshResponse = {
  type: 'refresh';
  postId: string;
  state: SubGoalState;
};

export type SubscribeResponse = {
  type: 'subscribe';
  postId: string;
  state: SubGoalState;
};

export type SubscribeRequest = {
  shareUsername?: boolean;
};

export type RealtimeMessage = {
  type: 'sub';
  newSubscriberCount: number;
  recentSubscriber?: string | null;
};

export type ErrorResponse = {
  status: 'error';
  message: string;
};

export type CreateGoalFormValues = {
  subscriberGoal?: number;
  postTitle?: string;
  crosspost?: boolean;
  subredditDisplayName?: string;
};

export type DeleteGoalFormValues = {
  confirm?: boolean;
};

export type EraseDataFormValues = {
  username?: string;
  userId?: string;
  confirm?: boolean;
};
