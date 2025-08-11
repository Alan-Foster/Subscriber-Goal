/**
 * @file Utility functions used to format or suggest subscriber numbers.
 */

/**
 * Round the number to nearest 1k or 1m regardless of exact value eg 12,456 to 12.4k
 * Used for number of actual subscribers to render (912 K / 1 million) instead of (912345 / 1000000)
 * Ideal for international communities because Europe vs USA use different thousands denominators
 * @param num - The number to format.
 * @returns Exact number if less than 10k, otherwise rounded to the nearest thousand or million and one decimal place with the appropriate suffix.
*/
export function formatNumberAlwaysRound (num: number): string {
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)} M`;
  } else if (num >= 10000) {
    return `${(num / 1000).toFixed(1)} K`;
  }
  return num.toString();
}

/**
 * Round the number to the nearest 1k or 1m unless it's an exact goal eg 12,345,678
 * Used for subscriber goal which is usually a round number (300k) but may be specific (1,234,567)
 * @param num - The number to format.
 * @returns Formats the number with one decimal place and appropriate suffix if it's a round number, otherwise returns the number's toLocaleString.
 */
export function formatNumberUnlessExact (num: number): string {
  if (num >= 1000000 && num % 100000 === 0) {
    return `${(num / 1000000).toFixed(1)} million`;
  } else if (num >= 10000 && num % 1000 === 0) {
    return `${(num / 1000).toFixed(1)} K`;
  }
  return num.toLocaleString(); // Use toLocaleString to add commas for readability
}

/**
 * This function returns the recommended default subscriber goal based on the current subscriber count.
 * @param subscriberCount Current subscriber count of the subreddit.
 * @returns Suggested goal for the subscriber goal post, usually a nice round number, always greater than the current subscriber count.
 */
export const getDefaultSubscriberGoal = (subscriberCount: number): number => {
  /* eslint-disable array-element-newline */
  const thresholds = [
    5, 10, 15, 20, 25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750,
    1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500,
    10000, 15000, 20000, 25000, 30000, 40000, 50000, 60000, 75000, 80000, 90000,
    100000, 150000, 200000, 300000, 400000, 500000, 600000, 750000, 800000, 900000,
    1000000, 1500000, 2000000, 3000000, 5000000, 7500000,
    10000000, 15000000, 20000000, 25000000, 30000000,
  ];
    // The thresholds defined above have to be in ascending order.
  for (const threshold of thresholds) {
    if (subscriberCount < threshold) {
      return threshold;
    }
  }

  return subscriberCount + 1000000; // Add 1 million per goal after 20 million
};

