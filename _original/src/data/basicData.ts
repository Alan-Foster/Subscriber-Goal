/**
 * @file This file defines basic data types used in the custom post state.
 * The ones from Devvit don't work because useState and useAsync require their data to be JSON serializable.
 */

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
