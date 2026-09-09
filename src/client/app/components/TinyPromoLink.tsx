import { navigateTo } from "@devvit/web/client";
import type { SubGoalLanguage } from "../../../shared/subGoalPostI18n";
import { TopButtons } from "./TopButtons";
import { goalJourneyAnalytics } from "../../analytics/goalJourneyAnalytics";
import type { GoalJourneyContext } from "../../../shared/goalJourneyAnalytics";
import { getNotificationMessages } from "../../../shared/notificationI18n";

type TinyPromoLinkProps = {
  promoSubreddit: string;
  language: SubGoalLanguage;
  analyticsContext?: GoalJourneyContext;
  onNotificationsPressed?: (() => void) | undefined;
};

export const TinyPromoLink = ({
  promoSubreddit,
  language,
  analyticsContext,
  onNotificationsPressed,
}: TinyPromoLinkProps) => {
  const notificationMessages = getNotificationMessages(language);
  return (
    <div data-tiny-promo-link="true">
      <TopButtons
        revealTextOnInteraction
        onNotificationsPressed={onNotificationsPressed}
        notificationLabel={notificationMessages.label}
        onVisitPromoSubPressed={() => {
          if (analyticsContext) {
            goalJourneyAnalytics.promoSubgoalActivated(analyticsContext);
          }
          navigateTo(`https://www.reddit.com/r/${promoSubreddit}/`);
        }}
        promoSubreddit={promoSubreddit}
        language={language}
      />
    </div>
  );
};
