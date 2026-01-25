import { jsx as _jsx } from "react/jsx-runtime";
import { useMemo } from 'react';
const colors = [
    '#ff4500',
    '#f59e0b',
    '#10b981',
    '#3b82f6',
    '#a855f7',
    '#f472b6',
];
export const ConfettiBurst = ({ pieceCount = 70 }) => {
    const pieces = useMemo(() => Array.from({ length: pieceCount }, () => ({
        left: Math.random() * 100,
        drift: (Math.random() * 2 - 1) * 80,
        delay: Math.random() * 0.35,
        duration: 1.6 + Math.random() * 1.4,
        size: 6 + Math.random() * 6,
        rotate: Math.random() * 360,
        color: colors[Math.floor(Math.random() * colors.length)],
    })), [pieceCount]);
    return (_jsx("div", { className: "confetti", children: pieces.map((piece, index) => {
            const style = {
                left: `${piece.left}%`,
                animationDelay: `${piece.delay}s`,
                animationDuration: `${piece.duration}s`,
                '--confetti-drift': `${piece.drift}px`,
            };
            return (_jsx("span", { className: "confetti-piece", style: style, children: _jsx("span", { className: "block rounded-sm", style: {
                        width: piece.size,
                        height: piece.size * 1.4,
                        backgroundColor: piece.color,
                        transform: `rotate(${piece.rotate}deg)`,
                    } }) }, index));
        }) }));
};
//# sourceMappingURL=ConfettiBurst.js.map