import { useEffect, useRef, useState } from "react";
import { showToast } from "@devvit/web/client";
import { apiRoutes } from "../../../shared/routes";
import type {
  StatisticsComparableValue,
  StatisticsResponse,
} from "../../../shared/types/api";
import { downloadStatisticsCsv } from "../statisticsExport";
import { logDiagnostic } from "../../../shared/diagnostics";

type StatisticsPageProps = {
  onReturn: () => void;
};

const formatValue = (value: number, percent = false): string =>
  percent
    ? `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });

const Comparison = ({ value }: { value: StatisticsComparableValue }) => {
  const text =
    value.comparisonStatus === "new"
      ? "New"
      : `${value.absoluteChange > 0 ? "+" : ""}${value.percentChange ?? 0}%`;
  return (
    <span
      className={
        value.comparisonStatus === "increase" ||
        value.comparisonStatus === "new"
          ? "text-green-600 dark:text-green-400"
          : value.comparisonStatus === "decrease"
            ? "text-red-600 dark:text-red-400"
            : "text-[color:var(--sg-text-muted)]"
      }
    >
      {text}
    </span>
  );
};

const MetricCard = ({
  label,
  value,
  percent = false,
}: {
  label: string;
  value: StatisticsComparableValue;
  percent?: boolean;
}) => (
  <div className="rounded-lg border border-[color:var(--sg-border)] bg-[color:var(--sg-surface)] p-2 shadow-sm">
    <div className="truncate text-[10px] font-semibold tracking-wide text-[color:var(--sg-text-muted)] uppercase">
      {label}
    </div>
    <div className="flex items-end justify-between gap-2">
      <span className="text-lg font-bold">
        {formatValue(value.value, percent)}
      </span>
      <span className="text-[10px]">
        <Comparison value={value} />
      </span>
    </div>
  </div>
);

export const StatisticsPage = ({ onReturn }: StatisticsPageProps) => {
  const [hours, setHours] = useState<24 | 168>(24);
  const [report, setReport] = useState<StatisticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetch(`${apiRoutes.statistics}?hours=${hours}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as StatisticsResponse;
      })
      .then((nextReport) => setReport(nextReport))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        logDiagnostic(
          "warn",
          "statistics_load_failed",
          { workflow: "statistics", phase: "dashboard", hours },
          cause,
        );
        setError(
          cause instanceof Error
            ? `Statistics could not be loaded (${cause.message}).`
            : "Statistics could not be loaded.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [hours, reloadKey]);

  const json = report ? JSON.stringify(report) : "";
  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(json);
    } catch (error) {
      logDiagnostic(
        "warn",
        "statistics_copy_failed",
        { workflow: "statistics", phase: "clipboard" },
        error,
      );
      jsonInputRef.current?.focus();
      jsonInputRef.current?.select();
      document.execCommand("copy");
    }
    showToast({ text: "Statistics JSON copied.", appearance: "success" });
  };

  return (
    <div
      className="absolute inset-0 z-20 overflow-y-auto bg-[color:var(--sg-bg)] text-left text-[color:var(--sg-text-primary)]"
      data-statistics-page="true"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            className="cursor-pointer rounded-full border border-[color:var(--sg-border)] px-3 py-1 text-xs font-semibold"
            onClick={onReturn}
          >
            ← Return
          </button>
          <h1 className="text-base font-bold">Statistics</h1>
          <div className="flex rounded-full border border-[color:var(--sg-border)] p-0.5 text-xs">
            {([24, 168] as const).map((period) => (
              <button
                key={period}
                type="button"
                className={`cursor-pointer rounded-full px-2 py-1 ${hours === period ? "bg-[color:var(--sg-accent)] text-white" : ""}`}
                onClick={() => setHours(period)}
              >
                {period === 24 ? "24 Hours" : "7 Days"}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="py-12 text-center text-sm text-[color:var(--sg-text-muted)]">
            Loading statistics…
          </div>
        ) : error ? (
          <div className="rounded-lg border border-red-400 p-3 text-sm">
            {error}
            <button
              type="button"
              className="ml-2 cursor-pointer underline"
              onClick={() => setReloadKey((value) => value + 1)}
            >
              Retry
            </button>
          </div>
        ) : report ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <MetricCard
                label="App loads"
                value={report.metrics.loads.total}
              />
              <MetricCard
                label="Unique visitors"
                value={report.metrics.visitors.unique}
              />
              <MetricCard
                label="New visitors"
                value={report.metrics.visitors.new}
              />
              <MetricCard
                label="Returning visitors"
                value={report.metrics.visitors.returning}
              />
              <MetricCard
                label="Join clicks"
                value={report.metrics.joins.clicks}
              />
              <MetricCard
                label="Confirmed joins"
                value={report.metrics.joins.confirmed}
              />
              <MetricCard
                label="Join conversion"
                value={report.metrics.joins.conversionRate}
                percent
              />
              <MetricCard
                label="Returning rate"
                value={report.metrics.visitors.returningRate}
                percent
              />
              <MetricCard
                label="CTA clicks"
                value={report.metrics.ctas.clicks}
              />
              <MetricCard
                label="CTA conversion"
                value={report.metrics.ctas.conversionRate}
                percent
              />
            </div>

            <div className="overflow-x-auto rounded-lg border border-[color:var(--sg-border)]">
              <table className="w-full text-xs">
                <thead className="bg-[color:var(--sg-surface-muted)]">
                  <tr>
                    <th className="p-2 text-left">Load membership</th>
                    <th>Current</th>
                    <th>Previous</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {(["subscribed", "unsubscribed"] as const).map((key) => {
                    const value = report.metrics.loads[key];
                    return (
                      <tr
                        key={key}
                        className="border-t border-[color:var(--sg-border)]"
                      >
                        <td className="p-2 capitalize">{key}</td>
                        <td className="text-center">{value.value}</td>
                        <td className="text-center">{value.previousValue}</td>
                        <td className="text-center">
                          <Comparison value={value} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="overflow-x-auto rounded-lg border border-[color:var(--sg-border)]">
              <table className="w-full text-xs">
                <thead className="bg-[color:var(--sg-surface-muted)]">
                  <tr>
                    <th className="p-2 text-left">Secondary CTA</th>
                    <th>Clicks</th>
                    <th>Unique users</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {report.metrics.ctas.byLabel.length === 0 ? (
                    <tr>
                      <td
                        className="p-3 text-[color:var(--sg-text-muted)]"
                        colSpan={4}
                      >
                        No secondary CTA activity in this period.
                      </td>
                    </tr>
                  ) : (
                    report.metrics.ctas.byLabel.map((cta) => (
                      <tr
                        key={cta.label}
                        className="border-t border-[color:var(--sg-border)]"
                      >
                        <td className="max-w-48 truncate p-2">{cta.label}</td>
                        <td className="text-center">{cta.clicks.value}</td>
                        <td className="text-center">{cta.uniqueUsers.value}</td>
                        <td className="text-center">
                          <Comparison value={cta.clicks} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="cursor-pointer rounded-full bg-[color:var(--sg-accent)] px-3 py-1.5 text-xs font-semibold text-white"
                onClick={() => downloadStatisticsCsv(report)}
              >
                Export CSV
              </button>
              <button
                type="button"
                className="cursor-pointer rounded-full border border-[color:var(--sg-border)] px-3 py-1.5 text-xs font-semibold"
                onClick={() => void copyJson()}
              >
                Copy JSON
              </button>
              <input
                ref={jsonInputRef}
                aria-label="Statistics JSON"
                className="h-7 min-w-48 flex-1 rounded border border-[color:var(--sg-border)] bg-[color:var(--sg-surface)] px-2 font-mono text-[10px]"
                readOnly
                value={json}
                onClick={(event) => event.currentTarget.select()}
              />
            </div>

            <p className="pb-2 text-[10px] leading-4 text-[color:var(--sg-text-muted)]">
              Unique, new, and returning visitors are approximate.{" "}
              {report.methodology.membership}{" "}
              {report.methodology.anonymousIdentity} Data is retained for{" "}
              {report.methodology.retentionDays} days.
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
};
