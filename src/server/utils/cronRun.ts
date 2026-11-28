import { logDiagnostic } from "../../shared/diagnostics";
import type { RedisClient } from "../types";

// Cron rule (AGENTS.md, "Silent failures"): every action a repeating job
// performs has a command-line outcome and error handling, and a failure that
// recurs across runs is visible as recurring. Each run ends with one summary
// line that also proves the job ran.

export type CronActionOutcome =
  | { status: "acted"; detail?: string }
  | { status: "skipped"; reason: string }
  | { status: "idle" };

type RecordedOutcome =
  | CronActionOutcome
  | { status: "ran" }
  | { status: "failed"; repeatCount: number };

type FailureRecord = { count: number; firstSeenMs: number; lastError: string };

/** One Redis hash per job: field = action name, value = FailureRecord JSON. */
export const cronActionFailuresKey = (job: string): string =>
  `cron_action_failures_v1:${job}`;
/** Failure records expire after a week without any failure. */
export const cronActionFailureTtlSeconds = 7 * 24 * 60 * 60;

const maxErrorTextLength = 200;

function parseFailure(raw: string | undefined): FailureRecord | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<FailureRecord>;
    if (
      typeof value.count === "number" &&
      typeof value.firstSeenMs === "number"
    ) {
      return {
        count: value.count,
        firstSeenMs: value.firstSeenMs,
        lastError: String(value.lastError ?? ""),
      };
    }
  } catch {
    // diagnostic-allow-silent: an unreadable record is replaced on the next failure and reported in the summary as a fresh failure.
  }
  return undefined;
}

function describeOutcome(outcome: RecordedOutcome, durationMs: number): string {
  const timing = `${durationMs}ms`;
  switch (outcome.status) {
    case "skipped":
      return `skipped(${outcome.reason}) ${timing}`;
    case "failed":
      return `failed(x${outcome.repeatCount}) ${timing}`;
    case "acted":
      return outcome.detail
        ? `acted(${outcome.detail}) ${timing}`
        : `acted ${timing}`;
    default:
      return `${outcome.status} ${timing}`;
  }
}

export type CronRun = {
  /**
   * Runs one action. A thrown error is logged with its repeat count and
   * swallowed so later actions still run; the result is then `undefined`.
   */
  action<T>(
    name: string,
    run: () => Promise<T>,
    outcomeOf?: (result: T) => CronActionOutcome,
  ): Promise<T | undefined>;
  /** Records an action that was deliberately not run, with its reason. */
  skip(name: string, reason: string): void;
  /** Persists failure counts and prints the run's summary line. */
  finish(): Promise<void>;
};

export async function startCronRun(
  redis: RedisClient,
  job: string,
  nowMs: () => number = Date.now,
): Promise<CronRun> {
  const startedAt = nowMs();
  const key = cronActionFailuresKey(job);
  let previous: Record<string, string> = {};
  try {
    previous = (await redis.hGetAll(key)) ?? {};
  } catch (error) {
    logDiagnostic(
      "warn",
      "cron_failure_state_unavailable",
      { workflow: job, phase: "load" },
      error,
    );
  }
  const outcomes = new Map<string, { outcome: RecordedOutcome; ms: number }>();
  const failures = new Map<string, FailureRecord>();
  const recovered: string[] = [];

  return {
    async action(name, run, outcomeOf) {
      const actionStart = nowMs();
      try {
        const result = await run();
        const outcome: RecordedOutcome = outcomeOf
          ? outcomeOf(result)
          : { status: "ran" };
        outcomes.set(name, { outcome, ms: nowMs() - actionStart });
        const prior = parseFailure(previous[name]);
        if (prior) {
          recovered.push(name);
          logDiagnostic("info", "cron_action_recovered", {
            workflow: job,
            phase: name,
            previousFailures: prior.count,
            firstSeenAt: new Date(prior.firstSeenMs).toISOString(),
          });
        }
        return result;
      } catch (error) {
        const prior = parseFailure(previous[name]);
        const failure: FailureRecord = {
          count: (prior?.count ?? 0) + 1,
          firstSeenMs: prior?.firstSeenMs ?? actionStart,
          lastError: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, maxErrorTextLength),
        };
        failures.set(name, failure);
        outcomes.set(name, {
          outcome: { status: "failed", repeatCount: failure.count },
          ms: nowMs() - actionStart,
        });
        logDiagnostic(
          "error",
          "cron_action_failed",
          {
            workflow: job,
            phase: name,
            repeatCount: failure.count,
            firstSeenAt: new Date(failure.firstSeenMs).toISOString(),
            recurring: failure.count > 1,
          },
          error,
        );
        return undefined;
      }
    },

    skip(name, reason) {
      outcomes.set(name, { outcome: { status: "skipped", reason }, ms: 0 });
    },

    async finish() {
      await persistFailureState(redis, key, job, failures, recovered);
      const context: Record<string, string | number | boolean> = {
        workflow: job,
        phase: "run_summary",
        durationMs: nowMs() - startedAt,
        failed: failures.size,
        recurringFailures: [...failures.values()].filter((f) => f.count > 1)
          .length,
      };
      for (const [name, { outcome, ms }] of outcomes) {
        context[`a_${name}`] = describeOutcome(outcome, ms);
      }
      logDiagnostic(
        failures.size > 0 ? "warn" : "info",
        "cron_run_summary",
        context,
      );
    },
  };
}

async function persistFailureState(
  redis: RedisClient,
  key: string,
  job: string,
  failures: Map<string, FailureRecord>,
  recovered: string[],
): Promise<void> {
  try {
    if (failures.size > 0) {
      await redis.hSet(
        key,
        Object.fromEntries(
          [...failures].map(([name, failure]) => [
            name,
            JSON.stringify(failure),
          ]),
        ),
      );
      await redis.expire(key, cronActionFailureTtlSeconds);
    }
    if (recovered.length > 0) await redis.hDel(key, recovered);
  } catch (error) {
    logDiagnostic(
      "warn",
      "cron_failure_state_unavailable",
      { workflow: job, phase: "persist" },
      error,
    );
  }
}
