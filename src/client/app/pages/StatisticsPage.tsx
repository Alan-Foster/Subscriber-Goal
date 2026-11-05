import { useEffect, useRef, useState } from "react";
import { showToast } from "@devvit/web/client";
import { apiRoutes } from "../../../shared/routes";
import type {
  StatisticsComparableValue,
  StatisticsResponse,
} from "../../../shared/types/api";
import { logDiagnostic } from "../../../shared/diagnostics";

type Props = { onReturn: () => void };
type Row = {
  label: string;
  value: StatisticsComparableValue;
  percent?: boolean;
  detail?: string;
};
type Group = { name: string; rows: Row[] };
const ui = {
  return: "← Return",
  title: "Statistics",
  loading: "Loading statistics…",
  retry: "Retry",
  metric: "Metric",
  current: "Current",
  previous: "Previous",
  change: "Change",
  copyJson: "Copy JSON",
  jsonLabel: "Statistics JSON",
};
const formatted = (value: number | null, percent = false) =>
  value === null
    ? "—"
    : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${percent ? "%" : ""}`;
const Change = ({ value }: { value: StatisticsComparableValue }) => {
  if (value.comparisonStatus === "unavailable")
    return <span className="text-[color:var(--sg-text-muted)]">—</span>;
  const text =
    value.comparisonStatus === "new"
      ? "New"
      : `${value.absoluteChange !== null && value.absoluteChange > 0 ? "+" : ""}${value.percentChange ?? 0}%`;
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

export const StatisticsPage = ({ onReturn }: Props) => {
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
      .then(setReport)
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
    } catch (cause) {
      logDiagnostic(
        "warn",
        "statistics_copy_failed",
        { workflow: "statistics", phase: "clipboard" },
        cause,
      );
      jsonInputRef.current?.focus();
      jsonInputRef.current?.select();
      document.execCommand("copy");
    }
    showToast({ text: "Statistics JSON copied.", appearance: "success" });
  };

  const groups: Group[] = report
    ? [
        {
          name: "Traffic",
          rows: [
            {
              label: "App impressions",
              value: report.metrics.traffic.impressions,
              detail: "Successful app initializations",
            },
            {
              label: "Viewing sessions",
              value: report.metrics.traffic.viewingSessions,
              detail: "Visitor + post + UTC hour",
            },
          ],
        },
        {
          name: "Visitors",
          rows: [
            { label: "Unique visitors", value: report.metrics.visitors.unique },
            {
              label: "Returning visitors",
              value: report.metrics.visitors.returning,
            },
            {
              label: "Returning rate",
              value: report.metrics.visitors.returningRate,
              percent: true,
            },
          ],
        },
        {
          name: "Membership",
          rows: [
            {
              label: "App-tracked subscribed sessions",
              value: report.metrics.membership.appTrackedSubscribedSessions,
            },
            {
              label: "Join-eligible sessions",
              value: report.metrics.membership.joinEligibleSessions,
              detail: "Not verified Reddit non-membership",
            },
          ],
        },
        {
          name: "Join Performance",
          rows: [
            { label: "Join clicks", value: report.metrics.joins.clicks },
            {
              label: "Unique Join-click sessions",
              value: report.metrics.joins.uniqueClickSessions,
            },
            { label: "Confirmed joins", value: report.metrics.joins.confirmed },
            {
              label: "Join click success rate",
              value: report.metrics.joins.clickSuccessRate,
              percent: true,
              detail: "Confirmed joins / Join clicks",
            },
            {
              label: "Join CTR",
              value: report.metrics.joins.ctr,
              percent: true,
              detail: "Unique click sessions / eligible sessions",
            },
          ],
        },
        {
          name: "Secondary CTAs",
          rows: [
            { label: "CTA clicks", value: report.metrics.ctas.clicks },
            {
              label: "Unique CTA-click sessions",
              value: report.metrics.ctas.uniqueClickSessions,
            },
            {
              label: "Eligible subscribed CTA sessions",
              value: report.metrics.ctas.eligibleSessions,
            },
            {
              label: "Secondary CTA CTR",
              value: report.metrics.ctas.ctr,
              percent: true,
              detail: "Unique click sessions / eligible sessions",
            },
            ...report.metrics.ctas.byLabel.flatMap((cta) => [
              { label: `${cta.label} — clicks`, value: cta.clicks },
              {
                label: `${cta.label} — unique sessions`,
                value: cta.uniqueSessions,
              },
            ]),
          ],
        },
        {
          name: "CTA-only Performance",
          rows: [
            { label: "CTA-only clicks", value: report.metrics.ctaOnly.clicks },
            {
              label: "Unique CTA-only click sessions",
              value: report.metrics.ctaOnly.uniqueClickSessions,
            },
            {
              label: "Eligible CTA-only sessions",
              value: report.metrics.ctaOnly.eligibleSessions,
            },
            {
              label: "CTA-only CTR",
              value: report.metrics.ctaOnly.ctr,
              percent: true,
            },
          ],
        },
        {
          name: "Overall",
          rows: [
            {
              label: "Interacting sessions",
              value: report.metrics.interactions.uniqueSessions,
            },
            {
              label: "Eligible interaction sessions",
              value: report.metrics.interactions.eligibleSessions,
            },
            {
              label: "Overall interaction CTR",
              value: report.metrics.interactions.ctr,
              percent: true,
              detail: "Unique interacting sessions / eligible sessions",
            },
          ],
        },
      ]
    : [];

  return (
    <div
      className="sg-statistics-scroll absolute inset-0 z-20 min-h-0 overflow-y-auto overscroll-contain bg-[color:var(--sg-bg)] text-left text-[color:var(--sg-text-primary)] [touch-action:pan-y] [-webkit-overflow-scrolling:touch]"
      data-statistics-page="true"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-3 pb-6">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            className="cursor-pointer rounded-full border border-[color:var(--sg-border)] px-3 py-1 text-xs font-semibold"
            onClick={onReturn}
          >
            {ui.return}
          </button>
          <h1 className="text-base font-bold">{ui.title}</h1>
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
            {ui.loading}
          </div>
        ) : error ? (
          <div className="rounded-lg border border-red-400 p-3 text-sm">
            {error}
            <button
              type="button"
              className="ml-2 cursor-pointer underline"
              onClick={() => setReloadKey((value) => value + 1)}
            >
              {ui.retry}
            </button>
          </div>
        ) : report ? (
          <>
            <div className="overflow-x-auto rounded-lg border border-[color:var(--sg-border)]">
              <table className="w-full min-w-[520px] text-xs">
                <thead className="sticky top-0 bg-[color:var(--sg-surface-muted)]">
                  <tr>
                    <th className="p-2 text-left">{ui.metric}</th>
                    <th className="p-2 text-right">{ui.current}</th>
                    <th className="p-2 text-right">{ui.previous}</th>
                    <th className="p-2 text-right">{ui.change}</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.flatMap((group) => [
                    <tr
                      key={`${group.name}-heading`}
                      className="border-t border-[color:var(--sg-border)] bg-[color:var(--sg-surface-muted)]"
                    >
                      <th colSpan={4} className="p-2 text-left font-bold">
                        {group.name}
                      </th>
                    </tr>,
                    ...group.rows.map((row) => (
                      <tr
                        key={`${group.name}-${row.label}`}
                        className="border-t border-[color:var(--sg-border)]"
                      >
                        <td className="p-2">
                          <div>{row.label}</div>
                          {row.detail ? (
                            <div className="text-[10px] text-[color:var(--sg-text-muted)]">
                              {row.detail}
                            </div>
                          ) : null}
                        </td>
                        <td className="p-2 text-right">
                          {formatted(row.value.value, row.percent)}
                        </td>
                        <td className="p-2 text-right">
                          {formatted(row.value.previousValue, row.percent)}
                        </td>
                        <td className="p-2 text-right">
                          <Change value={row.value} />
                        </td>
                      </tr>
                    )),
                  ])}
                </tbody>
              </table>
            </div>
            <div className="text-[10px] leading-4 text-[color:var(--sg-text-muted)]">
              <div>
                {`Traffic coverage: ${report.coverage.trafficAndVisitors.current.status} (${report.coverage.trafficAndVisitors.current.coveredHours}/${report.coverage.trafficAndVisitors.current.requestedHours} hours). Session coverage: ${report.coverage.sessionsAndInteractions.current.status} (${report.coverage.sessionsAndInteractions.current.coveredHours}/${report.coverage.sessionsAndInteractions.current.requestedHours} hours). CTR invariant coverage: ${report.coverage.ctrInvariants.current.status} (${report.coverage.ctrInvariants.current.coveredHours}/${report.coverage.ctrInvariants.current.requestedHours} hours).`}
              </div>
              <div>
                {`Rates show — when no eligible denominator exists. ${report.methodology.sessionDefinition} ${report.methodology.membership} ${report.methodology.anonymousIdentity}`}
              </div>
            </div>
            <div
              className="flex flex-wrap items-center gap-2"
              data-statistics-export-controls="true"
            >
              <button
                type="button"
                className="cursor-pointer rounded-full border border-[color:var(--sg-border)] px-3 py-1.5 text-xs font-semibold"
                onClick={() => void copyJson()}
              >
                {ui.copyJson}
              </button>
              <input
                ref={jsonInputRef}
                aria-label={ui.jsonLabel}
                className="h-7 min-w-48 flex-1 rounded border border-[color:var(--sg-border)] bg-[color:var(--sg-surface)] px-2 font-mono text-[10px]"
                readOnly
                value={json}
                onClick={(event) => event.currentTarget.select()}
              />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
};
