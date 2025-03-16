
// Round the number to nearest 1k or 1m regardless of exact value eg 12,456 to 12.4k
// Used for number of actual subscribers to render (912 K / 1 million) instead of (912345 / 1000000)
// Ideal for international communities because Europe vs USA use different thousands denominators
function formatNumberAlwaysRound (num: number) {
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)} M`;
  } else if (num >= 10000) {
    return `${(num / 1000).toFixed(1)} K`;
  }
  return num.toString();
}

// Round the number to the nearest 1k or 1m unless it's an exact goal eg 12,345,678
// Used for subscriber goal which is usually a round number (300k) but may be specific (1,234,567)
function formatNumberUnlessExact (num: number) {
  if (num >= 1000000 && num % 100000 === 0) {
    return `${(num / 1000000).toFixed(1)} million`;
  } else if (num >= 10000 && num % 1000 === 0) {
    return `${(num / 1000).toFixed(1)}K`;
  }
  return num.toLocaleString(); // Use toLocaleString to add commas for readability
}

export {formatNumberAlwaysRound, formatNumberUnlessExact};
