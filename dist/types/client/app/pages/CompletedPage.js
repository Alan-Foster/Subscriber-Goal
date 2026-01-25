import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { context } from '@devvit/web/client';
import { formatNumberUnlessExact } from '../../utils/numberUtils';
import { SubredditIcon } from '../components/SubredditIcon';
import { TopButtons } from '../components/TopButtons';
export const CompletedPage = ({ state, onVisitPromoSub, onCelebrate, }) => {
    const { locale, timezone } = context;
    const completedDate = state.completedTime ? new Date(state.completedTime) : null;
    const timeText = completedDate
        ? completedDate.toLocaleTimeString(locale ?? 'en', { timeZone: timezone ?? 'UTC' })
        : null;
    const dateText = completedDate
        ? completedDate.toLocaleDateString(locale ?? 'en', { timeZone: timezone ?? 'UTC' })
        : null;
    return (_jsxs("div", { className: "relative flex h-full w-full flex-col items-center justify-center gap-4 px-4 py-6 text-center text-[color:var(--sg-text-primary)]", children: [_jsx(TopButtons, { onVisitPromoSubPressed: onVisitPromoSub, promoSubreddit: state.appSettings.promoSubreddit }), _jsx(SubredditIcon, { iconUrl: state.subreddit.icon, size: 100, onClick: onCelebrate }), _jsxs("div", { className: "text-2xl font-bold", children: ["r/", state.subreddit.name, " reached", ' ', state.goal ? formatNumberUnlessExact(state.goal) : 'the goal', " subscribers!"] }), _jsx("div", { className: "text-lg font-semibold text-[color:var(--sg-text-secondary)]", children: timeText && dateText
                    ? `Goal reached at ${timeText} on ${dateText}`
                    : 'Goal reached just now!' })] }));
};
//# sourceMappingURL=CompletedPage.js.map