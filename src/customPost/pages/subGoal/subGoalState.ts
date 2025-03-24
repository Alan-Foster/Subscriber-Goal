import {Context, useAsync, UseAsyncResult, useChannel, UseChannelResult, useState, UseStateResult} from '@devvit/public-api';
import {assertNonNull} from '@devvit/shared-types/NonNull.js';

import {BasicSubredditData, BasicUserData} from '../../../data/basicData.js';
import {getSubGoalData, setNewSubscriber, SubGoalData} from '../../../data/subGoalData.js';
import {getDefaultSubscriberGoal} from '../../../utils/defaultSubscriberGoal.js';
import {Router} from '../../router.js';

export type ChannelPacket = {
  type: 'sub'; // Allows for other types of messages in the future
  newSubscriberCount: number;
  recentSubscriber: string;
};

export class SubGoalState {
  // UseStateResult
  readonly _pendingMessage: UseStateResult<ChannelPacket | null>;
  readonly _recentSubscriber: UseStateResult<string>;
  readonly _refresher: UseStateResult<number>;
  // UseAsyncResult
  readonly _currentUser: UseAsyncResult<BasicUserData | null>;
  readonly _subGoalData: UseAsyncResult<SubGoalData>;
  readonly _subredditData: UseAsyncResult<BasicSubredditData>;
  // UseChannelResult
  readonly _channel: UseChannelResult<ChannelPacket>;

  constructor (readonly context: Context, protected router: Router) {
    this._refresher = useState(0);
    this._pendingMessage = useState<ChannelPacket | null>(null);
    this._recentSubscriber = useState('');

    this._subGoalData = useAsync<SubGoalData>(async () => getSubGoalData(this.context.redis, this.postId), {
      finally: (data, error) => {
        if (!data || error) {
          return;
        }

        if (!this.recentSubscriber && data.recentSubscriber) {
          this.recentSubscriber = data.recentSubscriber;
        }
      },
    });

    this._subredditData = useAsync<BasicSubredditData>(async () => {
      const subreddit = await this.context.reddit.getCurrentSubreddit();
      return {
        id: subreddit.id,
        name: subreddit.name,
        subscribers: subreddit.numberOfSubscribers,
      };
    }, {depends: [this.recentSubscriber, this.refresher]});

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
    });

    this._channel = useChannel<ChannelPacket>({
      name: 'subscriber_updates',
      onMessage: this.onChannelMessage,
      onSubscribed: this.onChannelSubscribed,
      onUnsubscribed: this.onChannelUnsubscribed,
    });
    this.connectToChannel();
  }

  get goal (): number {
    return this._subGoalData.data?.goal ?? getDefaultSubscriberGoal(this.subreddit.subscribers);
  }
  get goalProgress (): number {
    return Math.min((this.subreddit.subscribers || 0) / (this.goal || 2000) * 100, 100);
  }
  get goalRemaining (): number {
    return Math.max(this.goal - this.subreddit.subscribers, 0);
  }
  get header (): string {
    return this._subGoalData.data?.header ?? 'Loading Header...';
  }
  get loaded (): boolean {
    return this.subreddit !== null && this.goal !== null;
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
      subscribers: 0,
    };
  }
  get user (): BasicUserData | null {
    return this._currentUser.data;
  }

  public refresh (): void {
    this.refresher = Date.now();
  }

  connectToChannel = () => {
    try {
      this._channel.subscribe();
    } catch (e) {
      console.error('Failed to connect to channel:', e);
    }
  };
  onChannelMessage = (message: ChannelPacket) => {
    if (message.type === 'sub') {
      if (message.recentSubscriber) {
        this.recentSubscriber = message.recentSubscriber;
      }
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
    if (!this.user) {
      return this.context.ui.showToast('Please log in to subscribe!');
    }

    try {
      await this.context.reddit.subscribeToCurrentSubreddit();
      this.context.ui.showToast('Thank you for subscribing!');

      this.refresh();
      this.recentSubscriber = this.user.username;

      const newSubscriber = await setNewSubscriber(this.context.redis, this.postId, this.subreddit.subscribers + 1, this.user);
      if (!newSubscriber) {
        return; // Don't show the recent subscriber message if they're already subscribed
      }

      const sendSuccess = await this.sendToChannel({
        type: 'sub',
        newSubscriberCount: this.subreddit.subscribers + 1,
        recentSubscriber: this.user.username,
      });
      if (!sendSuccess) {
        return this.context.ui.showToast('Your subscription was recorded! Updates will sync when connection is restored.');
      }
    } catch (e) {
      console.error(`${this.user.username} failed to subscribe:`, e);
      return this.context.ui.showToast('Subscription failed. Try again.');
    }
  };
}
