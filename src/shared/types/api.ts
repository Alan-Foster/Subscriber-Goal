import type { SubGoalColorTheme } from "../subGoalColorTheme";
import type { SubGoalPostHeight } from "../subGoalPostHeight";
import type { SubGoalLanguage } from "../subGoalPostI18n";
import type { AfterSubscribeAction } from "../afterSubscribeAction";

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

export type PublicAppSettings = {
  promoSubreddit: string;
};

type SharedPostState = {
  colorTheme: SubGoalColorTheme;
  language: SubGoalLanguage;
  afterSubscribeAction: AfterSubscribeAction;
};

export type SubscriberGoalState = SharedPostState & {
  postHeight: Exclude<SubGoalPostHeight, "tiny">;
  goal: number | null;
  recentSubscriber: string | null;
  completedTime: number | null;
  headerText: string | null;
  subscribed: boolean;
  user: BasicUserData | null;
  appSettings: PublicAppSettings;
  subreddit: BasicSubredditData;
};

export type SubscribeOnlyState = SharedPostState & {
  postHeight: "tiny";
  promoSubreddit: string;
  subscribed: boolean;
  authenticated: boolean;
  subreddit: Pick<BasicSubredditData, "name" | "subscribers"> & {
    newSubscribersToday: number;
  };
};

export type SubGoalState = SubscriberGoalState | SubscribeOnlyState;

export type InitResponse = {
  type: "init";
  postId: string;
  state: SubGoalState;
};

export type RefreshResponse = {
  type: "refresh";
  postId: string;
  state: SubGoalState;
};

export type SubscribeResponse = {
  type: "subscribe";
  postId: string;
  state: SubGoalState;
};

export type SubscribeRequest = {
  shareUsername?: boolean;
};

export type NavigationTarget = { url: string; permalink?: string };

export type AfterSubscribeTargetResponse = {
  target: NavigationTarget;
};

export type RealtimeMessage = {
  type: "sub";
  newSubscriberCount: number;
  recentSubscriber?: string | null;
};

export type ErrorResponse = {
  status: "error";
  message: string;
};

export type CreateGoalSetupFormValues = {
  postHeight?: string[];
  language?: string[];
  subredditDisplayName?: string;
};

type CreateGoalDetailsFormValues = {
  postTitle?: string;
  colorTheme?: string[];
  afterSubscribePreset?: string[];
};

export type CreateSubscriberGoalFormValues = CreateGoalDetailsFormValues & {
  subscriberGoal?: number;
  crosspost?: boolean;
  autoCreateNextGoal?: boolean;
};

export type CreateSubscribeOnlyFormValues = CreateGoalDetailsFormValues;

type CreateAfterSubscribeFormValues = {
  afterSubscribeButtonText?: string;
  afterSubscribeUrl?: string;
  afterSubscribeColorTheme?: string[];
  customDeveloperField?: string;
};

export type CreateSubscriberGoalFollowUpFormValues =
  CreateAfterSubscribeFormValues;

export type CreateSubscribeOnlyFollowUpFormValues =
  CreateAfterSubscribeFormValues;

export type DeleteGoalFormValues = {
  confirm?: boolean;
};

export type EraseDataFormValues = {
  username?: string;
  userId?: string;
  confirm?: boolean;
};

export type EraseMyDataFormValues = {
  confirm?: boolean;
};
