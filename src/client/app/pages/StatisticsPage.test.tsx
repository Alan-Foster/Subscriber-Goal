// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRoutes } from "../../../shared/routes";
import type {
  StatisticsComparableValue,
  StatisticsCoverage,
  StatisticsResponse,
} from "../../../shared/types/api";
import { StatisticsPage } from "./StatisticsPage";
import { getStatisticsMetricGroups } from "./statisticsMetricGroups";

const unavailable: StatisticsComparableValue = {
  value: null,
  previousValue: null,
  absoluteChange: null,
  percentChange: null,
  comparisonStatus: "unavailable",
};

const increase: StatisticsComparableValue = {
  value: 12,
  previousValue: 8,
  absoluteChange: 4,
  percentChange: 50,
  comparisonStatus: "increase",
};

const coveragePeriod = {
  status: "unavailable",
  coveredHours: 0,
  requestedHours: 24,
} as const;

const coverage: StatisticsCoverage = {
  firstKnownAt: null,
  inferredFromLegacyData: false,
  current: coveragePeriod,
  previous: coveragePeriod,
};

const emptyReport: StatisticsResponse = {
  schemaVersion: 2,
  subreddit: { name: "Example" },
  period: {
    hours: 24,
    generatedAt: "2026-01-03T00:00:00Z",
    start: "2026-01-02T00:00:00Z",
    end: "2026-01-03T00:00:00Z",
    previousStart: "2026-01-01T00:00:00Z",
    previousEnd: "2026-01-02T00:00:00Z",
    bucketGranularitySeconds: 3600,
  },
  metrics: {
    traffic: { impressions: unavailable, viewingSessions: unavailable },
    visitors: {
      unique: unavailable,
      new: unavailable,
      returning: unavailable,
      returningRate: unavailable,
    },
    membership: {
      appTrackedSubscribedSessions: unavailable,
      joinEligibleSessions: unavailable,
    },
    joins: {
      clicks: unavailable,
      uniqueClickSessions: unavailable,
      confirmed: unavailable,
      clickSuccessRate: unavailable,
      ctr: unavailable,
    },
    ctas: {
      clicks: unavailable,
      uniqueClickSessions: unavailable,
      eligibleSessions: unavailable,
      ctr: unavailable,
      byLabel: [],
    },
    ctaOnly: {
      clicks: unavailable,
      uniqueClickSessions: unavailable,
      eligibleSessions: unavailable,
      ctr: unavailable,
    },
    interactions: {
      uniqueSessions: unavailable,
      eligibleSessions: unavailable,
      ctr: unavailable,
    },
    legacy: { unclassifiedCtaClicks: unavailable },
  },
  coverage: {
    trafficAndVisitors: coverage,
    sessionsAndInteractions: coverage,
    ctrInvariants: coverage,
  },
  methodology: {
    formulas: {},
    uniqueCounting: "",
    newVisitorDefinition: "",
    returningVisitorDefinition: "",
    anonymousIdentity: "",
    membership: "",
    retentionDays: 30,
    dedupeWindowHours: 48,
    approximationLimits: "",
    sessionDefinition: "",
    ctrCoverageDefinition: "",
  },
};

describe("getStatisticsMetricGroups", () => {
  it("keeps the report group order and appends CTA label metrics", () => {
    const metrics = {
      ...emptyReport.metrics,
      ctas: {
        ...emptyReport.metrics.ctas,
        byLabel: [
          { label: "Read more", clicks: increase, uniqueSessions: unavailable },
        ],
      },
    };
    const groups = getStatisticsMetricGroups(metrics);
    expect(groups.map(({ name }) => name)).toEqual([
      "Traffic",
      "Visitors",
      "Membership",
      "Join Performance",
      "Secondary CTAs",
      "CTA-only Performance",
      "Overall",
    ]);
    expect(
      groups.find(({ name }) => name === "Secondary CTAs")?.rows.slice(-2),
    ).toEqual([
      { label: "Read more — clicks", value: increase },
      { label: "Read more — unique sessions", value: unavailable },
    ]);
    expect(
      groups.find(({ name }) => name === "Overall")?.rows.at(-1),
    ).toMatchObject({
      label: "Overall interaction CTR",
      percent: true,
    });
  });
});

describe("StatisticsPage", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const fetchReport = vi.fn<typeof fetch>();

  const renderPage = () =>
    act(async () => {
      root.render(<StatisticsPage onReturn={vi.fn()} language="en" />);
    });

  const metricValues = (metric: string) => {
    const row = Array.from(container.querySelectorAll("tbody tr")).find(
      (candidate) => candidate.querySelector("td div")?.textContent === metric,
    );
    return Array.from(row?.querySelectorAll("td") ?? [])
      .slice(1)
      .map((cell) => cell.textContent);
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", fetchReport);
    fetchReport.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows loading while the request is pending and aborts on unmount", async () => {
    fetchReport.mockImplementation(() => new Promise(() => {}));
    await renderPage();

    expect(container.textContent).toContain("Loading statistics…");
    expect(container.querySelector("table")).toBeNull();
    const [url, options] = fetchReport.mock.calls[0]!;
    expect(url).toBe(`${apiRoutes.statistics}?hours=24`);
    expect(options?.signal?.aborted).toBe(false);
    await act(async () => root.render(null));
    expect(options?.signal?.aborted).toBe(true);
  });

  it("renders unavailable values for a report with no data", async () => {
    fetchReport.mockResolvedValue(Response.json(emptyReport));
    await renderPage();

    expect(metricValues("App impressions")).toEqual(["—", "—", "—"]);
    expect(metricValues("Join CTR")).toEqual(["—", "—", "—"]);
    expect(container.textContent).toContain(
      "Traffic coverage: unavailable (0/24 hours)",
    );
  });

  it("shows the load error and retries the same period", async () => {
    fetchReport.mockResolvedValueOnce(new Response(null, { status: 503 }));
    fetchReport.mockResolvedValueOnce(Response.json(emptyReport));
    await renderPage();

    expect(container.textContent).toContain(
      "Couldn’t load statistics. Try again.",
    );
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    );
    expect(retry).toBeDefined();
    await act(async () => retry?.click());

    expect(fetchReport.mock.calls.map(([url]) => url)).toEqual([
      `${apiRoutes.statistics}?hours=24`,
      `${apiRoutes.statistics}?hours=24`,
    ]);
    expect(metricValues("App impressions")).toEqual(["—", "—", "—"]);
  });

  it("renders populated metrics, CTA label breakdowns, and the matching JSON", async () => {
    const report: StatisticsResponse = {
      ...emptyReport,
      metrics: {
        ...emptyReport.metrics,
        traffic: { ...emptyReport.metrics.traffic, impressions: increase },
        joins: { ...emptyReport.metrics.joins, ctr: increase },
        ctas: {
          ...emptyReport.metrics.ctas,
          byLabel: [
            { label: "Read more", clicks: increase, uniqueSessions: increase },
          ],
        },
      },
    };
    fetchReport.mockResolvedValue(Response.json(report));
    await renderPage();

    expect(metricValues("App impressions")).toEqual(["12", "8", "+50%"]);
    expect(metricValues("Join CTR")).toEqual(["12%", "8%", "+50%"]);
    expect(metricValues("Read more — unique sessions")).toEqual([
      "12",
      "8",
      "+50%",
    ]);
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="Statistics JSON"]',
      )?.value,
    ).toBe(JSON.stringify(report));
  });
});
