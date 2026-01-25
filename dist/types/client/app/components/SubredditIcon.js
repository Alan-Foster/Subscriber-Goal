import { jsx as _jsx } from "react/jsx-runtime";
import { LoadingElement } from './LoadingElement';
export const SubredditIcon = ({ iconUrl, size = 100, onClick, }) => {
    const dimensionStyle = { width: size, height: size };
    return (_jsx("div", { className: "flex items-center justify-center rounded-full bg-[color:var(--sg-surface)]", style: dimensionStyle, children: _jsx(LoadingElement, { isLoading: !iconUrl, className: "h-full w-full", children: iconUrl ? (_jsx("img", { src: iconUrl, alt: "Subreddit icon", className: `h-full w-full rounded-full object-cover ${onClick ? 'cursor-pointer' : ''}`, onClick: onClick })) : null }) }));
};
//# sourceMappingURL=SubredditIcon.js.map