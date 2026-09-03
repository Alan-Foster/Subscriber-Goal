import { navigateTo } from "@devvit/web/client";
import type { SubGoalLanguage } from "../../../shared/subGoalPostI18n";
import { TopButtons } from "./TopButtons";
import { goalJourneyAnalytics } from "../../analytics/goalJourneyAnalytics";
import type { GoalJourneyContext } from "../../../shared/goalJourneyAnalytics";

type TinyPromoLinkProps = {
  promoSubreddit: string;
  language: SubGoalLanguage;
  analyticsContext?: GoalJourneyContext;
};

export const TinyPromoLink = ({
  promoSubreddit,
  language,
  analyticsContext,
}: TinyPromoLinkProps) => {
  return (
    <div data-tiny-promo-link="true">
      <TopButtons
        revealTextOnInteraction
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
