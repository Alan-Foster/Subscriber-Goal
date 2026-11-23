import { useEffect, useRef, useState } from "react";
import { showToast } from "@devvit/web/client";
import { apiRoutes } from "../../../shared/routes";
import type { StatisticsResponse } from "../../../shared/types/api";
import { logDiagnostic } from "../../../shared/diagnostics";
import { translate } from "../../../shared/i18n/catalog";
import type { SubGoalLanguage } from "../../../shared/subGoalPostI18n";

import { StatisticsReport } from "./StatisticsReport";

type Props = { onReturn: () => void; language: SubGoalLanguage };
const ui = {
  return: "← Return",
  title: "Statistics",
  loading: "Loading statistics…",
  retry: "Retry",
};
const useStatisticsReport = (language: SubGoalLanguage) => {
  const [hours, setHours] = useState<24 | 168>(24);
  const [report, setReport] = useState<StatisticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
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
        setError(translate(language, "statistics.loadError"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [hours, language, reloadKey]);
  return {
    hours,
    setHours,
    report,
    loading,
    error,
    retry: () => setReloadKey((value) => value + 1),
  };
};

const useStatisticsExport = (
  report: StatisticsResponse | null,
  language: SubGoalLanguage,
) => {
  const jsonInputRef = useRef<HTMLInputElement>(null);
  const json = report ? JSON.stringify(report) : "";
  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(json);
      showToast({
        text: translate(language, "statistics.copied"),
        appearance: "success",
      });
    } catch (cause) {
      logDiagnostic(
        "warn",
        "statistics_copy_failed",
        { workflow: "statistics", phase: "clipboard" },
        cause,
      );
      jsonInputRef.current?.focus();
      jsonInputRef.current?.select();
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- Keep copying available when the webview denies Clipboard API access.
      if (document.execCommand("copy")) {
        showToast({
          text: translate(language, "statistics.copied"),
          appearance: "success",
        });
        return;
      }
      showToast({
        text: translate(language, "statistics.copyFailed"),
        appearance: "neutral",
      });
    }
  };

  return { json, jsonInputRef, copyJson };
};

export const StatisticsPage = ({ onReturn, language }: Props) => {
  const { hours, setHours, report, loading, error, retry } =
    useStatisticsReport(language);
  const statisticsExport = useStatisticsExport(report, language);

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
              onClick={retry}
            >
              {ui.retry}
            </button>
          </div>
        ) : report ? (
          <StatisticsReport
            report={report}
            language={language}
            {...statisticsExport}
          />
        ) : null}
      </div>
    </div>
  );
};
