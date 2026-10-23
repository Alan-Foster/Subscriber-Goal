import { afterEach, describe, expect, it, vi } from "vitest";
import type { RedditClient, RedisClient, SubredditId } from "../types";
import {
  inviteNewSubsControlWikiPage,
  inviteNewSubsDataWikiPage,
  inviteNewSubsDataWikiVersion,
  inviteNewSubsDeliveryJobName,
  inviteNewSubsHostSubreddit,
  inviteNewSubsMessageWikiPage,
  inviteNewSubsRecipientCooldownSeconds,
  inviteNewSubsReportRecipient,
  inviteNewSubsReportSubject,
  inviteNewSubsReportWindowMs,
  inviteNewSubsRetentionSeconds,
  inviteNewSubsSubject,
  inviteNewSubsWikiVersion,
  parseInviteNewSubsDiscoveryBatch,
  processInviteNewSubsDelivery,
  processInviteNewSubsPoll,
  processInviteNewSubsReport,
  renderInviteNewSubsMessage,
  type InviteNewSubsDeliveryJob,
  type InviteNewSubsDiscoveryRecord,
} from "./inviteNewSubs";

const inviteNewSubsMessageTemplate = `Detected a newly created public subreddit.

- Subreddit: r/{{subredditName}}
- Top moderator: u/{{topModerator}}
- NSFW: {{isNsfw}}`;

afterEach(() => {
  vi.restoreAllMocks();
});

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly expirations = new Map<string, Date>();
  readonly sortedSets = new Map<string, Map<string, number>>();
  failNextRecordStatus: string | undefined;
  failMetricWrites = false;
  nowMs: number | undefined;

  async get(key: string): Promise<string | undefined> {
    this.expireIfNeeded(key);
    return this.values.get(key);
  }

  private expireIfNeeded(key: string): void {
    const expiration = this.expirations.get(key);
    if (
      this.nowMs !== undefined &&
      expiration !== undefined &&
      expiration.getTime() <= this.nowMs
    ) {
      this.values.delete(key);
      this.sortedSets.delete(key);
      this.expirations.delete(key);
    }
  }

  async set(
    key: string,
    value: string,
    options?: { nx?: boolean; expiration?: Date },
  ): Promise<string> {
    this.expireIfNeeded(key);
    if (options?.nx && this.values.has(key)) return "";
    if (this.failNextRecordStatus) {
      let status: unknown;
      try {
        status = JSON.parse(value).status;
      } catch {
        status = undefined;
      }
      if (status === this.failNextRecordStatus) {
        this.failNextRecordStatus = undefined;
        throw new Error(`failed to store ${String(status)} state`);
      }
    }
    this.values.set(key, value);
    if (options?.expiration) this.expirations.set(key, options.expiration);
    return "OK";
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
    this.sortedSets.delete(key);
    this.expirations.delete(key);
  }

  async expire(key: string, seconds: number): Promise<void> {
    if (this.failMetricWrites) throw new Error("metric storage unavailable");
    const base = this.nowMs ?? Date.now();
    this.expirations.set(key, new Date(base + seconds * 1000));
  }

  async zAdd(
    key: string,
    ...entries: Array<{ member: string; score: number }>
  ): Promise<void> {
    if (this.failMetricWrites) throw new Error("metric storage unavailable");
    this.expireIfNeeded(key);
    const values = this.sortedSets.get(key) ?? new Map<string, number>();
    for (const entry of entries) values.set(entry.member, entry.score);
    this.sortedSets.set(key, values);
  }

  async zRange(
    key: string,
    start: number,
    end: number,
  ): Promise<Array<{ member: string; score: number }>> {
    this.expireIfNeeded(key);
    const values = [...(this.sortedSets.get(key) ?? new Map()).entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((left, right) => left.score - right.score);
    const normalizedEnd = end < 0 ? values.length + end : end;
    return values.slice(start, normalizedEnd + 1);
  }

  async zRem(key: string, members: string[]): Promise<void> {
    const values = this.sortedSets.get(key);
    for (const member of members) values?.delete(member);
  }
}

const asRedis = (redis: FakeRedis): RedisClient =>
  redis as unknown as RedisClient;

const discoveryRecord = (
  id: string,
  displayName: string,
  overrides: Partial<InviteNewSubsDiscoveryRecord> = {},
): InviteNewSubsDiscoveryRecord => ({
  id: id as SubredditId,
  displayName,
  subredditType: "public",
  over18: false,
  subscribers: 1,
  createdUtc: 1_792_699_474,
  url: `/r/${displayName}/`,
  ...overrides,
});

const discoveryJson = (
  records: InviteNewSubsDiscoveryRecord[],
  generatedAt = "2026-10-22T19:00:00Z",
): string =>
  JSON.stringify({
    schemaVersion: 1,
    source: "reddit/subreddits/new",
    generatedAt,
    subreddits: records,
  });

const wikiReddit = ({
  control = "enabled",
  template = inviteNewSubsMessageTemplate,
  data = discoveryJson([discoveryRecord("t5_existing", "Existing")]),
}: {
  control?: string;
  template?: string;
  data?: string;
} = {}) => ({
  getWikiPage: vi.fn(
    async (
      _subredditName: string,
      page: string,
      options?: { wikiVersion?: "v1" | "v2" },
    ) => ({
      content:
        page === inviteNewSubsControlWikiPage
          ? control
          : page === inviteNewSubsMessageWikiPage
            ? template
            : data,
      wikiVersion: options?.wikiVersion ?? inviteNewSubsWikiVersion,
      revisionId: "11111111-1111-1111-1111-111111111111",
      revisionDate: new Date("2026-10-22T18:55:00.000Z"),
    }),
  ),
  getSubredditByName: vi.fn(),
  getModerators: vi.fn(),
  sendPrivateMessage: vi.fn(),
});

const runPoll = (
  reddit: ReturnType<typeof wikiReddit>,
  redis: FakeRedis,
  runJob = vi.fn(),
  now = Date.parse("2026-10-22T19:00:00Z"),
) =>
  processInviteNewSubsPoll({
    reddit: reddit as unknown as RedditClient,
    redis: asRedis(redis),
    scheduler: { runJob },
    subredditName: inviteNewSubsHostSubreddit,
    now: () => now,
  });

describe("parseInviteNewSubsDiscoveryBatch", () => {
  it("accepts the exact versioned discovery contract", () => {
    const record = discoveryRecord("t5_valid", "ValidSub", { over18: true });
    expect(parseInviteNewSubsDiscoveryBatch(discoveryJson([record]))).toEqual({
      schemaVersion: 1,
      source: "reddit/subreddits/new",
      generatedAt: "2026-10-22T19:00:00Z",
      subreddits: [record],
    });
  });

  it.each([
    ["malformed JSON", "{"],
    [
      "unsupported schema",
      JSON.stringify({
        schemaVersion: 2,
        source: "reddit/subreddits/new",
        generatedAt: "2026-10-22T19:00:00Z",
        subreddits: [discoveryRecord("t5_valid", "Valid")],
      }),
    ],
    ["empty batch", discoveryJson([])],
    [
      "duplicate IDs",
      discoveryJson([
        discoveryRecord("t5_same", "One"),
        discoveryRecord("T5_SAME", "Two"),
      ]),
    ],
    [
      "too many records",
      discoveryJson(
        Array.from({ length: 11 }, (_, index) =>
          discoveryRecord(`t5_${index}`, `Sub${index}`),
        ),
      ),
    ],
    [
      "invalid required field",
      discoveryJson([
        discoveryRecord("t5_valid", "Valid", { subscribers: -1 }),
      ]),
    ],
  ])("rejects %s", (_name, content) => {
    expect(() => parseInviteNewSubsDiscoveryBatch(content)).toThrow();
  });
});

describe("processInviteNewSubsPoll", () => {
  it("does nothing outside the dedicated host subreddit", async () => {
    const reddit = wikiReddit();
    const result = await processInviteNewSubsPoll({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(new FakeRedis()),
      scheduler: { runJob: vi.fn() },
      subredditName: "another_subreddit",
    });
    expect(result.status).toBe("wrong_subreddit");
    expect(reddit.getWikiPage).not.toHaveBeenCalled();
  });

  it("reads only the V2 gate while disabled", async () => {
    const reddit = wikiReddit({ control: "Enabled" });
    const redis = new FakeRedis();

    expect((await runPoll(reddit, redis)).status).toBe("disabled");
    expect(reddit.getWikiPage).toHaveBeenCalledOnce();
    expect(reddit.getWikiPage).toHaveBeenCalledWith(
      inviteNewSubsHostSubreddit,
      inviteNewSubsControlWikiPage,
      { wikiVersion: "v2" },
    );
    expect([...redis.values.values()]).toContain("disabled");
  });

  it("reads the V2 gate/template and V1 data before creating a baseline", async () => {
    const now = Date.parse("2026-10-22T19:00:00Z");
    const records = [
      discoveryRecord("t5_new", "Newest"),
      discoveryRecord("t5_old", "Older"),
    ];
    const reddit = wikiReddit({ data: discoveryJson(records) });
    const redis = new FakeRedis();
    const runJob = vi.fn();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    expect(await runPoll(reddit, redis, runJob, now)).toEqual({
      status: "baseline",
      discovered: 2,
      queued: 0,
      skipped: 2,
    });
    expect(reddit.getWikiPage).toHaveBeenNthCalledWith(
      1,
      inviteNewSubsHostSubreddit,
      inviteNewSubsControlWikiPage,
      { wikiVersion: inviteNewSubsWikiVersion },
    );
    expect(reddit.getWikiPage).toHaveBeenNthCalledWith(
      2,
      inviteNewSubsHostSubreddit,
      inviteNewSubsMessageWikiPage,
      { wikiVersion: inviteNewSubsWikiVersion },
    );
    expect(reddit.getWikiPage).toHaveBeenNthCalledWith(
      3,
      inviteNewSubsHostSubreddit,
      inviteNewSubsDataWikiPage,
      { wikiVersion: inviteNewSubsDataWikiVersion },
    );
    expect(
      diagnosticPayload(info, "invite_new_subs_data_fetched"),
    ).toMatchObject({
      pageName: inviteNewSubsDataWikiPage,
      wikiVersion: inviteNewSubsDataWikiVersion,
    });
    expect(reddit.getSubredditByName).not.toHaveBeenCalled();
    expect(runJob).not.toHaveBeenCalled();
    const recordsInRedis = [...redis.values.entries()].filter(([key]) =>
      key.includes(":seen:v2:"),
    );
    expect(recordsInRedis).toHaveLength(2);
    expect(
      recordsInRedis.every(
        ([key, value]) =>
          key.includes("t5_") && JSON.parse(value).status === "baseline",
      ),
    ).toBe(true);
    expect(
      [...redis.expirations.values()].every(
        (expiration) =>
          expiration.getTime() === now + inviteNewSubsRetentionSeconds * 1000,
      ),
    ).toBe(true);
    expect(
      diagnosticPayload(info, "invite_new_subs_poll_completed"),
    ).toMatchObject({
      resultStatus: "baseline",
      fetched: 2,
      new: 2,
      queued: 0,
      skipped: 2,
    });
  });

  it("short-circuits an unchanged generatedAt and ordered ID batch", async () => {
    const redis = new FakeRedis();
    const reddit = wikiReddit();
    await runPoll(reddit, redis);

    const result = await runPoll(reddit, redis);

    expect(result).toEqual({
      status: "unchanged",
      discovered: 0,
      queued: 0,
      skipped: 0,
    });
    expect(reddit.getSubredditByName).not.toHaveBeenCalled();
  });

  it("baselines all-unknown data even when the gate state says enabled", async () => {
    const redis = new FakeRedis();
    redis.values.set("invite_new_subs:gate_state:v1", "enabled");
    const reddit = wikiReddit({
      data: discoveryJson([discoveryRecord("t5_fresh", "Fresh")]),
    });

    expect((await runPoll(reddit, redis)).status).toBe("baseline");
    expect(reddit.getSubredditByName).not.toHaveBeenCalled();
  });

  it("queues unseen public communities oldest-first at one-minute offsets", async () => {
    const now = Date.parse("2026-10-22T19:00:00Z");
    const redis = new FakeRedis();
    const reddit = wikiReddit();
    const runJob = vi.fn().mockResolvedValue("job-id");
    await runPoll(reddit, redis, runJob, now - 300_000);

    const nextRecords = [
      discoveryRecord("t5_newest", "Newest", { over18: true }),
      discoveryRecord("t5_older", "Older"),
      discoveryRecord("t5_existing", "Existing"),
    ];
    reddit.getWikiPage.mockImplementation(async (_subreddit, page) => ({
      content:
        page === inviteNewSubsControlWikiPage
          ? "enabled"
          : page === inviteNewSubsMessageWikiPage
            ? inviteNewSubsMessageTemplate
            : discoveryJson(nextRecords, "2026-10-22T19:05:00Z"),
      wikiVersion: "v2",
      revisionId: "22222222-2222-2222-2222-222222222222",
      revisionDate: new Date(),
    }));
    reddit.getSubredditByName.mockImplementation(async (name: string) => ({
      name,
      type: "public",
      nsfw: name === "Newest",
    }));
    reddit.getModerators.mockImplementation(
      ({ subredditName }: { subredditName: string }) => ({
        get: vi.fn().mockResolvedValue([{ username: `${subredditName}Owner` }]),
      }),
    );

    expect(await runPoll(reddit, redis, runJob, now)).toEqual({
      status: "processed",
      discovered: 2,
      queued: 2,
      skipped: 0,
    });
    expect(runJob).toHaveBeenNthCalledWith(1, {
      name: inviteNewSubsDeliveryJobName,
      data: expect.objectContaining({
        subredditId: "t5_older",
        subredditName: "Older",
        topModerator: "OlderOwner",
        isNsfw: false,
      }),
      runAt: new Date(now),
    });
    expect(runJob).toHaveBeenNthCalledWith(2, {
      name: inviteNewSubsDeliveryJobName,
      data: expect.objectContaining({
        subredditId: "t5_newest",
        subredditName: "Newest",
        topModerator: "NewestOwner",
        isNsfw: true,
        renderedMessage: expect.stringContaining("NSFW: yes"),
      }),
      runAt: new Date(now + 60_000),
    });
  });

  it("records publisher and native non-public records without moderator lookup", async () => {
    const redis = new FakeRedis();
    const reddit = wikiReddit();
    await runPoll(reddit, redis);
    const records = [
      discoveryRecord("t5_private", "Private", {
        subredditType: "private",
      }),
      discoveryRecord("t5_stale", "StalePublic"),
      discoveryRecord("t5_existing", "Existing"),
    ];
    reddit.getWikiPage.mockImplementation(async (_subreddit, page) => ({
      content:
        page === inviteNewSubsControlWikiPage
          ? "enabled"
          : page === inviteNewSubsMessageWikiPage
            ? inviteNewSubsMessageTemplate
            : discoveryJson(records, "2026-10-22T19:05:00Z"),
      wikiVersion: "v2",
      revisionId: "id",
      revisionDate: new Date(),
    }));
    reddit.getSubredditByName.mockResolvedValue({
      name: "StalePublic",
      type: "restricted",
      nsfw: false,
    });

    const result = await runPoll(reddit, redis);

    expect(result).toMatchObject({ discovered: 2, queued: 0, skipped: 2 });
    expect(reddit.getSubredditByName).toHaveBeenCalledOnce();
    expect(reddit.getModerators).not.toHaveBeenCalled();
  });

  it("baselines again after a confirmed disable and re-enable", async () => {
    const redis = new FakeRedis();
    await runPoll(wikiReddit(), redis);
    await runPoll(wikiReddit({ control: "disabled" }), redis);
    const reenabled = wikiReddit({
      data: discoveryJson(
        [
          discoveryRecord("t5_second", "Second"),
          discoveryRecord("t5_existing", "Existing"),
        ],
        "2026-10-22T19:05:00Z",
      ),
    });
    const runJob = vi.fn();

    expect((await runPoll(reenabled, redis, runJob)).status).toBe("baseline");
    expect(runJob).not.toHaveBeenCalled();
    expect(reenabled.getSubredditByName).not.toHaveBeenCalled();
  });

  it("does not establish state from an invalid data page", async () => {
    const redis = new FakeRedis();
    const reddit = wikiReddit({ data: "not json" });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    expect((await runPoll(reddit, redis)).status).toBe("invalid_data");
    expect(redis.values.size).toBe(0);
    expect(
      diagnosticPayload(info, "invite_new_subs_poll_completed"),
    ).toMatchObject({
      resultStatus: "invalid_data",
      fetched: 0,
    });
  });

  it("reports an unavailable data page without changing workflow state", async () => {
    const redis = new FakeRedis();
    const reddit = wikiReddit();
    reddit.getWikiPage.mockImplementation(async (_subreddit, page) => {
      if (page === inviteNewSubsDataWikiPage) {
        throw new Error("wiki unavailable");
      }
      return {
        content:
          page === inviteNewSubsControlWikiPage
            ? "enabled"
            : inviteNewSubsMessageTemplate,
        wikiVersion: "v2",
        revisionId: "id",
        revisionDate: new Date(),
      };
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect((await runPoll(reddit, redis)).status).toBe("data_unavailable");
    expect(redis.values.size).toBe(0);
    expect(reddit.getWikiPage).toHaveBeenNthCalledWith(
      3,
      inviteNewSubsHostSubreddit,
      inviteNewSubsDataWikiPage,
      { wikiVersion: inviteNewSubsDataWikiVersion },
    );
    expect(
      diagnosticPayload(warn, "invite_new_subs_data_unavailable"),
    ).toMatchObject({ wikiVersion: inviteNewSubsDataWikiVersion });
    expect(
      diagnosticPayload(info, "invite_new_subs_poll_completed"),
    ).toMatchObject({ resultStatus: "data_unavailable", fetched: 0 });
  });

  it("stops before data for an empty template and reports completion", async () => {
    const reddit = wikiReddit({ template: "   " });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    expect((await runPoll(reddit, new FakeRedis())).status).toBe(
      "template_unavailable",
    );
    expect(reddit.getWikiPage).toHaveBeenCalledTimes(2);
    expect(
      diagnosticPayload(info, "invite_new_subs_poll_completed"),
    ).toMatchObject({
      resultStatus: "template_unavailable",
    });
  });

  it("records moderator and scheduling failures as terminal", async () => {
    const redis = new FakeRedis();
    const reddit = wikiReddit();
    const runJob = vi
      .fn()
      .mockRejectedValue(new Error("scheduler unavailable"));
    await runPoll(reddit, redis, runJob);
    const records = [
      discoveryRecord("t5_schedule", "ScheduleFails"),
      discoveryRecord("t5_nomods", "NoMods"),
      discoveryRecord("t5_existing", "Existing"),
    ];
    reddit.getWikiPage.mockImplementation(async (_subreddit, page) => ({
      content:
        page === inviteNewSubsControlWikiPage
          ? "enabled"
          : page === inviteNewSubsMessageWikiPage
            ? inviteNewSubsMessageTemplate
            : discoveryJson(records, "2026-10-22T19:05:00Z"),
      wikiVersion: "v2",
      revisionId: "id",
      revisionDate: new Date(),
    }));
    reddit.getSubredditByName.mockImplementation(async (name: string) => ({
      name,
      type: "public",
      nsfw: false,
    }));
    reddit.getModerators.mockImplementation(
      ({ subredditName }: { subredditName: string }) => ({
        get: vi
          .fn()
          .mockResolvedValue(
            subredditName === "NoMods" ? [] : [{ username: "Owner" }],
          ),
      }),
    );

    const first = await runPoll(reddit, redis, runJob);
    const second = await runPoll(reddit, redis, runJob);

    expect(first).toMatchObject({ discovered: 2, queued: 0, skipped: 2 });
    expect(second.status).toBe("unchanged");
    expect(runJob).toHaveBeenCalledOnce();
  });

  it("preserves a reservation when queued-state persistence fails", async () => {
    const redis = new FakeRedis();
    const reddit = wikiReddit();
    const runJob = vi.fn().mockResolvedValue("job-id");
    await runPoll(reddit, redis, runJob);
    const nextData = discoveryJson(
      [
        discoveryRecord("t5_new", "NewCommunity"),
        discoveryRecord("t5_existing", "Existing"),
      ],
      "2026-10-22T19:05:00Z",
    );
    reddit.getWikiPage.mockImplementation(async (_subreddit, page) => ({
      content:
        page === inviteNewSubsControlWikiPage
          ? "enabled"
          : page === inviteNewSubsMessageWikiPage
            ? inviteNewSubsMessageTemplate
            : nextData,
      wikiVersion: "v2",
      revisionId: "id",
      revisionDate: new Date(),
    }));
    reddit.getSubredditByName.mockResolvedValue({
      name: "NewCommunity",
      type: "public",
      nsfw: false,
    });
    reddit.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "Owner" }]),
    });
    redis.failNextRecordStatus = "queued";

    await expect(runPoll(reddit, redis, runJob)).rejects.toThrow(
      "failed to store queued state",
    );
    const retry = await runPoll(reddit, redis, runJob);

    expect(retry).toMatchObject({ discovered: 0, queued: 0, skipped: 0 });
    expect(runJob).toHaveBeenCalledOnce();
  });
});

function diagnosticPayload(
  spy: { mock: { calls: unknown[][] } },
  event: string,
): Record<string, unknown> | undefined {
  const prefix = "[diagnostic] ";
  for (const [line] of spy.mock.calls) {
    const text = String(line);
    if (!text.startsWith(prefix)) continue;
    const payload = JSON.parse(text.slice(prefix.length)) as Record<
      string,
      unknown
    >;
    if (payload.event === event) return payload;
  }
  return undefined;
}

describe("processInviteNewSubsDelivery", () => {
  const job: InviteNewSubsDeliveryJob = {
    subredditId: "t5_newcommunity",
    subredditName: "NewCommunity",
    topModerator: "FoundingMod",
    isNsfw: false,
    renderedMessage: "Detected r/NewCommunity for u/FoundingMod.",
  };

  const seedQueuedRecord = (
    redis: FakeRedis,
    deliveryJob: InviteNewSubsDeliveryJob = job,
  ) => {
    redis.values.set(
      `invite_new_subs:seen:v2:${deliveryJob.subredditId.toLowerCase()}`,
      JSON.stringify({
        status: "queued",
        subredditId: deliveryJob.subredditId,
        subredditName: deliveryJob.subredditName,
        updatedAt: Date.now(),
        topModerator: deliveryJob.topModerator,
        isNsfw: deliveryJob.isNsfw,
      }),
    );
  };

  it("sends to the top moderator only once for the same subreddit", async () => {
    const redis = new FakeRedis();
    seedQueuedRecord(redis);
    const reddit = { sendPrivateMessage: vi.fn().mockResolvedValue(undefined) };

    const first = await processInviteNewSubsDelivery({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      job,
    });
    const second = await processInviteNewSubsDelivery({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      job,
    });

    expect(first).toBe("messaged");
    expect(second).toBe("duplicate");
    expect(reddit.sendPrivateMessage).toHaveBeenCalledOnce();
    expect(reddit.sendPrivateMessage).toHaveBeenCalledWith({
      to: job.topModerator,
      subject: inviteNewSubsSubject,
      text: job.renderedMessage,
    });
  });

  it("suppresses another subreddit for the same moderator for 30 days", async () => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    const redis = new FakeRedis();
    const secondJob: InviteNewSubsDeliveryJob = {
      ...job,
      subredditId: "t5_secondcommunity",
      subredditName: "SecondCommunity",
      renderedMessage: "Detected r/SecondCommunity for u/FoundingMod.",
    };
    seedQueuedRecord(redis);
    seedQueuedRecord(redis, secondJob);
    const reddit = { sendPrivateMessage: vi.fn().mockResolvedValue(undefined) };

    expect(
      await processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        job,
        now: () => now,
      }),
    ).toBe("messaged");
    const cooldownKey = "invite_new_subs:recipient_cooldown:v1:foundingmod";
    const originalExpiration = redis.expirations.get(cooldownKey);

    expect(
      await processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        job: secondJob,
        now: () => now + 24 * 60 * 60 * 1000,
      }),
    ).toBe("recipient_cooldown");
    expect(reddit.sendPrivateMessage).toHaveBeenCalledOnce();
    expect(redis.expirations.get(cooldownKey)).toEqual(originalExpiration);
    expect(originalExpiration?.getTime()).toBe(
      now + inviteNewSubsRecipientCooldownSeconds * 1000,
    );
    expect(
      JSON.parse(
        redis.values.get("invite_new_subs:seen:v2:t5_secondcommunity") ?? "{}",
      ),
    ).toMatchObject({ status: "cooldown_suppressed" });
  });

  it("normalizes case, whitespace, and u/ prefixes for recipient cooldowns", async () => {
    const redis = new FakeRedis();
    const secondJob: InviteNewSubsDeliveryJob = {
      ...job,
      subredditId: "t5_secondcommunity",
      subredditName: "SecondCommunity",
      topModerator: "  u/fOuNdInGmOd  ",
    };
    seedQueuedRecord(redis);
    seedQueuedRecord(redis, secondJob);
    const reddit = { sendPrivateMessage: vi.fn().mockResolvedValue(undefined) };

    const results = await Promise.all([
      processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        job,
      }),
      processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        job: secondJob,
      }),
    ]);

    expect(results.sort()).toEqual(["messaged", "recipient_cooldown"]);
    expect(reddit.sendPrivateMessage).toHaveBeenCalledOnce();
  });

  it("allows different moderators to receive messages", async () => {
    const redis = new FakeRedis();
    const secondJob: InviteNewSubsDeliveryJob = {
      ...job,
      subredditId: "t5_secondcommunity",
      subredditName: "SecondCommunity",
      topModerator: "AnotherMod",
    };
    seedQueuedRecord(redis);
    seedQueuedRecord(redis, secondJob);
    const reddit = { sendPrivateMessage: vi.fn().mockResolvedValue(undefined) };

    expect(
      await Promise.all([
        processInviteNewSubsDelivery({
          reddit: reddit as unknown as RedditClient,
          redis: asRedis(redis),
          job,
        }),
        processInviteNewSubsDelivery({
          reddit: reddit as unknown as RedditClient,
          redis: asRedis(redis),
          job: secondJob,
        }),
      ]),
    ).toEqual(["messaged", "messaged"]);
    expect(reddit.sendPrivateMessage).toHaveBeenCalledTimes(2);
  });

  it("allows another message after the recipient cooldown expires", async () => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    const redis = new FakeRedis();
    redis.nowMs = now;
    const secondJob: InviteNewSubsDeliveryJob = {
      ...job,
      subredditId: "t5_secondcommunity",
      subredditName: "SecondCommunity",
    };
    seedQueuedRecord(redis);
    seedQueuedRecord(redis, secondJob);
    const reddit = { sendPrivateMessage: vi.fn().mockResolvedValue(undefined) };

    expect(
      await processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        job,
        now: () => now,
      }),
    ).toBe("messaged");
    const afterCooldown = now + inviteNewSubsRecipientCooldownSeconds * 1000;
    redis.nowMs = afterCooldown;

    expect(
      await processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        job: secondJob,
        now: () => afterCooldown,
      }),
    ).toBe("messaged");
    expect(reddit.sendPrivateMessage).toHaveBeenCalledTimes(2);
  });

  it("records a failed DM and never retries it", async () => {
    const redis = new FakeRedis();
    seedQueuedRecord(redis);
    const secondJob: InviteNewSubsDeliveryJob = {
      ...job,
      subredditId: "t5_secondcommunity",
      subredditName: "SecondCommunity",
    };
    seedQueuedRecord(redis, secondJob);
    const reddit = {
      sendPrivateMessage: vi.fn().mockRejectedValue(new Error("blocked")),
    };

    expect(
      await processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        job,
      }),
    ).toBe("dm_failed");
    expect(
      await processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        job,
      }),
    ).toBe("duplicate");
    expect(reddit.sendPrivateMessage).toHaveBeenCalledOnce();
    expect(
      redis.values.has("invite_new_subs:recipient_cooldown:v1:foundingmod"),
    ).toBe(true);
    expect(
      await processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        job: secondJob,
      }),
    ).toBe("recipient_cooldown");
    expect(reddit.sendPrivateMessage).toHaveBeenCalledOnce();
  });

  it("records successful and failed delivery metrics without counting suppression", async () => {
    const now = Date.parse("2026-10-23T11:00:00Z");
    const redis = new FakeRedis();
    const failedJob: InviteNewSubsDeliveryJob = {
      ...job,
      subredditId: "t5_failedcommunity",
      subredditName: "FailedCommunity",
      topModerator: "AnotherMod",
    };
    const suppressedJob: InviteNewSubsDeliveryJob = {
      ...job,
      subredditId: "t5_suppressedcommunity",
      subredditName: "SuppressedCommunity",
    };
    seedQueuedRecord(redis);
    seedQueuedRecord(redis, failedJob);
    seedQueuedRecord(redis, suppressedJob);
    const reddit = {
      sendPrivateMessage: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("blocked")),
    };

    await processInviteNewSubsDelivery({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      job,
      now: () => now,
    });
    await processInviteNewSubsDelivery({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      job: failedJob,
      now: () => now + 1,
    });
    await processInviteNewSubsDelivery({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      job: suppressedJob,
      now: () => now + 2,
    });

    const metrics = [
      ...(redis.sortedSets.get("invite_new_subs:delivery_metrics:v1")?.keys() ??
        []),
    ].map((value) => JSON.parse(value) as { outcome: string });
    expect(metrics.map((metric) => metric.outcome).sort()).toEqual([
      "failure",
      "success",
    ]);
  });

  it("keeps delivery outcomes independent from metrics and state persistence", async () => {
    const redis = new FakeRedis();
    seedQueuedRecord(redis);
    redis.failMetricWrites = true;
    redis.failNextRecordStatus = "messaged";
    const reddit = { sendPrivateMessage: vi.fn().mockResolvedValue(undefined) };

    await expect(
      processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        job,
      }),
    ).resolves.toBe("messaged");
    expect(reddit.sendPrivateMessage).toHaveBeenCalledOnce();
  });

  it("rejects delivery data without a full subreddit ID", async () => {
    const reddit = { sendPrivateMessage: vi.fn() };
    expect(
      await processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(new FakeRedis()),
        job: { ...job, subredditId: "invalid" as SubredditId },
      }),
    ).toBe("invalid");
    expect(reddit.sendPrivateMessage).not.toHaveBeenCalled();
  });

  it("renders every supported placeholder occurrence", () => {
    expect(
      renderInviteNewSubsMessage(
        "{{subredditName}} {{subredditName}} {{topModerator}} {{isNsfw}}",
        job,
      ),
    ).toBe("NewCommunity NewCommunity FoundingMod no");
  });
});

describe("processInviteNewSubsReport", () => {
  const reportNow = Date.parse("2026-10-23T12:05:00Z");
  const windowEnd = Date.parse("2026-10-23T12:00:00Z");
  const windowStart = windowEnd - inviteNewSubsReportWindowMs;

  const reportReddit = (control = "enabled") => ({
    getWikiPage: vi.fn().mockResolvedValue({ content: control }),
    sendPrivateMessage: vi.fn().mockResolvedValue(undefined),
  });

  const addMetric = (
    redis: FakeRedis,
    eventId: string,
    outcome: "success" | "failure",
    completedAt: number,
  ) => {
    const metrics =
      redis.sortedSets.get("invite_new_subs:delivery_metrics:v1") ??
      new Map<string, number>();
    metrics.set(JSON.stringify({ eventId, outcome }), completedAt);
    redis.sortedSets.set("invite_new_subs:delivery_metrics:v1", metrics);
  };

  it("does not report from installations outside the host subreddit", async () => {
    const redis = new FakeRedis();
    const reddit = reportReddit();

    await expect(
      processInviteNewSubsReport({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        subredditName: "another_subreddit",
        now: () => reportNow,
      }),
    ).resolves.toMatchObject({ status: "disabled" });
    expect(reddit.getWikiPage).not.toHaveBeenCalled();
    expect(reddit.sendPrivateMessage).not.toHaveBeenCalled();
  });

  it("reports the previous completed UTC window with exact boundaries", async () => {
    const redis = new FakeRedis();
    addMetric(redis, "before", "failure", windowStart - 1);
    addMetric(redis, "start", "success", windowStart);
    addMetric(redis, "inside", "failure", windowEnd - 1);
    addMetric(redis, "end", "success", windowEnd);
    const reddit = reportReddit();

    await expect(
      processInviteNewSubsReport({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        now: () => reportNow,
      }),
    ).resolves.toEqual({
      status: "sent",
      windowStart,
      windowEnd,
      total: 2,
      successful: 1,
      failed: 1,
    });
    expect(reddit.getWikiPage).toHaveBeenCalledWith(
      inviteNewSubsHostSubreddit,
      inviteNewSubsControlWikiPage,
      { wikiVersion: inviteNewSubsWikiVersion },
    );
    expect(reddit.sendPrivateMessage).toHaveBeenCalledWith({
      to: inviteNewSubsReportRecipient,
      subject: inviteNewSubsReportSubject,
      text: expect.stringContaining("Total attempted: 2"),
    });
    expect(reddit.sendPrivateMessage.mock.calls[0]?.[0].text).toContain(
      `Window start: ${new Date(windowStart).toISOString()}`,
    );
    expect(reddit.sendPrivateMessage.mock.calls[0]?.[0].text).toContain(
      `Window end: ${new Date(windowEnd).toISOString()}`,
    );
  });

  it("sends a zero-count report when enabled", async () => {
    const redis = new FakeRedis();
    const reddit = reportReddit(" enabled ");

    const result = await processInviteNewSubsReport({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      now: () => reportNow,
    });

    expect(result).toMatchObject({
      status: "sent",
      total: 0,
      successful: 0,
      failed: 0,
    });
    expect(reddit.sendPrivateMessage).toHaveBeenCalledOnce();
  });

  it.each(["disabled", "Enabled", "ENABLED"])(
    "does not report when the normalized gate value is %s",
    async (control) => {
      const redis = new FakeRedis();
      const reddit = reportReddit(control);

      await expect(
        processInviteNewSubsReport({
          reddit: reddit as unknown as RedditClient,
          redis: asRedis(redis),
          now: () => reportNow,
        }),
      ).resolves.toMatchObject({ status: "disabled" });
      expect(reddit.sendPrivateMessage).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the gate cannot be read", async () => {
    const redis = new FakeRedis();
    const reddit = reportReddit();
    reddit.getWikiPage.mockRejectedValue(new Error("wiki unavailable"));

    await expect(
      processInviteNewSubsReport({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        now: () => reportNow,
      }),
    ).rejects.toThrow("wiki unavailable");
    expect(reddit.sendPrivateMessage).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent and later executions for the same window", async () => {
    const redis = new FakeRedis();
    const reddit = reportReddit();

    const concurrent = await Promise.all([
      processInviteNewSubsReport({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        now: () => reportNow,
      }),
      processInviteNewSubsReport({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        now: () => reportNow,
      }),
    ]);
    const later = await processInviteNewSubsReport({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      now: () => reportNow,
    });

    expect(concurrent.map((result) => result.status).sort()).toEqual([
      "already_sent",
      "sent",
    ]);
    expect(later.status).toBe("already_sent");
    expect(reddit.sendPrivateMessage).toHaveBeenCalledOnce();
    expect(
      redis.expirations
        .get(`invite_new_subs:report_sent:v1:${windowEnd}`)
        ?.getTime(),
    ).toBe(reportNow + 30 * 24 * 60 * 60 * 1000);
  });

  it("releases the report lock and leaves no marker after delivery failure", async () => {
    const redis = new FakeRedis();
    const reddit = reportReddit();
    reddit.sendPrivateMessage.mockRejectedValueOnce(new Error("blocked"));

    await expect(
      processInviteNewSubsReport({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        now: () => reportNow,
      }),
    ).rejects.toThrow("blocked");
    expect(
      redis.values.has(`invite_new_subs:report_lock:v1:${windowEnd}`),
    ).toBe(false);
    expect(
      redis.values.has(`invite_new_subs:report_sent:v1:${windowEnd}`),
    ).toBe(false);

    await expect(
      processInviteNewSubsReport({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        now: () => reportNow,
      }),
    ).resolves.toMatchObject({ status: "sent" });
    expect(reddit.sendPrivateMessage).toHaveBeenCalledTimes(2);
  });
});
