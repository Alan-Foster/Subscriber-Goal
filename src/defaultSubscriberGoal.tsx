export const getDefaultSubscriberGoal = (subscriberCount: number): number => {
  if (subscriberCount < 5) return 5;
  if (subscriberCount < 10) return 10;
  if (subscriberCount < 15) return 15;
  if (subscriberCount < 20) return 20;
  if (subscriberCount < 25) return 25;
  if (subscriberCount < 50) return 50;
  if (subscriberCount < 75) return 75;
  if (subscriberCount < 100) return 100;
  if (subscriberCount < 150) return 150;
  if (subscriberCount < 200) return 200;
  if (subscriberCount < 250) return 250;  
  if (subscriberCount < 300) return 300;
  if (subscriberCount < 400) return 400;
  if (subscriberCount < 500) return 500;
  if (subscriberCount < 750) return 750;
  if (subscriberCount < 1000) return 1000;
  if (subscriberCount < 1500) return 1500;
  if (subscriberCount < 2000) return 2000;
  if (subscriberCount < 2500) return 2500;
  if (subscriberCount < 3000) return 3000;
  if (subscriberCount < 4000) return 4000;
  if (subscriberCount < 5000) return 5000;
  if (subscriberCount < 7500) return 7500;
  // Ten thousand
  if (subscriberCount < 10000) return 10000;
  if (subscriberCount < 15000) return 15000;
  if (subscriberCount < 20000) return 20000;
  if (subscriberCount < 25000) return 25000;
  if (subscriberCount < 30000) return 30000;
  if (subscriberCount < 40000) return 40000;
  if (subscriberCount < 50000) return 50000;
  if (subscriberCount < 60000) return 60000;  
  if (subscriberCount < 75000) return 75000;
  if (subscriberCount < 80000) return 80000; 
  if (subscriberCount < 90000) return 90000; 
  // One hundred thousand
  if (subscriberCount < 100000) return 100000;
  if (subscriberCount < 150000) return 150000;
  if (subscriberCount < 200000) return 200000;
  if (subscriberCount < 300000) return 300000;
  if (subscriberCount < 400000) return 400000;
  if (subscriberCount < 500000) return 500000;
  if (subscriberCount < 600000) return 600000;
  if (subscriberCount < 750000) return 750000;
  if (subscriberCount < 800000) return 800000;
  if (subscriberCount < 900000) return 900000;
  // One million
  if (subscriberCount < 1000000) return 1000000;
  if (subscriberCount < 1500000) return 1500000;
  if (subscriberCount < 2000000) return 2000000;
  if (subscriberCount < 3000000) return 3000000;
  if (subscriberCount < 5000000) return 5000000;
  if (subscriberCount < 7500000) return 7500000;
  // Ten million
  if (subscriberCount < 10000000) return 10000000;
  if (subscriberCount < 15000000) return 15000000;
  if (subscriberCount < 20000000) return 20000000;
  return subscriberCount + 1000000; // Add 1 million per goal after 20 million
};
