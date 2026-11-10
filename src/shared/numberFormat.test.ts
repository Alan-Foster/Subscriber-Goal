import { describe, expect, it } from "vitest";
import {
  formatRoundedSubscriberCount,
  formatSubscriberCount,
} from "./numberFormat";

describe("formatSubscriberCount", () => {
  it.each<[number, string]>([
    [5000, "5000"],
    [9999, "9999"],
    [10000, "10k"],
    [15000, "15k"],
    [15100, "15.1k"],
    [15900, "15.9k"],
    [15420, "15420"],
    [15999, "15999"],
    [15001, "15001"],
    [1000000, "1m"],
    [1500000, "1.5m"],
    [1542000, "1.542m"],
    [1542123, "1542123"],
  ])("formats %d as %s", (value, expected) => {
    expect(formatSubscriberCount(value)).toBe(expected);
  });
});

describe("formatRoundedSubscriberCount", () => {
  it.each<[number, string]>([
    [9999, "9999"],
    [10000, "10k"],
    [94567, "94.6k"],
    [300000, "300k"],
    [999949, "999.9k"],
    [999950, "1m"],
    [1500000, "1.5m"],
    [3326878, "3.3m"],
  ])("formats %d as %s", (value, expected) => {
    expect(formatRoundedSubscriberCount(value)).toBe(expected);
  });
});
