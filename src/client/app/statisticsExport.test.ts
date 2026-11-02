import { describe, expect, it } from "vitest";
import type { StatisticsResponse } from "../../shared/types/api";
import { statisticsToCsv } from "./statisticsExport";

const metric = {
  value: 1,
  previousValue: 0,
  absoluteChange: 1,
  percentChange: null,
  comparisonStatus: "new" as const,
};

const report: StatisticsResponse = {
  schemaVersion: 1,
  subreddit: { name: "ExampleSub" },
  period: {
    hours: 24,
    generatedAt: "2026-11-02T12:00:00.000Z",
    start: "2026-11-01T13:00:00.000Z",
    end: "2026-11-02T12:00:00.000Z",
    previousStart: "2026-10-31T13:00:00.000Z",
    previousEnd: "2026-11-01T13:00:00.000Z",
    bucketGranularitySeconds: 3600,
  },
  metrics: {
    loads: { total: metric, subscribed: metric, unsubscribed: metric },
    visitors: {
      unique: metric,
      new: metric,
      returning: metric,
      returningRate: metric,
    },
    joins: { clicks: metric, confirmed: metric, conversionRate: metric },
    ctas: {
      clicks: metric,
      conversionRate: metric,
      byLabel: [
        { label: 'Visit "Docs", now', clicks: metric, uniqueUsers: metric },
      ],
    },
  },
  methodology: {
    uniqueCounting: "approximate",
    newVisitorDefinition: "new",
    returningVisitorDefinition: "returning",
    anonymousIdentity: "browser",
    membership: "app tracked",
    retentionDays: 30,
    collectionStartedAt: "deployment",
  },
};

describe("statistics CSV export", () => {
  it("includes metadata, comparisons, and escaped CTA labels", () => {
    const csv = statisticsToCsv(report);
    expect(csv).toContain("subreddit,ExampleSub");
    expect(csv).toContain("loads.total,,1,0,1,,new");
    expect(csv).toContain('ctas.by_label.clicks,"Visit ""Docs"", now"');
  });
});
