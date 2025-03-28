import {Context, useAsync, UseAsyncResult, useChannel, UseChannelResult, useInterval, UseIntervalResult, useState, UseStateResult} from '@devvit/public-api';
import {assertNonNull} from '@devvit/shared-types/NonNull.js';

import {BasicSubredditData, BasicUserData} from '../../../data/basicData.js';
import {checkCompletionStatus, getSubGoalData, SubGoalData} from '../../../data/subGoalData.js';
import {getSubscriberStats, setNewSubscriber, SubscriberStats} from '../../../data/subscriberStats.js';
import {AppSettings, getAppSettings} from '../../../settings.js';
import {getSubredditIcon} from '../../../utils/subredditUtils.js';
import {Router} from '../../router.js';

export type ChannelPacket = {
  type: 'sub'; // Allows for other types of messages in the future
  newSubscriberCount: number;
  recentSubscriber?: string;
};

export class SubGoalState {
  // UseStateResult
  readonly _currentSubscibers: UseStateResult<number>;
  readonly _hasSubscribed: UseStateResult<boolean>;
  readonly _pendingMessage: UseStateResult<ChannelPacket | null>;
  readonly _recentSubscriber: UseStateResult<string>;
  readonly _refresher: UseStateResult<number>;
  // UseAsyncResult
  readonly _appSettings: UseAsyncResult<AppSettings | null>;
  readonly _currentUser: UseAsyncResult<BasicUserData | null>;
  readonly _subGoalData: UseAsyncResult<SubGoalData>;
  readonly _subredditData: UseAsyncResult<BasicSubredditData>;
  readonly _subscriptionStats: UseAsyncResult<SubscriberStats | null>;
  // UseChannelResult
  readonly _channel: UseChannelResult<ChannelPacket>;
  // UseInterval
  readonly _interval: UseIntervalResult;

  constructor (readonly context: Context, protected router: Router) {
    this._currentSubscibers = useState(0);
    this._hasSubscribed = useState(false);
    this._pendingMessage = useState<ChannelPacket | null>(null);
    this._recentSubscriber = useState('');
    this._refresher = useState(0);

    this._subGoalData = useAsync<SubGoalData>(async () => getSubGoalData(this.context.redis, this.postId), {
      depends: [this.refresher],
      finally: (data, error) => {
        if (!data || error) {
          return;
        }

        if (!this.recentSubscriber && data.recentSubscriber) {
          this.recentSubscriber = data.recentSubscriber;
        }

        if (data.completedTime) {
          this.router.changePage('completed');
        }
      },
    });

    this._subredditData = useAsync<BasicSubredditData>(async () => {
      const subreddit = await this.context.reddit.getCurrentSubreddit();
      return {
        id: subreddit.id,
        name: subreddit.name,
        icon: await getSubredditIcon(this.context.reddit, subreddit.id),
        subscribers: subreddit.numberOfSubscribers,
      };
    }, {
      depends: [this.recentSubscriber, this.refresher],
      finally: (data, error) => {
        if (!data || error) {
          console.error('Failed to load subreddit data:', error);
          return;
        }

        this.subscribers = data.subscribers;
      },
    });

    this._appSettings = useAsync<AppSettings | null>(async () => {
      const settings = await getAppSettings(this.context.settings);
      if (!settings) {
        return null;
      }
      return settings;
    });
    this._currentUser = useAsync<BasicUserData | null>(async () => {
      if (!this.context.userId) {
        return null;
      }
      const username = await this.context.reddit.getCurrentUsername();
      if (!username) {
        return null;
      }
      return {
        id: this.context.userId,
        username,
      };
    }, {depends: [this.context.userId ?? null]});

    this._subscriptionStats = useAsync<SubscriberStats | null>(async () => {
      if (!this.user || !this.user.id) {
        return null;
      }
      const subStats = await getSubscriberStats(this.context.redis, this.user.id);
      return subStats ?? null;
    }, {
      depends: [this.user?.id ?? null, this.refresher],
      finally: (data, error) => {
        if (error) {
          console.error('Failed to load subreddit data:', error);
          return;
        }

        if (data) {
          this.subscribed = true;
        }
      },
    });

    this._channel = useChannel<ChannelPacket>({
      name: 'subscriber_updates',
      onMessage: this.onChannelMessage,
      onSubscribed: this.onChannelSubscribed,
      onUnsubscribed: this.onChannelUnsubscribed,
    });
    this.connectToChannel();

    this._interval = useInterval(this.refresh, 30000);
  }

  get appSettings (): AppSettings | null {
    return this._appSettings.data;
  }
  get completedTime (): Date | null {
    return this._subGoalData.data?.completedTime ? new Date(this._subGoalData.data.completedTime) : null;
  }
  get goal (): number | null {
    return this._subGoalData.data?.goal ?? null;
  }
  get goalProgress (): number {
    return Math.min((this.subreddit.subscribers || 0) / (this.goal || 2000) * 100, 100);
  }
  get goalRemaining (): number | null {
    return this.goal !== null ? Math.max(this.goal - this.subreddit.subscribers, 0) : null;
  }
  protected get pendingMessage (): ChannelPacket | null {
    return this._pendingMessage[0];
  }
  protected set pendingMessage (message: ChannelPacket | null) {
    this._pendingMessage[1](message);
  }
  get postId (): string {
    assertNonNull(this.context.postId, 'Post should always have an ID');
    return this.context.postId;
  }
  get recentSubscriber (): string {
    return this._recentSubscriber[0];
  }
  set recentSubscriber (message: string) {
    this._recentSubscriber[1](message);
  }
  get refresher (): number {
    return this._refresher[0];
  }
  protected set refresher (value: number) {
    this._refresher[1](value);
  }
  get subreddit (): BasicSubredditData {
    return this._subredditData.data ?? {
      id: this.context.subredditId,
      name: this.context.subredditName ?? '',
      icon: '',
      subscribers: 0,
    };
  }
  get subscribed (): boolean {
    return this._hasSubscribed[0];
  }
  set subscribed (value: boolean) {
    this._hasSubscribed[1](value);
  }
  get subscribers (): number {
    return this._currentSubscibers[0];
  }
  set subscribers (value: number) {
    this._currentSubscibers[1](value);
  }
  get user (): BasicUserData | null {
    return this._currentUser.data;
  }

  connectToChannel = () => {
    try {
      this._channel.subscribe();
    } catch (e) {
      console.error('Failed to connect to channel:', e);
    }
  };
  notifyPressed = () => {
    this.context.ui.showToast('This feature has not yet been implemented!');
  };
  onChannelMessage = (message: ChannelPacket) => {
    if (message.type === 'sub') {
      if (message.recentSubscriber) {
        this.recentSubscriber = message.recentSubscriber;
      }
      this.subscribers = message.newSubscriberCount;
    } else {
      console.warn('Unexpected message type:', message);
    }
  };
  onChannelSubscribed = async () => {
    console.log(`${this.user?.username} has subscribed to the ${this.postId} channel with environment ${JSON.stringify(this.context.uiEnvironment ?? {})}`);
    if (this.pendingMessage) {
      await this.sendToChannel(this.pendingMessage);
      this.pendingMessage = null;
    }
  };
  onChannelUnsubscribed = async () => {
    console.log(`${this.user?.username} has unsubscribed from the ${this.context.postId} channel`);
    try {
      this._channel.subscribe();
    } catch (e) {
      console.error(`Error resubscribing to channel: ${String(e)}`);
    }
  };
  refresh = () => {
    this.refresher = Date.now();
  };
  seeMorePressed = async () => {
    this.context.ui.navigateTo('https://www.reddit.com/r/SubGoal/');
  };
  sendToChannel = async (message: ChannelPacket): Promise<boolean> => {
    try {
      console.log('Sending message:', message);
      await this._channel.send(message);
      return true;
    } catch (e) {
      console.error('Failed to send message:', e);
      // Save message for later if we're not connected or sending fails and attempt to reconnect
      this.pendingMessage = message;
      this.connectToChannel();
      return false;
    }
  };
  subscribePressed = async () => {
    if (!this.user || !this.user.id) {
      return this.context.ui.showToast('Please log in to subscribe!');
    }

    await this.context.reddit.getCurrentUsername(); // Prevent ServerCallRequired exception catching in the following block by starting it here

    try {
      await this.context.reddit.subscribeToCurrentSubreddit();
      this.context.ui.showToast('Thank you for subscribing!');

      this.refresh();
      this.recentSubscriber = this.user.username;
      this.subscribed = true;

      const newSubscriberCount = this.subreddit.subscribers + 1;
      const newSubscriber = await setNewSubscriber(this.context.redis, this.postId, newSubscriberCount, this.user);
      if (!newSubscriber) {
        const sendSuccess = await this.sendToChannel({
          type: 'sub',
          newSubscriberCount,
          recentSubscriber: this.user.username,
        });
        if (!sendSuccess) {
          this.subscribed = false;
          return this.context.ui.showToast('Your subscription was recorded! Updates will sync when connection is restored.');
        }
      }

      if (this.goal !== null && newSubscriberCount >= this.goal) {
        await checkCompletionStatus(this.context.reddit, this.context.redis, this.postId);
        this.router.changePage('completed');
      } else {
        this.router.changePage('thanks');
      }
    } catch (e) {
      console.error(`${this.user.username} failed to subscribe:`, e);
      return this.context.ui.showToast('Subscription failed. Try again.');
    }
  };
  visitPromoSubPressed = () => {
    if (!this.appSettings || !this.appSettings.promoSubreddit) {
      return this.context.ui.showToast('Settings not loaded yet.');
    }
    this.context.ui.navigateTo(`https://www.reddit.com/r/${this.appSettings.promoSubreddit}/`);
  };
}
