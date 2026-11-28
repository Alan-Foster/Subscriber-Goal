import { afterEach, describe, expect, it, vi } from "vitest";
import type { RedisClient } from "../types";
import {
  cronActionFailureTtlSeconds,
  cronActionFailuresKey,
  startCronRun,
} from "./cronRun";

function createRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const expirations = new Map<string, number>();
  const redis = {
    hGetAll: vi.fn(async (key: string) =>
      Object.fromEntries(hashes.get(key) ?? new Map()),
    ),
    hSet: vi.fn(async (key: string, values: Record<string, string>) => {
      const hash = hashes.get(key) ?? new Map<string, string>();
      for (const [field, value] of Object.entries(values))
        hash.set(field, value);
      hashes.set(key, hash);
      return Object.keys(values).length;
    }),
    hDel: vi.fn(async (key: string, fields: string[]) => {
      const hash = hashes.get(key);
      for (const field of fields) hash?.delete(field);
      return fields.length;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      expirations.set(key, seconds);
    }),
  };
  return {
    redis: redis as unknown as RedisClient,
    mock: redis,
    hashes,
    expirations,
  };
}

type DiagnosticEvent = Record<string, unknown> & { event: string };

function diagnosticEvents(spy: {
  mock: { calls: unknown[][] };
}): DiagnosticEvent[] {
  return spy.mock.calls.map(
    (call) =>
      JSON.parse(
        String(call[0]).replace("[diagnostic] ", ""),
      ) as DiagnosticEvent,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("startCronRun", () => {
  it("keeps running later actions after one throws, and logs the failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { redis } = createRedis();
    const run = await startCronRun(redis, "job");
    const later = vi.fn(async () => "done");

    await expect(
      run.action("first", async () => {
        throw new Error("boom");
      }),
    ).resolves.toBeUndefined();
    await expect(run.action("second", later)).resolves.toBe("done");
    await run.finish();

    expect(later).toHaveBeenCalledOnce();
    const [failed] = diagnosticEvents(error);
    expect(failed).toMatchObject({
      event: "cron_action_failed",
      workflow: "job",
      phase: "first",
      repeatCount: 1,
      recurring: false,
      errorMessage: "boom",
    });
    const [summary] = diagnosticEvents(warn);
    expect(summary).toMatchObject({
      event: "cron_run_summary",
      failed: 1,
      recurringFailures: 0,
    });
    expect(summary?.a_first).toMatch(/^failed\(x1\) \d+ms$/);
    expect(summary?.a_second).toMatch(/^ran \d+ms$/);
  });

  it("counts a failure that repeats across runs, keeping the first-seen time", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { redis, expirations } = createRedis();
    let now = Date.parse("2026-11-28T00:00:00Z");
    const clock = () => now;
    for (let i = 0; i < 3; i += 1) {
      const run = await startCronRun(redis, "job", clock);
      await run.action("flaky", async () => {
        throw new Error("still broken");
      });
      await run.finish();
      now += 60_000;
    }
    const events = diagnosticEvents(error);
    expect(events.map((e) => e.repeatCount)).toEqual([1, 2, 3]);
    expect(events[2]).toMatchObject({
      recurring: true,
      firstSeenAt: "2026-11-28T00:00:00.000Z",
    });
    expect(expirations.get(cronActionFailuresKey("job"))).toBe(
      cronActionFailureTtlSeconds,
    );
  });

  it("logs recovery and clears the failure record once the action succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { redis, hashes } = createRedis();
    const failing = await startCronRun(redis, "job");
    await failing.action("flaky", async () => {
      throw new Error("x");
    });
    await failing.finish();

    const healthy = await startCronRun(redis, "job");
    await healthy.action("flaky", async () => undefined);
    await healthy.finish();

    const events = diagnosticEvents(info);
    expect(events[0]).toMatchObject({
      event: "cron_action_recovered",
      phase: "flaky",
      previousFailures: 1,
    });
    expect(events[1]).toMatchObject({ event: "cron_run_summary", failed: 0 });
    expect(hashes.get(cronActionFailuresKey("job"))?.has("flaky")).toBe(false);
  });

  it("prints skips with their reason and custom outcomes in the summary", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { redis } = createRedis();
    const run = await startCronRun(redis, "job");
    run.skip("gated", "permission_work_paused");
    await run.action(
      "gate",
      async () => false,
      (open) =>
        open
          ? { status: "acted", detail: "open" }
          : { status: "skipped", reason: "gate_closed" },
    );
    await run.finish();
    const [summary] = diagnosticEvents(info);
    expect(summary?.a_gated).toBe("skipped(permission_work_paused) 0ms");
    expect(summary?.a_gate).toMatch(/^skipped\(gate_closed\) \d+ms$/);
  });

  it("still finishes the run when the failure state can't be read or written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { redis, mock } = createRedis();
    mock.hGetAll.mockRejectedValueOnce(new Error("redis down"));
    mock.hSet.mockRejectedValueOnce(new Error("redis down"));
    const run = await startCronRun(redis, "job");
    await run.action("a", async () => {
      throw new Error("x");
    });
    await run.finish();
    const events = diagnosticEvents(warn).map(
      (e) => `${e.event}:${String(e.phase)}`,
    );
    expect(events).toEqual([
      "cron_failure_state_unavailable:load",
      "cron_failure_state_unavailable:persist",
      "cron_run_summary:run_summary",
    ]);
  });

  it("treats an unreadable failure record as a fresh failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { redis } = createRedis();
    await redis.hSet(cronActionFailuresKey("job"), { a: "not json" });
    const run = await startCronRun(redis, "job");
    await run.action("a", async () => {
      throw new Error("x");
    });
    await run.finish();
    expect(diagnosticEvents(error)[0]).toMatchObject({ repeatCount: 1 });
  });
});
