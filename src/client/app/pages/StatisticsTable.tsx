import type {
  StatisticsComparableValue,
  StatisticsResponse,
} from "../../../shared/types/api";
import { getStatisticsMetricGroups } from "./statisticsMetricGroups";

const ui = {
  metric: "Metric",
  current: "Current",
  previous: "Previous",
  change: "Change",
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

export const StatisticsTable = ({
  metrics,
}: {
  metrics: StatisticsResponse["metrics"];
}) => {
  const groups = getStatisticsMetricGroups(metrics);
  return (
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
  );
};
