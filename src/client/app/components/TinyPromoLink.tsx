import { navigateTo } from "@devvit/web/client";
import type { SubGoalLanguage } from "../../../shared/subGoalPostI18n";
import { TopButtons } from "./TopButtons";

type TinyPromoLinkProps = {
  promoSubreddit: string;
  language: SubGoalLanguage;
};

export const TinyPromoLink = ({
  promoSubreddit,
  language,
}: TinyPromoLinkProps) => {
  return (
    <div data-tiny-promo-link="true">
      <TopButtons
        revealTextOnInteraction
        onVisitPromoSubPressed={() =>
          navigateTo(`https://www.reddit.com/r/${promoSubreddit}/`)
        }
        promoSubreddit={promoSubreddit}
        language={language}
      />
    </div>
  );
};
