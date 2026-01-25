export function formatNumberUnlessExact(num) {
    if (num >= 1000000 && num % 100000 === 0) {
        return `${(num / 1000000).toFixed(1)} million`;
    }
    if (num >= 10000 && num % 1000 === 0) {
        return `${(num / 1000).toFixed(1)} K`;
    }
    return num.toLocaleString();
}
//# sourceMappingURL=numberUtils.js.map