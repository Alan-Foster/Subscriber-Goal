import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { formatNumberUnlessExact } from '../../utils/numberUtils';
import { SubredditIcon } from '../components/SubredditIcon';
import { TopButtons } from '../components/TopButtons';
export const ThanksPage = ({ state, onReturn, onVisitPromoSub, onCelebrate, }) => {
    return (_jsxs("div", { className: "relative flex h-full w-full flex-col items-center justify-center gap-4 px-4 py-6 text-center text-[color:var(--sg-text-primary)]", children: [_jsx(TopButtons, { onVisitPromoSubPressed: onVisitPromoSub, promoSubreddit: state.appSettings.promoSubreddit }), _jsx(SubredditIcon, { iconUrl: state.subreddit.icon, size: 100, onClick: onCelebrate }), _jsx("div", { className: "text-2xl font-bold", children: "Thanks for Subscribing!" }), _jsxs("div", { className: "text-lg font-semibold text-[color:var(--sg-text-secondary)]", children: ["There are now ", formatNumberUnlessExact(state.subreddit.subscribers), " subscribers in the community!"] }), _jsx("button", { className: "cursor-pointer rounded-full border border-[color:var(--sg-border)] bg-[color:var(--sg-surface)] px-4 py-2 text-sm font-semibold text-[color:var(--sg-text-secondary)] shadow-sm transition hover:bg-[color:var(--sg-surface-muted)]", onClick: onReturn, children: "Return to Previous Page" })] }));
};
//# sourceMappingURL=ThanksPage.js.map