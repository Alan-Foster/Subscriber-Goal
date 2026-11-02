import type {
  StatisticsComparableValue,
  StatisticsResponse,
} from "../../shared/types/api";

const escapeCsv = (value: string | number | null): string => {
  const text = value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function statisticsToCsv(report: StatisticsResponse): string {
  const rows: Array<Array<string | number | null>> = [
    ["subreddit", report.subreddit.name],
    ["period_hours", report.period.hours],
    ["period_start", report.period.start],
    ["period_end", report.period.end],
    ["generated_at", report.period.generatedAt],
    [],
    [
      "metric",
      "label",
      "value",
      "previous_value",
      "absolute_change",
      "percent_change",
      "comparison_status",
    ],
  ];
  const add = (
    metric: string,
    value: StatisticsComparableValue,
    label = "",
  ) => {
    rows.push([
      metric,
      label,
      value.value,
      value.previousValue,
      value.absoluteChange,
      value.percentChange,
      value.comparisonStatus,
    ]);
  };
  add("loads.total", report.metrics.loads.total);
  add("loads.subscribed", report.metrics.loads.subscribed);
  add("loads.unsubscribed", report.metrics.loads.unsubscribed);
  add("visitors.unique", report.metrics.visitors.unique);
  add("visitors.new", report.metrics.visitors.new);
  add("visitors.returning", report.metrics.visitors.returning);
  add("visitors.returning_rate_percent", report.metrics.visitors.returningRate);
  add("joins.clicks", report.metrics.joins.clicks);
  add("joins.confirmed", report.metrics.joins.confirmed);
  add("joins.conversion_rate_percent", report.metrics.joins.conversionRate);
  add("ctas.clicks", report.metrics.ctas.clicks);
  add("ctas.conversion_rate_percent", report.metrics.ctas.conversionRate);
  for (const cta of report.metrics.ctas.byLabel) {
    add("ctas.by_label.clicks", cta.clicks, cta.label);
    add("ctas.by_label.unique_users", cta.uniqueUsers, cta.label);
  }
  return rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n");
}

export function downloadStatisticsCsv(report: StatisticsResponse): void {
  const blob = new Blob([statisticsToCsv(report)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `subscriber-goal-${report.subreddit.name}-${report.period.hours}h.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}
