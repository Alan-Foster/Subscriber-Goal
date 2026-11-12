# Subscriber Goal

- The webpage for this Devvit application is: [https://developers.reddit.com/apps/subscriber-goal](https://developers.reddit.com/apps/subscriber-goal)

Subscriber Goal is an app that helps you grow your community faster!
Generate a post and place it first in your Community Highlights to encourage new members to join.
Celebrate the growth of your subreddit using Subscriber Goals!

- To view a live version of Subscriber Goal, visit [https://www.reddit.com/r/SubGoal](https://www.reddit.com/r/SubGoal)

![An example of the Subscriber Goal Success Page](https://i.redd.it/7d65rf601foh1.jpeg)

![An example of the before vs. after joining page views](https://i.redd.it/xhll0f151foh1.jpeg)

## Features

- **Progress Bar**: Track progress with a visual ratio bar
- **Custom Post Technology**: High-quality custom formatting for your subscriber goal
- **Realtime Member Notifications**: Show your community who just joined in real-time
- **Goal Achieved Page**: Once reached, the post shows the date and subscriber milestone!
- **User Data Removal**: Remove a user from the database if they request their data hidden

![The subreddit r/MotivationalPics saw its average daily subscribers increase by nearly 100%](https://i.redd.it/scygcx731foh1.jpeg)

## New CTA (Call To Action) Mini-Posts and 31 Supported Languages!

- **Compressed Action Buttons**: Perfect for large subreddits that want simple, elegant highlighted tools

![An example of CTA Posts](https://i.redd.it/4tkh6pj43foh1.jpeg)

## Install Instructions

1. To install the app, click "Add to Community" and select the community to install.
2. Navigate to your subreddit and access the Settings Menu (...)
3. Select "Create a New Sub Goal". The app will guide you and recommend a value for your goal to achieve next.
4. Click "Okay". Post generation may take 5-10 seconds, and you will be automatically redirected.
5. The app adds the new Subscriber Goal to the first Community Highlight position when a slot is available. Reddit supports up to six Community Highlights; the app never evicts unrelated moderator-managed highlights.
6. Once the goal is reached, the post will convert to a Success Page, showing the date and milestone.

![Select Create a New Goal from the dropdown next to Mod Tools](https://i.redd.it/qqrxpxt094af1.jpeg)

## Changelog

- 2.6.1 - Fixed several edge cases including missing goal replacements, post creation retries resetting goal progress, and joins showing success before subscriber tracking finished.
- 2.5.3 - Fixed a bug related to idempotency keys preventing new goals from being created.
- 2.5.2 - Adjusted how subscriber counts are displayed on Tiny subscribe and CTA posts. Compressed Changelog. Devvit 0.15.3
- 2.5.1 - Reordered language selection items. AutoGoal now checks highlights properly. Removed unused New Subreddit Invite system, tailwind code.
- 2.4.3 - Goal Success page text blocks now have static backgrounds to make screenshots easier to read. 
- 2.4.2 - Responsive Header, Join and CTA button text sizing scales from 18px to 12px and wraps appropriately. Improved missing goal data fallback and error reporting.
- 2.4.1 - UI improvements. Login prompt for non-users. Local install metrics for 24h and 7d for subbed vs unsubbed app loads, clicks, click success. Devvit 0.15.2
- 2.3.3 - Improved auto-goal system on app upgrades to prevent duplicate goals. 
- 2.3.2 - Missing mod accounts are re-added when removed, with proper uninstall steps provided via dm.
- 2.3.1 - Added Hindi, Punjabi, Marathi, now 31 total! Subscribe To is now Join. Invite Page for mods to install to their own subreddits. Removed Most Overrides. Devvit 0.15.1
- 2.2.1 - Integrated post.highlight (0.14.7) to better track pinned goals. Remove My Own Data fixed. NSFW Most Recent Post fixed. New Create a CTA Menu Item. Devvit 0.15.0
- 2.1.7 - Auto-goals only repins uncompleted goals. Pinned completed goals older than 24h are automatically replaced on app update. Devvit 0.14.5
- 2.1.5 - Auto-goal system now attempts to re-pin existing goals. Fixed eternal completed lockout.
- 2.1.3 - Automatic goals now require public, SFW communities. Corrected NSFW crosspost and username-sharing safeguards.
- 2.1.1 - Fixed Top post Today fallback. Scroll trap compliance. More Notifications prep. Staggered upgrade auto-goals (public, >1k subscribers). Devvit 0.14.4
- 2.0.1 - Various fixes and data hardening. Fixed CTA Confetti not firing. Added interface setup for SubGoal Milestone Alerts. Devvit 0.14.3

Notes from before 2.0.1 can be found on the SubGoal wiki: [https://www.reddit.com/r/SubGoal/wiki/readme-archive](https://www.reddit.com/r/SubGoal/wiki/readme-archive)
