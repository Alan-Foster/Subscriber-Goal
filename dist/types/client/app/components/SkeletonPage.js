import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export const SkeletonPage = () => {
    const skeletonClass = 'animate-pulse rounded-full bg-[color:var(--sg-surface-muted)]';
    return (_jsxs("div", { className: "relative flex h-[320px] w-full flex-col items-center justify-center gap-5 px-4 py-6", children: [_jsx("div", { className: `h-[100px] w-[100px] ${skeletonClass}` }), _jsx("div", { className: `h-5 w-48 ${skeletonClass}` }), _jsx("div", { className: "h-5 w-[70%] rounded-md bg-[color:var(--sg-surface-muted)] animate-pulse" }), _jsx("div", { className: `h-9 w-56 ${skeletonClass}` }), _jsx("div", { className: `h-4 w-40 ${skeletonClass}` })] }));
};
//# sourceMappingURL=SkeletonPage.js.map