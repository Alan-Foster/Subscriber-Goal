# Subscriber Goal

- The webpage for this Devvit application is: [https://developers.reddit.com/apps/subscriber-goal](https://developers.reddit.com/apps/subscriber-goal)

Subscriber Goal is an app that lets you set a subscriber target goal and track your progress towards it!
Generate a post and pin it near the top of your subreddit to encourage new subscriptions.
Celebrate the growth of your subreddit using Subscriber Goals!

- To view a live version of Subscriber Goal, visit [https://www.reddit.com/r/SubGoal](https://www.reddit.com/r/SubGoal)



![An example of Subscriber Goal Posts](https://i.redd.it/zrkpv7gfg4af1.jpeg)



## Features

- **Progress Bar**: Track progress with a visual ratio bar
- **Custom Post Technology**: High-quality custom formatting for your subscriber goal
- **Realtime Subscriber Notifications**: Show your community who just subscribed in real-time
- **Goal Achieved Page**: Once reached, the post shows the date and subscriber milestone!
- **User Data Removal**: Remove a user from the database if they request their data hidden

## Benefits

- Higher subscription rates of new users, great for new subreddits!
- Both large and small subreddits can celebrate major user milestones
- Teach new users to subscribe and remind them to join the community



![The subreddit r/MotivationalPics saw its average daily subscribers increase by 100%](https://i.redd.it/nlch4724d4af1.jpeg)



## Install Instructions

1. To install the app, click "Add to Community" and select the community to install.
2. Decide if you would like to announce your new goal in the [r/SubGoal](https://www.reddit.com/r/SubGoal) community
3. Navigate to your subreddit and access the Settings Menu (...)
4. Select "Create a New Sub Goal". The app will recommend a value for your goal to achieve next.
5. Click "Okay". Post generation may take 5-10 seconds, and you will be automatically redirected.
6. If you had less than 4 pinned posts, the new Subscriber Goal will be pinned automatically.
7. Once the goal is reached, the post will convert to a Success Page, showing the date and milestone.



![Select Create a New Goal from the dropdown next to Mod Tools](https://i.redd.it/qqrxpxt094af1.jpeg)



## Changelog
- 0.9.2 - Added images and installation instructions to the ReadMe file. Devvit 0.11.17
- 0.9.0 - SubGoal data strucutre reworked - preparation for Milestone Announcement Messages, Devvit 0.11.15
- - PLEASE NOTE - 0.9.0 is not compatible with old subscriber goals. All members will need to re-click the button.
- 0.8.1 - SubGoal now removes old pins before making new goals. Self-approves posts to fix AutoMod platform bug.
- 0.8.0 - Realtime subscriber name messages and progress updates (mostly) fixed. Launch of Private Beta.
- 0.7.3 - Major refactoring. Announcements in r/SubGoal removed for refactoring.
- 0.7.1 - Adding / testing realtime subscriber names, announces new goals in r/SubGoal. Minor refactoring, Devvit 0.11.10.
- 0.7.0 - Fixed critical form.0 error related to dynamic forms not passing data properly. Devvit 0.11.9.
- 0.6.0 - Fixed Redis storage to store data under postID. Headers inside posts customizable.
- 0.5.0 - Large subreddit goals and subscriber counts are rounded eg 400000 to 400k or 12m
- 0.4.0 - Subscriber goals are automatically stickied and announced in r/SubGoal
- 0.3.0 - Default suggested sub goal based on current sub count. 'X more to reach' can't go negative.
- 0.2.0 - Text reformatting. Added progress bar.
- 0.1.0 - First official publish, pending approval for Subscribe Button functionality
- 0.0.1 - First app launch and early testing