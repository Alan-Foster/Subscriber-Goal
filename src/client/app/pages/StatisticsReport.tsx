import type { RefObject } from "react";
import type { StatisticsResponse } from "../../../shared/types/api";
import { translate } from "../../../shared/i18n/catalog";
import type { SubGoalLanguage } from "../../../shared/subGoalPostI18n";
import { StatisticsTable } from "./StatisticsTable";

export const StatisticsReport = ({
  report,
  language,
  json,
  jsonInputRef,
  copyJson,
}: {
  report: StatisticsResponse;
  language: SubGoalLanguage;
  json: string;
  jsonInputRef: RefObject<HTMLInputElement | null>;
  copyJson: () => Promise<void>;
}) => {
  return (
    <>
      <StatisticsTable metrics={report.metrics} />
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
          {translate(language, "statistics.copy")}
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
    </>
  );
};
