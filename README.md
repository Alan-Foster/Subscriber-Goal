# Subscriber Goal

- The webpage for this Devvit application is: [https://developers.reddit.com/apps/subscriber-goal](https://developers.reddit.com/apps/subscriber-goal)

Subscriber Goal is an app that lets you set a subscriber target goal and track your progress towards it!
Generate a post and pin it near the top of your subreddit to encourage new subscriptions.
Celebrate the growth of your subreddit using Subscriber Goals!

- To view a live version of Subscriber Goal, visit [https://www.reddit.com/r/SubGoal](https://www.reddit.com/r/SubGoal)



![An example of Subscriber Goal Posts](https://i.redd.it/kl0uzo2yslyg1.jpeg)



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
- 1.6.1 - Release of Tiny-Height Goals (call to action Subscribe button only). Improved Create New Goal menu flow. Automatic 24h goal creation fallback. Devvit 0.14.1
- 1.5.1 - Release of Small-Height Goals (goals without subreddit icons). Users can erase their own data. Devvit 0.13.8
- 1.4.4 - Fixed a bug with sticky not replacing completed goals. Devvit 0.13.6. Updated Overrides.
- 1.4.3 - Added more developer special code commands.
- 1.4.1 - Subscriber Goal provides a warning via Modmail and DM when it cannot pin a post. Menu item developer special-code field. Devvit 0.13.2
- 1.3.1 - Fixed issue with cron trying to update deleted / removed goals. Updated overrides. Devvit 0.12.24
- 1.2.3 - Subscriber Goal is now available in 28 total languages! Wow!
- 1.2.1 - Subscriber Goal is now available in 7 other languages.
- 1.1.1 - Added Auto-Launch New Goal toggle that can create a new goal 24 hours after success.
- 1.0.1 - Official Launch - all previous installations force-updated to 1.0.1.
- 0.14.1 - UI Cleanup. New ReadMe Images. Removal of bug-testing App Settings. Fixed package drift. Devvit 0.12.22
- 0.13.1 - Reduce scheduler work on non-authority installs, removed full Redis scans from admin erasure paths. Devvit 0.12.21
- 0.13.0 - Final conversion from zrange to hget for data lookup. Custom button colors.
- 0.12.5 - Add a subscribe button glow to drive higher button engagement. Share username is now opt-out.
- 0.12.3 - Removal of decimals on any value below 9999 and 10k+ does not use hundreds decimals.
- 0.12.2 - Adjusted subreddit icon scale to not be blurry. Devvit 0.12.20
- 0.12.0 - Proper utilization of App Settings. Fixed stale-posts preventing crossposting. Devvit 0.12.19
- 0.11.10 - Removed unused code, added app icon.
- 0.11.9 - Experimental fixes for broken crossposting.
- 0.11.8 - Fixed devvit.json scripts entries. Fixed lint errors
- 0.11.6 - Fixed critical redis error preventing crossposts, Devvit 0.12.18
- 0.11.3 - Share username is now enabled by default (opt-out).
- 0.11.2 - Customize subreddit name capitalization across app.
- 0.11.1 - Double Crosspost Errors, fixed WSL and Github linter
- 0.11.0 - Harden crosspost replay prevention and dedupe
- 0.10.7 - Missing-post crosspost error handling
- 0.10.6 - Crosspost bookkeeping cleanup and hardening
- 0.10.5 - Data Retry for Missing Data Load utility. Locally hosted fallback subreddit logo.
- 0.10.4 - Removed NSFW crossposting, fixed subscriber-stats scale issue, fixed sticky cleanup.
- 0.10.3 - Major lint / type-checking fixes. Color changes. Crossposting working again! Updated to Devvit 0.12.17
- 0.10.2 - Updated to Devvit 0.12.15
- 0.10.1 - Removed canRunAsUser permissions.
- 0.10.0 - Devvit Web Migration. Users must opt-in to broadcast name. Devvit 0.12.10
- 0.9.2 - Added images and installation instructions to the ReadMe file. Devvit 0.11.17
- 0.9.0 - SubGoal data structure reworked - preparation for Milestone Announcement Messages, Devvit 0.11.15
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
