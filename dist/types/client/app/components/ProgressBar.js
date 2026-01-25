import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { formatNumberUnlessExact } from '../../utils/numberUtils';
export const ProgressBar = ({ start, end, current, showText = false, width = '70%', }) => {
    const [animatedProgress, setAnimatedProgress] = useState(0);
    const isInvalid = start === undefined || end === undefined || current === undefined || end <= start;
    const progress = isInvalid ? 0 : Math.min(((current - start) / (end - start)) * 100, 100);
    useEffect(() => {
        if (isInvalid) {
            setAnimatedProgress(0);
            return;
        }
        const frame = requestAnimationFrame(() => {
            setAnimatedProgress(progress);
        });
        return () => cancelAnimationFrame(frame);
    }, [isInvalid, progress]);
    if (isInvalid) {
        return (_jsx("div", { className: "relative", style: { width }, children: _jsx("div", { className: "h-5 w-full rounded-md border border-[color:var(--sg-border-strong)] bg-[color:var(--sg-surface)]" }) }));
    }
    return (_jsxs("div", { className: "relative", style: { width }, children: [_jsx("div", { className: "h-5 w-full rounded-md border border-[color:var(--sg-border-strong)] bg-[color:var(--sg-surface)]", children: _jsx("div", { className: "h-full rounded-md bg-[color:var(--sg-accent)] transition-[width] duration-700 ease-out", style: { width: `${animatedProgress}%` } }) }), showText ? (_jsxs("div", { className: "absolute inset-0 flex items-center justify-center text-sm font-bold text-[color:var(--sg-text-secondary)]", children: [current, " / ", formatNumberUnlessExact(end)] })) : null] }));
};
//# sourceMappingURL=ProgressBar.js.map