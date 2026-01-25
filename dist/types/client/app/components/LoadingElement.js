import { Fragment as _Fragment, jsx as _jsx } from "react/jsx-runtime";
export const LoadingElement = ({ isLoading, className = 'h-6 w-6', children, }) => {
    if (!isLoading) {
        return _jsx(_Fragment, { children: children });
    }
    return (_jsx("div", { className: `flex items-center justify-center ${className}`, children: _jsx("div", { className: "h-full w-full animate-pulse rounded-full bg-[color:var(--sg-surface-muted)]" }) }));
};
//# sourceMappingURL=LoadingElement.js.map