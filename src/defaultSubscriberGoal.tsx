/* eslint-disable array-element-newline */
export const getDefaultSubscriberGoal = (subscriberCount: number): number => {
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
