const trimTrailingZeros = (value: string): string =>
  value.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');

const formatCompact = (
  value: number,
  divisor: number,
  suffix: string,
  maxFractionDigits: number
): string => {
  const scaled = value / divisor;
  return `${trimTrailingZeros(scaled.toFixed(maxFractionDigits))}${suffix}`;
};

export function formatSubscriberCount(value: number): string {
  const normalizedValue = Math.trunc(value);

  if (normalizedValue < 10_000) {
    return normalizedValue.toString();
  }

  if (normalizedValue >= 1_000_000) {
    if (normalizedValue % 1_000 === 0) {
      return formatCompact(normalizedValue, 1_000_000, 'm', 3);
    }
    return normalizedValue.toString();
  }

  if (normalizedValue % 100 === 0) {
    return formatCompact(normalizedValue, 1_000, 'k', 1);
  }

  return normalizedValue.toString();
}
