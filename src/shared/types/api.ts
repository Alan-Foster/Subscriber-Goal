export type BasicSubredditData = {
  id: string;
  name: string;
  icon: string;
  subscribers: number;
};

export type BasicUserData = {
  id: string;
  username: string;
};

export type AppSettings = {
  promoSubreddit: string;
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

export type DebugRealtimeRequest = {
  nextCount: number;
  includeUsername?: boolean;
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
};

export type DeleteGoalFormValues = {
  confirm?: boolean;
};

export type EraseDataFormValues = {
  username?: string;
  userId?: string;
  confirm?: boolean;
};
