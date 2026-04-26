import { describe, expect, it } from 'vitest';
import { formatSubscriberCount } from './numberFormat';

describe('formatSubscriberCount', () => {
  it.each<[number, string]>([
    [5000, '5000'],
    [9999, '9999'],
    [10000, '10k'],
    [15000, '15k'],
    [15100, '15.1k'],
    [15900, '15.9k'],
    [15420, '15420'],
    [15999, '15999'],
    [15001, '15001'],
    [1000000, '1m'],
    [1500000, '1.5m'],
    [1542000, '1.542m'],
    [1542123, '1542123'],
  ])('formats %d as %s', (value, expected) => {
    expect(formatSubscriberCount(value)).toBe(expected);
  });
});
