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
  parseInviteNewSubsMessageConfig,
  processInviteNewSubsDelivery,
  processInviteNewSubsPoll,
  processInviteNewSubsReport,
  renderInviteNewSubsMessage,
  type InviteNewSubsDeliveryJob,
  type InviteNewSubsDiscoveryRecord,
} from "./inviteNewSubs";

const inviteNewSubsMessageBody = `Detected a newly created public subreddit.

- Subreddit: r/{{subredditName}}
- Top moderator: u/{{topModerator}}
- NSFW: {{isNsfw}}`;

const messageConfig = (body = inviteNewSubsMessageBody): string =>
  JSON.stringify({
    schemaVersion: 1,
    templates: Array.from({ length: 5 }, (_, index) => ({
      id: `template-${index + 1}`,
      body,
    })),
  });

const inviteNewSubsMessageTemplate = messageConfig();

afterEach(() => {
  vi.restoreAllMocks();
});

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly expirations = new Map<string, Date>();
  readonly sortedSets = new Map<string, Map<string, number>>();
  readonly revisions = new Map<string, number>();
  failNextRecordStatus: string | undefined;
  failMetricWrites = false;
  failTransactionAtCommand: number | undefined;
  nowMs: number | undefined;

  private touch(key: string): void {
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
  }

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
    this.touch(key);
    return "OK";
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
    this.sortedSets.delete(key);
    this.expirations.delete(key);
    this.touch(key);
  }

  async incrBy(key: string, increment: number): Promise<number> {
    this.expireIfNeeded(key);
    const value = Number(this.values.get(key) ?? "0") + increment;
    this.values.set(key, String(value));
    this.touch(key);
    return value;
  }

  async expire(key: string, seconds: number): Promise<void> {
    if (this.failMetricWrites) throw new Error("metric storage unavailable");
    const base = this.nowMs ?? Date.now();
    this.expirations.set(key, new Date(base + seconds * 1000));
    this.touch(key);
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
    this.touch(key);
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
    this.touch(key);
  }

  async watch(...keys: string[]) {
    const watched = new Map(
      keys.map((key) => [key, this.revisions.get(key) ?? 0]),
    );
    const operations: Array<() => Promise<unknown>> = [];
    let inTransaction = false;
    const queue = (operation: () => Promise<unknown>): Promise<unknown> => {
      if (!inTransaction) return operation();
      operations.push(operation);
      return Promise.resolve(undefined);
    };
    return {
      multi: async (): Promise<void> => {
        inTransaction = true;
      },
      unwatch: async (): Promise<void> => undefined,
      discard: async (): Promise<void> => {
        operations.length = 0;
        inTransaction = false;
      },
      set: async (
        key: string,
        value: string,
        options?: { nx?: boolean; expiration?: Date },
      ): Promise<unknown> => queue(() => this.set(key, value, options)),
      zAdd: async (
        key: string,
        ...entries: Array<{ member: string; score: number }>
      ): Promise<unknown> => queue(() => this.zAdd(key, ...entries)),
      expire: async (key: string, seconds: number): Promise<unknown> =>
        queue(() => this.expire(key, seconds)),
      exec: async (): Promise<unknown[] | null> => {
        if (
          [...watched].some(
            ([key, revision]) => (this.revisions.get(key) ?? 0) !== revision,
          )
        ) {
          return null;
        }
        const valueSnapshot = new Map(this.values);
        const expirationSnapshot = new Map(
          [...this.expirations].map(([key, value]) => [key, new Date(value)]),
        );
        const sortedSetSnapshot = new Map(
          [...this.sortedSets].map(([key, value]) => [key, new Map(value)]),
        );
        const revisionSnapshot = new Map(this.revisions);
        const results: unknown[] = [];
        try {
          for (const [index, operation] of operations.entries()) {
            if (this.failTransactionAtCommand === index + 1) {
              this.failTransactionAtCommand = undefined;
              throw new Error(`failed transaction command ${index + 1}`);
            }
            results.push(await operation());
          }
          return results;
        } catch (error) {
          this.values.clear();
          for (const [key, value] of valueSnapshot) this.values.set(key, value);
          this.expirations.clear();
          for (const [key, value] of expirationSnapshot) {
            this.expirations.set(key, value);
          }
          this.sortedSets.clear();
          for (const [key, value] of sortedSetSnapshot) {
            this.sortedSets.set(key, value);
          }
          this.revisions.clear();
          for (const [key, value] of revisionSnapshot) {
            this.revisions.set(key, value);
          }
          throw error;
        }
      },
    };
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
  createdUtc: 1_792_695_590,
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

const publisherSessionId = "12345678-1234-4123-8123-123456789abc";
const secondPublisherSessionId = "87654321-4321-4321-8321-cba987654321";

const discoveryV2Json = (
  records: InviteNewSubsDiscoveryRecord[],
  generatedAt = "2026-10-22T19:00:00Z",
  sessionId = publisherSessionId,
  publisherStartedAt = "2026-10-22T18:59:50Z",
): string =>
  JSON.stringify({
    schemaVersion: 2,
    source: "reddit/subreddits/new",
    generatedAt,
    publisherSessionId: sessionId,
    publisherStartedAt,
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

describe("parseInviteNewSubsMessageConfig", () => {
  it("accepts exactly five unique templates with supported placeholders", () => {
    const parsed = parseInviteNewSubsMessageConfig(
      messageConfig(
        "Hello u/{{topModerator}} from r/{{subredditName}} ({{isNsfw}})",
      ),
    );

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.templates.map(({ id }) => id)).toEqual([
      "template-1",
      "template-2",
      "template-3",
      "template-4",
      "template-5",
    ]);
  });

  it.each([
    ["malformed JSON", "{", "valid JSON"],
    [
      "wrong count",
      JSON.stringify({
        schemaVersion: 1,
        templates: JSON.parse(messageConfig()).templates.slice(0, 4),
      }),
      "exactly five",
    ],
    [
      "duplicate IDs",
      JSON.stringify({
        schemaVersion: 1,
        templates: JSON.parse(messageConfig()).templates.map(
          (template: { id: string; body: string }) => ({
            ...template,
            id: "duplicate",
          }),
        ),
      }),
      "duplicated",
    ],
    [
      "missing required placeholder",
      messageConfig("Hello u/{{topModerator}}"),
      "subredditName",
    ],
    [
      "unsupported placeholder",
      messageConfig(
        "Hello u/{{topModerator}} from r/{{subredditName}} {{unknown}}",
      ),
      "unsupported placeholder",
    ],
  ])("rejects %s", (_name, content, expectedMessage) => {
    expect(() => parseInviteNewSubsMessageConfig(content)).toThrow(
      expectedMessage,
    );
  });
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

  it("accepts schema v2 publisher session metadata", () => {
    const record = discoveryRecord("t5_valid", "ValidSub");
    expect(parseInviteNewSubsDiscoveryBatch(discoveryV2Json([record]))).toEqual(
      {
        schemaVersion: 2,
        source: "reddit/subreddits/new",
        generatedAt: "2026-10-22T19:00:00Z",
        publisherSessionId,
        publisherStartedAt: "2026-10-22T18:59:50Z",
        subreddits: [record],
      },
    );
  });

  it.each([
    ["malformed JSON", "{"],
    [
      "unsupported schema",
      JSON.stringify({
        schemaVersion: 3,
        source: "reddit/subreddits/new",
        generatedAt: "2026-10-22T19:00:00Z",
        subreddits: [discoveryRecord("t5_valid", "Valid")],
      }),
    ],
    [
      "schema v2 without publisher metadata",
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
        Array.from({ length: 26 }, (_, index) =>
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

  it("reads only the V1 gate while disabled", async () => {
    const reddit = wikiReddit({ control: "Enabled" });
    const redis = new FakeRedis();

    expect((await runPoll(reddit, redis)).status).toBe("disabled");
    expect(reddit.getWikiPage).toHaveBeenCalledOnce();
    expect(reddit.getWikiPage).toHaveBeenCalledWith(
      inviteNewSubsHostSubreddit,
      inviteNewSubsControlWikiPage,
      { wikiVersion: "v1" },
    );
    expect([...redis.values.values()]).toContain("disabled");
  });

  it("reads the V1 gate, template, and data before creating a baseline", async () => {
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
    expect(
      diagnosticPayload(info, "invite_new_subs_template_loaded"),
    ).toMatchObject({
      requestedWikiVersion: "v1",
      returnedWikiVersion: "v1",
      revisionId: "11111111-1111-1111-1111-111111111111",
      contentLength: inviteNewSubsMessageTemplate.length,
      templateCount: 5,
    });
    expect(reddit.getSubredditByName).not.toHaveBeenCalled();
    expect(reddit.sendPrivateMessage).not.toHaveBeenCalled();
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

  it("short-circuits identical ordered IDs when generatedAt advances", async () => {
    const redis = new FakeRedis();
    const records = [discoveryRecord("t5_existing", "Existing")];
    const firstReddit = wikiReddit({
      data: discoveryJson(records, "2026-10-22T19:00:00Z"),
    });
    await runPoll(firstReddit, redis);
    const laterReddit = wikiReddit({
      data: discoveryJson(records, "2026-10-22T19:01:00Z"),
    });

    const result = await runPoll(
      laterReddit,
      redis,
      vi.fn(),
      Date.parse("2026-10-22T19:01:00Z"),
    );

    expect(result).toEqual({
      status: "unchanged",
      discovered: 0,
      queued: 0,
      skipped: 0,
    });
    expect(laterReddit.getSubredditByName).not.toHaveBeenCalled();
  });

  it("normalizes a timestamp-bearing legacy batch identity", async () => {
    const redis = new FakeRedis();
    redis.values.set("invite_new_subs:gate_state:v1", "enabled");
    redis.values.set(
      "invite_new_subs:batch_identity:v1",
      JSON.stringify([1, "legacy", "2026-10-22T19:00:00Z", "t5_existing"]),
    );
    redis.values.set(
      "invite_new_subs:seen:v2:t5_existing",
      JSON.stringify({
        status: "baseline",
        subredditId: "t5_existing",
        subredditName: "Existing",
        updatedAt: Date.parse("2026-10-22T19:00:00Z"),
        isNsfw: false,
      }),
    );
    const reddit = wikiReddit({
      data: discoveryJson(
        [discoveryRecord("t5_existing", "Existing")],
        "2026-10-22T19:01:00Z",
      ),
    });

    expect(
      await runPoll(reddit, redis, vi.fn(), Date.parse("2026-10-22T19:01:00Z")),
    ).toMatchObject({ status: "unchanged" });
    expect(
      JSON.parse(redis.values.get("invite_new_subs:batch_identity:v1") ?? "{}"),
    ).toMatchObject({
      version: 2,
      schemaVersion: 1,
      publisherSessionId: "legacy",
      orderedSubredditIds: ["t5_existing"],
    });
  });

  it("schedules one live SubGoal startup test for a new session with ten unseen entries", async () => {
    const records = Array.from({ length: 10 }, (_, index) =>
      discoveryRecord(`t5_new${index}`, `New${index}`),
    );
    const template = `Welcome to [r/{{subredditName}}](https://www.reddit.com/r/{{subredditName}}/), u/{{topModerator}}. NSFW: {{isNsfw}}`;
    const reddit = wikiReddit({
      data: discoveryV2Json(records),
      template: messageConfig(template),
    });
    reddit.getSubredditByName.mockResolvedValue({
      id: "t5_subgoal",
      name: "SubGoal",
      type: "restricted",
      nsfw: false,
    });
    reddit.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "Alan-Foster" }]),
    });
    const redis = new FakeRedis();
    const runJob = vi.fn().mockResolvedValue("startup-job");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    expect(await runPoll(reddit, redis, runJob)).toEqual({
      status: "baseline",
      discovered: 10,
      queued: 1,
      skipped: 10,
      startupTestStatus: "queued",
    });
    expect(reddit.sendPrivateMessage).not.toHaveBeenCalled();
    expect(reddit.getSubredditByName).toHaveBeenCalledWith("SubGoal");
    expect(reddit.getModerators).toHaveBeenCalledWith({
      subredditName: "SubGoal",
      limit: 1,
    });
    expect(runJob).toHaveBeenCalledOnce();
    expect(runJob).toHaveBeenCalledWith({
      name: inviteNewSubsDeliveryJobName,
      data: expect.objectContaining({
        subredditId: "t5_subgoal",
        subredditName: "SubGoal",
        topModerator: "Alan-Foster",
        isNsfw: false,
        renderedMessage:
          "Welcome to [r/SubGoal](https://www.reddit.com/r/SubGoal/), u/Alan-Foster. NSFW: no",
        templateId: "template-1",
        deliveryKind: "startup_test",
        startupSessionId: publisherSessionId,
        queueEntryId: expect.any(String),
      }),
      runAt: new Date("2026-10-22T19:00:00Z"),
    });
    expect(
      [...redis.values.entries()].filter(([key]) => key.includes(":seen:v2:")),
    ).toHaveLength(10);
    expect(
      diagnosticPayload(info, "invite_new_subs_startup_test_queued"),
    ).toMatchObject({
      subredditId: "t5_subgoal",
      subredditName: "SubGoal",
      subredditType: "restricted",
      recipientUsername: "alan-foster",
    });
    expect(
      diagnosticPayload(info, "invite_new_subs_batch_classified"),
    ).toMatchObject({
      unseen: 10,
      baselineRecords: 0,
      allIdsAreAbsent: true,
      createdLast60Seconds: 10,
      requiresBaseline: true,
      baselineReason: "publisher_startup",
      fullBatchAllUnseen: false,
      publisherSessionStatus: "new",
      startupTestEligible: true,
    });

    expect(await runPoll(reddit, redis, runJob)).toMatchObject({
      status: "unchanged",
      queued: 0,
    });
    expect(runJob).toHaveBeenCalledOnce();
  });

  it("uses session identity rather than record ages for the initial startup test", async () => {
    const createdUtc = [
      1_792_876_114, 1_792_876_081, 1_792_876_063, 1_792_876_061, 1_792_876_035,
      1_792_876_033, 1_792_876_009, 1_792_875_988, 1_792_875_923, 1_792_875_906,
    ];
    const records = createdUtc.map((created, index) =>
      discoveryRecord(`t5_cached${index}`, `Cached${index}`, {
        createdUtc: created,
      }),
    );
    const reddit = wikiReddit({
      data: discoveryV2Json(
        records,
        "2026-10-24T21:09:48Z",
        publisherSessionId,
        "2026-10-24T21:09:40Z",
      ),
    });
    const redis = new FakeRedis();
    reddit.getSubredditByName.mockResolvedValue({
      id: "t5_subgoal",
      name: "SubGoal",
      type: "restricted",
      nsfw: false,
    });
    reddit.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "Alan-Foster" }]),
    });
    const runJob = vi.fn().mockResolvedValue("startup-job");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    expect(await runPoll(reddit, redis, runJob)).toEqual({
      status: "baseline",
      discovered: 10,
      queued: 1,
      skipped: 10,
      startupTestStatus: "queued",
    });
    expect(runJob).toHaveBeenCalledOnce();
    expect(
      diagnosticPayload(info, "invite_new_subs_batch_classified"),
    ).toMatchObject({
      unseen: 10,
      baselineRecords: 0,
      createdLast60Seconds: 0,
      newestAgeSeconds: 74,
      oldestAgeSeconds: 282,
      requiresBaseline: true,
      publisherSessionStatus: "new",
      startupTestEligible: true,
    });
    expect(
      diagnosticPayload(info, "invite_new_subs_poll_completed"),
    ).toMatchObject({
      new: 10,
      unseen: 10,
      createdLast60Seconds: 0,
    });
  });

  it("processes distinct delayed listing replacements without another startup test", async () => {
    const initial = Array.from({ length: 10 }, (_, index) =>
      discoveryRecord(`t5_initial${index}`, `Initial${index}`),
    );
    const reddit = wikiReddit({ data: discoveryV2Json(initial) });
    reddit.getSubredditByName.mockImplementation(async (name: string) =>
      name === "SubGoal"
        ? {
            id: "t5_subgoal",
            name: "SubGoal",
            type: "restricted",
            nsfw: false,
          }
        : { id: `t5_${name.toLowerCase()}`, name, type: "public", nsfw: false },
    );
    reddit.getModerators.mockImplementation(
      ({ subredditName }: { subredditName: string }) => ({
        get: vi.fn().mockResolvedValue([
          {
            username:
              subredditName === "SubGoal"
                ? "Alan-Foster"
                : `${subredditName}Owner`,
          },
        ]),
      }),
    );
    const redis = new FakeRedis();
    const runJob = vi.fn().mockResolvedValue("startup-job");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await runPoll(reddit, redis, runJob);
    const replacementAges = [
      [13, 45, 75, 105, 135, 165, 195, 215, 235, 249],
      [24, 45, 65, 85, 105, 125, 145, 165, 195, 215],
      [12, 20, 28, 36, 44, 52, 60, 64, 70, 76],
    ];
    const generatedAtSeconds = Date.parse("2026-10-22T19:05:00Z") / 1000;

    for (const [batchIndex, ages] of replacementAges.entries()) {
      const generatedAt = new Date(
        (generatedAtSeconds + batchIndex * 300) * 1000,
      )
        .toISOString()
        .replace(".000Z", "Z");
      const replacement = ages.map((age, index) =>
        discoveryRecord(
          `t5_replacement${batchIndex}${index}`,
          `Replacement${batchIndex}_${index}`,
          { createdUtc: generatedAtSeconds + batchIndex * 300 - age },
        ),
      );
      reddit.getWikiPage.mockImplementation(async (_subreddit, page) => ({
        content:
          page === inviteNewSubsControlWikiPage
            ? "enabled"
            : page === inviteNewSubsMessageWikiPage
              ? inviteNewSubsMessageTemplate
              : discoveryV2Json(replacement, generatedAt),
        wikiVersion: "v1",
        revisionId: `replacement-${batchIndex}`,
        revisionDate: new Date(generatedAt),
      }));

      const expected = [
        { queued: 10, skipped: 0, rateLimited: undefined },
        { queued: 6, skipped: 4, rateLimited: 4 },
        { queued: 0, skipped: 10, rateLimited: 10 },
      ][batchIndex]!;
      expect(
        await runPoll(reddit, redis, runJob, Date.parse(generatedAt) + 10_000),
      ).toEqual({
        status: "processed",
        discovered: 10,
        queued: expected.queued,
        skipped: expected.skipped,
        ...(expected.rateLimited === undefined
          ? {}
          : { rateLimited: expected.rateLimited }),
      });
    }

    expect(runJob).toHaveBeenCalledTimes(17);
    expect(
      runJob.mock.calls.filter(
        ([job]) => job.data.deliveryKind === "startup_test",
      ),
    ).toHaveLength(1);
    expect(
      runJob.mock.calls.slice(1, 5).map(([job]) => job.runAt.getTime()),
    ).toEqual([
      Date.parse("2026-10-22T19:05:10Z"),
      Date.parse("2026-10-22T19:05:25Z"),
      Date.parse("2026-10-22T19:05:40Z"),
      Date.parse("2026-10-22T19:05:55Z"),
    ]);
    const classifications = diagnosticPayloads(
      info,
      "invite_new_subs_batch_classified",
    ).slice(-3);
    expect(classifications).toHaveLength(3);
    for (const classification of classifications) {
      expect(classification).toMatchObject({
        unseen: 10,
        allIdsAreAbsent: true,
        requiresBaseline: false,
        baselineReason: "none",
        fullBatchAllUnseen: false,
        publisherSessionStatus: "scheduled",
        startupTestEligible: false,
      });
    }
  });

  it("baselines an unchanged v2 batch when all of its seen records disappear", async () => {
    const records = Array.from({ length: 10 }, (_, index) =>
      discoveryRecord(`t5_v2lost${index}`, `V2Lost${index}`),
    );
    const reddit = wikiReddit({ data: discoveryV2Json(records) });
    reddit.getSubredditByName.mockResolvedValue({
      id: "t5_subgoal",
      name: "SubGoal",
      type: "restricted",
      nsfw: false,
    });
    reddit.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "Alan-Foster" }]),
    });
    const redis = new FakeRedis();
    const runJob = vi.fn().mockResolvedValue("startup-job");

    expect(await runPoll(reddit, redis, runJob)).toMatchObject({
      status: "baseline",
      queued: 1,
    });
    for (const key of [...redis.values.keys()]) {
      if (key.includes(":seen:v2:")) redis.values.delete(key);
    }
    reddit.getWikiPage.mockImplementation(async (_subreddit, page) => ({
      content:
        page === inviteNewSubsControlWikiPage
          ? "enabled"
          : page === inviteNewSubsMessageWikiPage
            ? inviteNewSubsMessageTemplate
            : discoveryV2Json(records, "2026-10-22T19:01:00Z"),
      wikiVersion: "v1",
      revisionId: "later",
      revisionDate: new Date("2026-10-22T19:01:00Z"),
    }));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    expect(
      await runPoll(reddit, redis, runJob, Date.parse("2026-10-22T19:01:00Z")),
    ).toEqual({
      status: "baseline",
      discovered: 10,
      queued: 0,
      skipped: 10,
    });
    expect(runJob).toHaveBeenCalledOnce();
    expect(
      diagnosticPayload(info, "invite_new_subs_batch_classified"),
    ).toMatchObject({
      allIdsAreAbsent: true,
      requiresBaseline: true,
      baselineReason: "same_batch_state_loss",
      fullBatchAllUnseen: false,
      publisherSessionStatus: "scheduled",
    });
  });

  it("marks a new session with fewer than ten unseen IDs permanently ineligible", async () => {
    const redis = new FakeRedis();
    const firstBatch = [discoveryRecord("t5_fresh", "Fresh")];
    const reddit = wikiReddit({ data: discoveryV2Json(firstBatch) });
    reddit.getSubredditByName.mockResolvedValue({
      id: "t5_fresh",
      name: "Fresh",
      type: "public",
      nsfw: false,
    });
    reddit.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "FreshOwner" }]),
    });
    const runJob = vi.fn().mockResolvedValue("standard-job");

    expect(await runPoll(reddit, redis, runJob)).toMatchObject({
      status: "processed",
      discovered: 1,
      queued: 1,
    });
    const later = Array.from({ length: 10 }, (_, index) =>
      discoveryRecord(`t5_later${index}`, `Later${index}`),
    );
    reddit.getWikiPage.mockImplementation(async (_subreddit, page) => ({
      content:
        page === inviteNewSubsControlWikiPage
          ? "enabled"
          : page === inviteNewSubsMessageWikiPage
            ? inviteNewSubsMessageTemplate
            : discoveryV2Json(later, "2026-10-22T19:01:00Z"),
      wikiVersion: "v1",
      revisionId: "later",
      revisionDate: new Date("2026-10-22T19:01:01Z"),
    }));

    expect(await runPoll(reddit, redis, runJob)).toMatchObject({
      status: "processed",
      discovered: 10,
      queued: 10,
      skipped: 0,
    });
    expect(runJob).toHaveBeenCalledTimes(11);
  });

  it("allows a second PRAW session to schedule its own startup test", async () => {
    const first = Array.from({ length: 10 }, (_, index) =>
      discoveryRecord(`t5_firstsession${index}`, `FirstSession${index}`),
    );
    const second = Array.from({ length: 10 }, (_, index) =>
      discoveryRecord(`t5_secondsession${index}`, `SecondSession${index}`),
    );
    const reddit = wikiReddit({ data: discoveryV2Json(first) });
    reddit.getSubredditByName.mockResolvedValue({
      id: "t5_subgoal",
      name: "SubGoal",
      type: "restricted",
      nsfw: false,
    });
    reddit.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "Alan-Foster" }]),
    });
    const redis = new FakeRedis();
    const runJob = vi.fn().mockResolvedValue("startup-job");
    await runPoll(reddit, redis, runJob);
    reddit.getWikiPage.mockImplementation(async (_subreddit, page) => ({
      content:
        page === inviteNewSubsControlWikiPage
          ? "enabled"
          : page === inviteNewSubsMessageWikiPage
            ? inviteNewSubsMessageTemplate
            : discoveryV2Json(
                second,
                "2026-10-22T19:01:00Z",
                secondPublisherSessionId,
                "2026-10-22T19:00:50Z",
              ),
      wikiVersion: "v1",
      revisionId: "second-session",
      revisionDate: new Date("2026-10-22T19:01:01Z"),
    }));

    expect(await runPoll(reddit, redis, runJob)).toMatchObject({
      status: "baseline",
      queued: 1,
      startupTestStatus: "queued",
    });
    expect(runJob).toHaveBeenCalledTimes(2);
  });

  it("recreates a conservative baseline when seen records disappear", async () => {
    const records = Array.from({ length: 10 }, (_, index) =>
      discoveryRecord(`t5_lost${index}`, `Lost${index}`, {
        createdUtc: 1_792_695_400,
      }),
    );
    const generatedAt = "2026-10-22T19:00:00Z";
    const redis = new FakeRedis();
    redis.values.set("invite_new_subs:gate_state:v1", "enabled");
    redis.values.set(
      "invite_new_subs:batch_identity:v1",
      JSON.stringify([
        1,
        "legacy",
        generatedAt,
        ...records.map((record) => record.id),
      ]),
    );
    const reddit = wikiReddit({ data: discoveryJson(records, generatedAt) });
    const runJob = vi.fn();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    expect(await runPoll(reddit, redis, runJob)).toEqual({
      status: "baseline",
      discovered: 10,
      queued: 0,
      skipped: 10,
    });
    expect(reddit.getSubredditByName).not.toHaveBeenCalled();
    expect(runJob).not.toHaveBeenCalled();
    expect(
      [...redis.values.keys()].filter((key) => key.includes(":seen:v2:")),
    ).toHaveLength(10);
    expect(
      diagnosticPayload(info, "invite_new_subs_batch_classified"),
    ).toMatchObject({
      allIdsAreAbsent: true,
      baselineReason: "same_batch_state_loss",
      fullBatchAllUnseen: false,
    });
  });

  it.each([
    ["subreddit lookup", "subreddit_lookup_failed"],
    ["moderator lookup", "moderator_lookup_failed"],
    ["scheduling", "schedule_failed"],
  ])(
    "retains the ten-item baseline when startup-test %s fails",
    async (failureStage, reason) => {
      const records = Array.from({ length: 10 }, (_, index) =>
        discoveryRecord(`t5_failed${index}`, `Failed${index}`),
      );
      const reddit = wikiReddit({ data: discoveryV2Json(records) });
      const runJob = vi.fn().mockResolvedValue("startup-job");
      if (failureStage === "subreddit lookup") {
        reddit.getSubredditByName.mockRejectedValue(new Error("lookup failed"));
      } else {
        reddit.getSubredditByName.mockResolvedValue({
          id: "t5_subgoal",
          name: "SubGoal",
          type: "public",
          nsfw: false,
        });
        reddit.getModerators.mockReturnValue({
          get:
            failureStage === "moderator lookup"
              ? vi.fn().mockRejectedValue(new Error("moderator lookup failed"))
              : vi.fn().mockResolvedValue([{ username: "Alan-Foster" }]),
        });
        if (failureStage === "scheduling") {
          runJob.mockRejectedValue(new Error("scheduler unavailable"));
        }
      }
      const redis = new FakeRedis();
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      expect(await runPoll(reddit, redis, runJob)).toEqual({
        status: "baseline",
        discovered: 10,
        queued: 0,
        skipped: 10,
        startupTestStatus: "failed",
        startupFailureReason: reason,
      });
      expect(reddit.sendPrivateMessage).not.toHaveBeenCalled();
      expect(
        [...redis.values.entries()].filter(([key]) =>
          key.includes(":seen:v2:"),
        ),
      ).toHaveLength(10);
      expect(
        diagnosticPayload(warn, "invite_new_subs_startup_test_failed"),
      ).toMatchObject({ reason });

      expect(await runPoll(reddit, redis, runJob)).toMatchObject({
        status: "unchanged",
        startupTestStatus: "failed",
        startupFailureReason: reason,
      });
      expect(reddit.getSubredditByName).toHaveBeenCalledTimes(2);
    },
  );

  it("reports and retries an unsupported live SubGoal type", async () => {
    const records = Array.from({ length: 10 }, (_, index) =>
      discoveryRecord(`t5_privtest${index}`, `PrivateTest${index}`),
    );
    const reddit = wikiReddit({ data: discoveryV2Json(records) });
    reddit.getSubredditByName.mockResolvedValue({
      id: "t5_subgoal",
      name: "SubGoal",
      type: "private",
      nsfw: false,
    });
    const redis = new FakeRedis();
    const runJob = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await runPoll(reddit, redis, runJob)).toMatchObject({
      startupTestStatus: "failed",
      startupFailureReason: "unsupported_subreddit_type",
    });
    expect(
      diagnosticPayload(warn, "invite_new_subs_startup_test_failed"),
    ).toMatchObject({
      reason: "unsupported_subreddit_type",
      subredditType: "private",
    });
    expect(reddit.getModerators).not.toHaveBeenCalled();
    expect(runJob).not.toHaveBeenCalled();

    await runPoll(reddit, redis, runJob);
    expect(reddit.getSubredditByName).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed startup test pending across later batches in the same session", async () => {
    const records = Array.from({ length: 10 }, (_, index) =>
      discoveryRecord(`t5_retry${index}`, `Retry${index}`),
    );
    const reddit = wikiReddit({ data: discoveryV2Json(records) });
    reddit.getSubredditByName.mockResolvedValue({
      id: "t5_subgoal",
      name: "SubGoal",
      type: "restricted",
      nsfw: false,
    });
    reddit.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "Alan-Foster" }]),
    });
    const redis = new FakeRedis();
    const runJob = vi
      .fn()
      .mockRejectedValueOnce(new Error("scheduler unavailable"))
      .mockResolvedValueOnce("startup-job");

    expect(await runPoll(reddit, redis, runJob)).toMatchObject({
      status: "baseline",
      startupTestStatus: "failed",
      startupFailureReason: "schedule_failed",
    });
    const replacement = Array.from({ length: 10 }, (_, index) =>
      discoveryRecord(`t5_retrylater${index}`, `RetryLater${index}`, {
        createdUtc: 1_792_695_720 - index,
      }),
    );
    reddit.getSubredditByName.mockImplementation(async (name: string) =>
      name === "SubGoal"
        ? {
            id: "t5_subgoal",
            name: "SubGoal",
            type: "restricted",
            nsfw: false,
          }
        : { id: `t5_${name.toLowerCase()}`, name, type: "public", nsfw: false },
    );
    reddit.getModerators.mockImplementation(
      ({ subredditName }: { subredditName: string }) => ({
        get: vi.fn().mockResolvedValue([{ username: `${subredditName}Owner` }]),
      }),
    );
    reddit.getWikiPage.mockImplementation(async (_subreddit, page) => ({
      content:
        page === inviteNewSubsControlWikiPage
          ? "enabled"
          : page === inviteNewSubsMessageWikiPage
            ? inviteNewSubsMessageTemplate
            : discoveryV2Json(replacement, "2026-10-22T19:02:00Z"),
      wikiVersion: "v1",
      revisionId: "aged-retry",
      revisionDate: new Date("2026-10-22T19:02:01Z"),
    }));
    expect(await runPoll(reddit, redis, runJob)).toMatchObject({
      status: "processed",
      discovered: 10,
      queued: 11,
      skipped: 0,
      startupTestStatus: "queued",
    });
    expect(runJob).toHaveBeenCalledTimes(12);
    expect(runJob.mock.calls[1]?.[0].data.deliveryKind).toBe("startup_test");
    expect(runJob.mock.calls[2]?.[0].runAt.getTime()).toBe(
      Date.parse("2026-10-22T19:00:15Z"),
    );
  });

  it("accepts a schema-v1 baseline without startup testing", async () => {
    const records = Array.from({ length: 10 }, (_, index) =>
      discoveryRecord(`t5_recovery${index}`, `Recovery${index}`, {
        createdUtc: 1_792_695_400,
      }),
    );
    const generatedAt = "2026-10-22T19:00:00Z";
    const redis = new FakeRedis();
    redis.values.set("invite_new_subs:gate_state:v1", "enabled");
    redis.values.set(
      "invite_new_subs:batch_identity:v1",
      JSON.stringify([
        1,
        "legacy",
        generatedAt,
        ...records.map((record) => record.id),
      ]),
    );
    for (const record of records) {
      redis.values.set(
        `invite_new_subs:seen:v2:${record.id}`,
        JSON.stringify({
          status: "baseline",
          subredditId: record.id,
          subredditName: record.displayName,
          updatedAt: Date.parse(generatedAt),
        }),
      );
    }
    const reddit = wikiReddit({
      data: discoveryJson(records, generatedAt),
    });
    reddit.getSubredditByName.mockResolvedValue({
      id: "t5_subgoal",
      name: "SubGoal",
      type: "restricted",
      nsfw: false,
    });
    reddit.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "Alan-Foster" }]),
    });
    const runJob = vi.fn().mockResolvedValue("overload-job");

    expect(await runPoll(reddit, redis, runJob)).toMatchObject({
      status: "unchanged",
      queued: 0,
    });
    expect(reddit.getSubredditByName).not.toHaveBeenCalled();
    expect(runJob).not.toHaveBeenCalled();
  });

  it("keeps freshness boundaries observable but does not use them for eligibility", async () => {
    const records = Array.from({ length: 10 }, (_, index) =>
      discoveryRecord(`t5_boundary${index}`, `Boundary${index}`, {
        createdUtc:
          index === 0
            ? 1_792_695_601
            : index === 1
              ? 1_792_695_540
              : 1_792_695_590,
      }),
    );
    const reddit = wikiReddit({ data: discoveryV2Json(records) });
    reddit.getSubredditByName.mockResolvedValue({
      id: "t5_subgoal",
      name: "SubGoal",
      type: "restricted",
      nsfw: false,
    });
    reddit.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "Alan-Foster" }]),
    });
    const runJob = vi.fn().mockResolvedValue("startup-job");

    expect(await runPoll(reddit, new FakeRedis(), runJob)).toMatchObject({
      queued: 1,
      startupTestStatus: "queued",
    });
  });

  it("allows only one scheduler job from concurrent startup polls", async () => {
    const records = Array.from({ length: 10 }, (_, index) =>
      discoveryRecord(`t5_concurrent${index}`, `Concurrent${index}`),
    );
    const reddit = wikiReddit({ data: discoveryV2Json(records) });
    reddit.getSubredditByName.mockResolvedValue({
      id: "t5_subgoal",
      name: "SubGoal",
      type: "restricted",
      nsfw: false,
    });
    reddit.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "Alan-Foster" }]),
    });
    const redis = new FakeRedis();
    const runJob = vi.fn().mockResolvedValue("startup-job");

    const results = await Promise.all([
      runPoll(reddit, redis, runJob),
      runPoll(reddit, redis, runJob),
    ]);

    expect(results.filter((result) => result.queued === 1)).toHaveLength(1);
    expect(runJob).toHaveBeenCalledOnce();
  });

  it("baselines all-unknown data even when the gate state says enabled", async () => {
    const redis = new FakeRedis();
    redis.values.set("invite_new_subs:gate_state:v1", "enabled");
    const reddit = wikiReddit({
      data: discoveryJson([discoveryRecord("t5_fresh", "Fresh")]),
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    expect((await runPoll(reddit, redis)).status).toBe("baseline");
    expect(reddit.getSubredditByName).not.toHaveBeenCalled();
    expect(
      diagnosticPayload(info, "invite_new_subs_batch_classified"),
    ).toMatchObject({
      allIdsAreAbsent: true,
      baselineReason: "legacy_all_unseen",
      fullBatchAllUnseen: false,
    });
  });

  it("queues unseen public communities oldest-first at fifteen-second offsets", async () => {
    const now = Date.parse("2026-10-22T19:00:00Z");
    const redis = new FakeRedis();
    const reddit = wikiReddit();
    const runJob = vi.fn().mockResolvedValue("job-id");
    await runPoll(reddit, redis, runJob, now - 300_000);

    const nextRecords = [
      discoveryRecord("t5_newest", "Newest", {
        over18: true,
        createdUtc: 1_792_695_590,
      }),
      discoveryRecord("t5_older", "Older", { createdUtc: 1_792_695_580 }),
      discoveryRecord("t5_existing", "Existing"),
    ];
    reddit.getWikiPage.mockImplementation(async (_subreddit, page) => ({
      content:
        page === inviteNewSubsControlWikiPage
          ? "enabled"
          : page === inviteNewSubsMessageWikiPage
            ? inviteNewSubsMessageTemplate
            : discoveryJson(nextRecords, "2026-10-22T19:05:00Z"),
      wikiVersion: "v1",
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
        templateId: "template-1",
        renderedMessage: expect.stringContaining("NSFW: no"),
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
        templateId: "template-2",
      }),
      runAt: new Date(now + 15_000),
    });
  });

  it("queues up to the global limit oldest-first and wraps the template sequence", async () => {
    const now = Date.parse("2026-10-22T19:00:00Z");
    const redis = new FakeRedis();
    const reddit = wikiReddit();
    const runJob = vi.fn().mockResolvedValue("job-id");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await runPoll(reddit, redis, runJob, now - 300_000);

    const burst = [
      ...Array.from({ length: 6 }, (_, index) =>
        discoveryRecord(`t5_burst${index}`, `Burst${index}`, {
          createdUtc: 1_792_695_600 + index,
        }),
      ),
      discoveryRecord("t5_existing", "Existing"),
    ];
    reddit.getWikiPage.mockImplementation(async (_subreddit, page) => ({
      content:
        page === inviteNewSubsControlWikiPage
          ? "enabled"
          : page === inviteNewSubsMessageWikiPage
            ? inviteNewSubsMessageTemplate
            : discoveryJson(burst, "2026-10-22T19:05:00Z"),
      wikiVersion: "v1",
      revisionId: "burst",
      revisionDate: new Date(),
    }));
    reddit.getSubredditByName.mockImplementation(async (name: string) => ({
      name,
      type: "public",
      nsfw: false,
    }));
    reddit.getModerators.mockImplementation(
      ({ subredditName }: { subredditName: string }) => ({
        get: vi.fn().mockResolvedValue([{ username: `${subredditName}Owner` }]),
      }),
    );

    expect(await runPoll(reddit, redis, runJob, now)).toEqual({
      status: "processed",
      discovered: 6,
      queued: 6,
      skipped: 0,
    });
    expect(
      runJob.mock.calls.map(([job]) => ({
        subredditName: job.data.subredditName,
        templateId: job.data.templateId,
        runAt: job.runAt,
      })),
    ).toEqual([
      {
        subredditName: "Burst0",
        templateId: "template-1",
        runAt: new Date(now),
      },
      {
        subredditName: "Burst1",
        templateId: "template-2",
        runAt: new Date(now + 15_000),
      },
      {
        subredditName: "Burst2",
        templateId: "template-3",
        runAt: new Date(now + 30_000),
      },
      {
        subredditName: "Burst3",
        templateId: "template-4",
        runAt: new Date(now + 45_000),
      },
      {
        subredditName: "Burst4",
        templateId: "template-5",
        runAt: new Date(now + 60_000),
      },
      {
        subredditName: "Burst5",
        templateId: "template-1",
        runAt: new Date(now + 75_000),
      },
    ]);

    const later = [
      discoveryRecord("t5_later1", "Later1", {
        createdUtc: 1_792_695_700,
      }),
      discoveryRecord("t5_later0", "Later0", {
        createdUtc: 1_792_695_699,
      }),
      burst[5]!,
    ];
    reddit.getWikiPage.mockImplementation(async (_subreddit, page) => ({
      content:
        page === inviteNewSubsControlWikiPage
          ? "enabled"
          : page === inviteNewSubsMessageWikiPage
            ? inviteNewSubsMessageTemplate
            : discoveryJson(later, "2026-10-22T19:06:00Z"),
      wikiVersion: "v1",
      revisionId: "later",
      revisionDate: new Date(),
    }));

    expect(await runPoll(reddit, redis, runJob, now + 60_000)).toMatchObject({
      queued: 2,
      skipped: 0,
    });
    expect(runJob.mock.calls[6]?.[0].data.templateId).toBe("template-2");
    expect(runJob.mock.calls[7]?.[0].data.templateId).toBe("template-3");
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
      wikiVersion: "v1",
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
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    expect((await runPoll(reenabled, redis, runJob)).status).toBe("baseline");
    expect(runJob).not.toHaveBeenCalled();
    expect(reenabled.getSubredditByName).not.toHaveBeenCalled();
    expect(
      diagnosticPayload(info, "invite_new_subs_batch_classified"),
    ).toMatchObject({ baselineReason: "gate_reenabled" });
  });

  it("alerts when re-enabling into a ten-item all-unseen baseline", async () => {
    const redis = new FakeRedis();
    await runPoll(wikiReddit(), redis);
    await runPoll(wikiReddit({ control: "disabled" }), redis);
    const records = Array.from({ length: 10 }, (_, index) =>
      discoveryRecord(`t5_reenabled${index}`, `Reenabled${index}`, {
        createdUtc: 1_792_695_890,
      }),
    );
    const reenabled = wikiReddit({
      data: discoveryV2Json(
        records,
        "2026-10-22T19:05:00Z",
        secondPublisherSessionId,
        "2026-10-22T19:04:50Z",
      ),
    });
    reenabled.getSubredditByName.mockResolvedValue({
      id: "t5_subgoal",
      name: "SubGoal",
      type: "public",
      nsfw: false,
    });
    reenabled.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "Alan-Foster" }]),
    });
    const runJob = vi.fn().mockResolvedValue("startup-job");

    expect(await runPoll(reenabled, redis, runJob)).toMatchObject({
      status: "baseline",
      queued: 1,
    });
    expect(runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          topModerator: "Alan-Foster",
          deliveryKind: "startup_test",
          startupSessionId: secondPublisherSessionId,
        }),
      }),
    );
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
        wikiVersion: "v1",
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

  it("reports native JSON errors and v1 revision metadata without logging content", async () => {
    const reddit = wikiReddit({ template: "{ invalid" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect((await runPoll(reddit, new FakeRedis())).status).toBe(
      "template_unavailable",
    );
    const diagnostic = diagnosticPayload(
      warn,
      "invite_new_subs_template_unavailable",
    );
    expect(diagnostic).toMatchObject({
      phase: "template_validation",
      requestedWikiVersion: "v1",
      returnedWikiVersion: "v1",
      revisionId: "11111111-1111-1111-1111-111111111111",
      contentLength: 9,
      failureStage: "json_validation",
    });
    expect(String(diagnostic?.errorMessage)).toContain("valid JSON:");
    expect(JSON.stringify(diagnostic)).not.toContain("{ invalid");
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
      wikiVersion: "v1",
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
      wikiVersion: "v1",
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

  it("does not overwrite an immediate terminal delivery with queued state", async () => {
    const now = Date.parse("2026-10-22T19:05:00Z");
    const redis = new FakeRedis();
    await runPoll(wikiReddit(), redis);
    const records = [
      discoveryRecord("t5_immediate", "Immediate", {
        createdUtc: now / 1000 - 10,
      }),
      discoveryRecord("t5_existing", "Existing"),
    ];
    const reddit = wikiReddit({
      data: discoveryJson(records, "2026-10-22T19:05:00Z"),
    });
    reddit.getSubredditByName.mockResolvedValue({
      id: "t5_immediate",
      name: "Immediate",
      type: "public",
      nsfw: false,
    });
    reddit.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "ImmediateOwner" }]),
    });
    const runJob = vi.fn(
      async ({ data }: { data: InviteNewSubsDeliveryJob }) => {
        await processInviteNewSubsDelivery({
          reddit: reddit as unknown as RedditClient,
          redis: asRedis(redis),
          job: data,
          now: () => now,
        });
        return "immediate-job";
      },
    );
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    expect(await runPoll(reddit, redis, runJob, now)).toMatchObject({
      discovered: 1,
      queued: 1,
    });
    expect(
      JSON.parse(
        redis.values.get("invite_new_subs:seen:v2:t5_immediate") ?? "{}",
      ),
    ).toMatchObject({ status: "messaged" });
    expect(
      diagnosticPayload(info, "invite_new_subs_state_transition_skipped"),
    ).toMatchObject({
      subredditId: "t5_immediate",
      attemptedStatus: "queued",
      observedStatus: "messaged",
    });
  });

  it("baselines each distinct 25-of-25 unseen batch and queues one full-batch test", async () => {
    const firstRecords = Array.from({ length: 25 }, (_, index) =>
      discoveryRecord(`t5_fulla${index}`, `FullA${index}`),
    );
    const reddit = wikiReddit({ data: discoveryV2Json(firstRecords) });
    reddit.getSubredditByName.mockResolvedValue({
      id: "t5_subgoal",
      name: "SubGoal",
      type: "restricted",
      nsfw: false,
    });
    reddit.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "Alan-Foster" }]),
    });
    const redis = new FakeRedis();
    const runJob = vi.fn().mockResolvedValue("full-batch-test");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    expect(await runPoll(reddit, redis, runJob)).toEqual({
      status: "baseline",
      discovered: 25,
      queued: 1,
      skipped: 25,
    });
    expect(runJob).toHaveBeenCalledOnce();
    expect(runJob.mock.calls[0]?.[0]).toMatchObject({
      data: {
        deliveryKind: "full_batch_test",
        fullBatchEventId: "2026-10-22T19:00:00Z",
        fullBatchSignature: firstRecords.map((record) => record.id).join(","),
        subredditName: "SubGoal",
        topModerator: "Alan-Foster",
      },
    });
    expect(
      diagnosticPayload(info, "invite_new_subs_batch_classified"),
    ).toMatchObject({
      batchSize: 25,
      unseen: 25,
      fullBatchAllUnseen: true,
      baselineReason: "full_batch_all_unseen",
    });
    expect(await runPoll(reddit, redis, runJob)).toMatchObject({
      status: "unchanged",
      queued: 0,
    });

    const secondRecords = Array.from({ length: 25 }, (_, index) =>
      discoveryRecord(`t5_fullb${index}`, `FullB${index}`),
    );
    reddit.getWikiPage.mockImplementation(async (_subreddit, page) => ({
      content:
        page === inviteNewSubsControlWikiPage
          ? "enabled"
          : page === inviteNewSubsMessageWikiPage
            ? inviteNewSubsMessageTemplate
            : discoveryV2Json(secondRecords, "2026-10-22T19:01:00Z"),
      wikiVersion: "v1",
      revisionId: "second-full-batch",
      revisionDate: new Date("2026-10-22T19:01:01Z"),
    }));

    expect(
      await runPoll(reddit, redis, runJob, Date.parse("2026-10-22T19:01:01Z")),
    ).toMatchObject({
      status: "baseline",
      discovered: 25,
      queued: 1,
      skipped: 25,
    });
    expect(runJob).toHaveBeenCalledTimes(2);
    expect(runJob.mock.calls[1]?.[0].data).toMatchObject({
      deliveryKind: "full_batch_test",
      fullBatchEventId: "2026-10-22T19:01:00Z",
    });
  });

  it("rolls back every baseline record and alert index when the transaction fails", async () => {
    const records = Array.from({ length: 25 }, (_, index) =>
      discoveryRecord(`t5_atomic${index}`, `Atomic${index}`),
    );
    const reddit = wikiReddit({ data: discoveryV2Json(records) });
    reddit.getSubredditByName.mockResolvedValue({
      id: "t5_subgoal",
      name: "SubGoal",
      type: "restricted",
      nsfw: false,
    });
    reddit.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "Alan-Foster" }]),
    });
    const redis = new FakeRedis();
    redis.failTransactionAtCommand = 8;
    const runJob = vi.fn().mockResolvedValue("full-batch-test");

    await expect(runPoll(reddit, redis, runJob)).rejects.toThrow(
      "failed transaction command 8",
    );
    expect(
      [...redis.values.keys()].filter((key) => key.includes(":seen:v2:")),
    ).toHaveLength(0);
    expect(redis.sortedSets.get("invite_new_subs:full_batch_pending:v1")).toBe(
      undefined,
    );
    expect(runJob).not.toHaveBeenCalled();

    expect(await runPoll(reddit, redis, runJob)).toMatchObject({
      status: "baseline",
      discovered: 25,
      queued: 1,
      skipped: 25,
    });
    expect(
      [...redis.values.keys()].filter((key) => key.includes(":seen:v2:")),
    ).toHaveLength(25);
    expect(runJob).toHaveBeenCalledOnce();
  });

  it("reconstructs a missing pending event from a legacy full-batch marker", async () => {
    const records = Array.from({ length: 25 }, (_, index) =>
      discoveryRecord(`t5_recover${index}`, `Recover${index}`),
    );
    const reddit = wikiReddit({ data: discoveryV2Json(records) });
    reddit.getSubredditByName.mockResolvedValue({
      id: "t5_subgoal",
      name: "SubGoal",
      type: "restricted",
      nsfw: false,
    });
    reddit.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "Alan-Foster" }]),
    });
    const redis = new FakeRedis();
    const runJob = vi.fn().mockResolvedValue("full-batch-test");
    await runPoll(reddit, redis, runJob);
    const markerKey = [...redis.values.keys()].find((key) =>
      key.startsWith("invite_new_subs:full_batch_marker:v1:"),
    );
    expect(markerKey).toBeDefined();
    await redis.set(markerKey!, "legacy-claim-token");
    redis.sortedSets.delete("invite_new_subs:full_batch_pending:v1");
    reddit.getWikiPage.mockImplementation(async (_subreddit, page) => ({
      content:
        page === inviteNewSubsControlWikiPage
          ? "enabled"
          : page === inviteNewSubsMessageWikiPage
            ? inviteNewSubsMessageTemplate
            : discoveryV2Json(records, "2026-10-22T19:01:00Z"),
      wikiVersion: "v1",
      revisionId: "recovery",
      revisionDate: new Date("2026-10-22T19:01:00Z"),
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      await runPoll(reddit, redis, runJob, Date.parse("2026-10-22T19:01:00Z")),
    ).toMatchObject({ status: "unchanged", queued: 1 });
    expect(runJob).toHaveBeenCalledTimes(2);
    expect(
      diagnosticPayload(warn, "invite_new_subs_full_batch_pending_recovered"),
    ).toMatchObject({ markerState: "legacy", batchSize: 25 });
  });

  it("preserves an immediate full-batch delivery marker", async () => {
    const now = Date.parse("2026-10-22T19:00:00Z");
    const records = Array.from({ length: 25 }, (_, index) =>
      discoveryRecord(`t5_marker${index}`, `Marker${index}`),
    );
    const reddit = wikiReddit({ data: discoveryV2Json(records) });
    reddit.getSubredditByName.mockResolvedValue({
      id: "t5_subgoal",
      name: "SubGoal",
      type: "restricted",
      nsfw: false,
    });
    reddit.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "Alan-Foster" }]),
    });
    const redis = new FakeRedis();
    const runJob = vi.fn(
      async ({ data }: { data: InviteNewSubsDeliveryJob }) => {
        await processInviteNewSubsDelivery({
          reddit: reddit as unknown as RedditClient,
          redis: asRedis(redis),
          job: data,
          now: () => now,
        });
        return "immediate-full-batch-job";
      },
    );

    expect(await runPoll(reddit, redis, runJob, now)).toMatchObject({
      status: "baseline",
      queued: 1,
    });
    const marker = [...redis.values.entries()].find(([key]) =>
      key.startsWith("invite_new_subs:full_batch_marker:v1:"),
    );
    expect(marker?.[1]).toBe("delivered:2026-10-22T19:00:00Z");
  });

  it("retries a pending full-batch test after scheduler failure", async () => {
    const records = Array.from({ length: 25 }, (_, index) =>
      discoveryRecord(`t5_pending${index}`, `Pending${index}`),
    );
    const reddit = wikiReddit({ data: discoveryV2Json(records) });
    reddit.getSubredditByName.mockResolvedValue({
      id: "t5_subgoal",
      name: "SubGoal",
      type: "restricted",
      nsfw: false,
    });
    reddit.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "Alan-Foster" }]),
    });
    const redis = new FakeRedis();
    const runJob = vi
      .fn()
      .mockRejectedValueOnce(new Error("scheduler unavailable"))
      .mockResolvedValueOnce("retry-job");

    expect(await runPoll(reddit, redis, runJob)).toMatchObject({
      status: "baseline",
      queued: 0,
      skipped: 25,
    });
    expect(await runPoll(reddit, redis, runJob)).toMatchObject({
      status: "unchanged",
      queued: 1,
    });
    expect(runJob).toHaveBeenCalledTimes(2);
  });

  it("queues the oldest 16 of a 24-record batch and rate-limits newer overflow", async () => {
    const generatedAt = "2026-10-22T19:05:00Z";
    const generatedAtSeconds = Date.parse(generatedAt) / 1000;
    const records = Array.from({ length: 24 }, (_, index) =>
      discoveryRecord(`t5_twentyfour${index}`, `TwentyFour${index}`, {
        createdUtc: generatedAtSeconds - (24 - index),
      }),
    );
    const reddit = wikiReddit({ data: discoveryV2Json(records, generatedAt) });
    reddit.getSubredditByName.mockImplementation(async (name: string) => ({
      id: `t5_live${name.toLowerCase()}`,
      name,
      type: "public",
      nsfw: false,
    }));
    reddit.getModerators.mockImplementation(
      ({ subredditName }: { subredditName: string }) => ({
        get: vi.fn().mockResolvedValue([{ username: `${subredditName}Owner` }]),
      }),
    );
    const redis = new FakeRedis();
    const runJob = vi.fn().mockResolvedValue("job");
    const now = Date.parse(generatedAt);

    expect(await runPoll(reddit, redis, runJob, now)).toEqual({
      status: "processed",
      discovered: 24,
      queued: 16,
      skipped: 8,
      rateLimited: 8,
    });
    expect(runJob).toHaveBeenCalledTimes(16);
    expect(
      runJob.mock.calls.map(([scheduled]) => scheduled.data.subredditName),
    ).toEqual(records.slice(0, 16).map((record) => record.displayName));
    expect(
      runJob.mock.calls.map(([scheduled]) => scheduled.runAt.getTime()),
    ).toEqual(Array.from({ length: 16 }, (_, index) => now + index * 15_000));
    for (const record of records.slice(16)) {
      expect(
        JSON.parse(
          redis.values.get(
            `invite_new_subs:seen:v2:${record.id.toLowerCase()}`,
          ) ?? "{}",
        ).status,
      ).toBe("rate_limited");
    }
  });

  it("serializes concurrent polls so the global queue never exceeds 16", async () => {
    const records = Array.from({ length: 24 }, (_, index) =>
      discoveryRecord(`t5_concurrent${index}`, `Concurrent${index}`, {
        createdUtc: 1_792_695_500 + index,
      }),
    );
    const reddit = wikiReddit({ data: discoveryV2Json(records) });
    reddit.getSubredditByName.mockImplementation(async (name: string) => ({
      id: `t5_live${name.toLowerCase()}`,
      name,
      type: "public",
      nsfw: false,
    }));
    reddit.getModerators.mockImplementation(
      ({ subredditName }: { subredditName: string }) => ({
        get: vi.fn().mockResolvedValue([{ username: `${subredditName}Owner` }]),
      }),
    );
    const redis = new FakeRedis();
    const runJob = vi.fn().mockResolvedValue("job");

    const results = await Promise.all([
      runPoll(reddit, redis, runJob),
      runPoll(reddit, redis, runJob),
    ]);

    expect(results.reduce((total, result) => total + result.queued, 0)).toBe(
      16,
    );
    expect(runJob).toHaveBeenCalledTimes(16);
    expect(
      redis.sortedSets.get("invite_new_subs:delivery_queue:v1")?.size,
    ).toBe(16);
  });

  it("removes a queue ledger entry after terminal delivery", async () => {
    const records = [discoveryRecord("t5_release", "Release")];
    const reddit = wikiReddit({ data: discoveryV2Json(records) });
    reddit.getSubredditByName.mockResolvedValue({
      id: "t5_release",
      name: "Release",
      type: "public",
      nsfw: false,
    });
    reddit.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "ReleaseOwner" }]),
    });
    const redis = new FakeRedis();
    const runJob = vi.fn().mockResolvedValue("job");

    await runPoll(reddit, redis, runJob);
    const scheduledJob = runJob.mock.calls[0]?.[0]
      .data as InviteNewSubsDeliveryJob;
    expect(
      redis.sortedSets.get("invite_new_subs:delivery_queue:v1")?.size,
    ).toBe(1);
    await processInviteNewSubsDelivery({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      job: scheduledJob,
    });
    expect(
      redis.sortedSets.get("invite_new_subs:delivery_queue:v1")?.size,
    ).toBe(0);
  });

  it("recovers stale queue entries before reserving capacity", async () => {
    const now = Date.parse("2026-10-22T19:20:00Z");
    const redis = new FakeRedis();
    redis.sortedSets.set(
      "invite_new_subs:delivery_queue:v1",
      new Map([["abandoned-entry", now - 11 * 60_000]]),
    );
    const reddit = wikiReddit({
      data: discoveryV2Json(
        [discoveryRecord("t5_afterstale", "AfterStale")],
        "2026-10-22T19:20:00Z",
      ),
    });
    reddit.getSubredditByName.mockResolvedValue({
      id: "t5_afterstale",
      name: "AfterStale",
      type: "public",
      nsfw: false,
    });
    reddit.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "AfterStaleOwner" }]),
    });
    const runJob = vi.fn().mockResolvedValue("job");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await runPoll(reddit, redis, runJob, now)).toMatchObject({
      queued: 1,
    });
    expect(runJob.mock.calls[0]?.[0].runAt).toEqual(new Date(now));
    expect(
      diagnosticPayload(warn, "invite_new_subs_queue_stale_entries_removed"),
    ).toMatchObject({ staleCount: 1 });
  });
});

function diagnosticPayload(
  spy: { mock: { calls: unknown[][] } },
  event: string,
): Record<string, unknown> | undefined {
  return diagnosticPayloads(spy, event)[0];
}

function diagnosticPayloads(
  spy: { mock: { calls: unknown[][] } },
  event: string,
): Record<string, unknown>[] {
  const prefix = "[diagnostic] ";
  const payloads: Record<string, unknown>[] = [];
  for (const [line] of spy.mock.calls) {
    const text = String(line);
    if (!text.startsWith(prefix)) continue;
    const payload = JSON.parse(text.slice(prefix.length)) as Record<
      string,
      unknown
    >;
    if (payload.event === event) payloads.push(payload);
  }
  return payloads;
}

describe("processInviteNewSubsDelivery", () => {
  const job: InviteNewSubsDeliveryJob = {
    subredditId: "t5_newcommunity",
    subredditName: "NewCommunity",
    topModerator: "FoundingMod",
    isNsfw: false,
    renderedMessage: "Detected r/NewCommunity for u/FoundingMod.",
  };
  const overloadTestJob: InviteNewSubsDeliveryJob = {
    subredditId: "t5_subgoal",
    subredditName: "SubGoal",
    topModerator: "Alan-Foster",
    isNsfw: false,
    renderedMessage: "Detected r/SubGoal for u/Alan-Foster.",
    deliveryKind: "overload_test",
    overloadEventId: "2026-10-23T11:00:00Z",
  };
  const startupTestJob: InviteNewSubsDeliveryJob = {
    subredditId: "t5_subgoal",
    subredditName: "SubGoal",
    topModerator: "Alan-Foster",
    isNsfw: false,
    renderedMessage: "Detected r/SubGoal for u/Alan-Foster.",
    deliveryKind: "startup_test",
    startupSessionId: publisherSessionId,
  };
  const fullBatchSignature = Array.from(
    { length: 25 },
    (_, index) => `t5_full${index}`,
  ).join(",");
  const fullBatchTestJob: InviteNewSubsDeliveryJob = {
    subredditId: "t5_subgoal",
    subredditName: "SubGoal",
    topModerator: "Alan-Foster",
    isNsfw: false,
    renderedMessage: "Detected r/SubGoal for u/Alan-Foster.",
    deliveryKind: "full_batch_test",
    fullBatchEventId: "2026-10-23T11:02:00Z",
    fullBatchSignature,
    queueEntryId: "full-batch-queue-entry",
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
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

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
    expect(diagnosticPayload(info, "invite_new_subs_dm_sent")).toMatchObject({
      subredditId: "t5_newcommunity",
      subredditName: "NewCommunity",
      recipientUsername: "FoundingMod",
      deliveryKind: "standard",
    });
    expect(
      info.mock.calls.filter(([line]) =>
        String(line).includes('"event":"invite_new_subs_dm_sent"'),
      ),
    ).toHaveLength(1);
  });

  it("deduplicates one overload event but bypasses cooldown for later events", async () => {
    const now = Date.parse("2026-10-23T11:00:00Z");
    const redis = new FakeRedis();
    const secondOverloadJob: InviteNewSubsDeliveryJob = {
      ...overloadTestJob,
      overloadEventId: "2026-10-23T11:01:00Z",
    };
    const reddit = { sendPrivateMessage: vi.fn().mockResolvedValue(undefined) };

    expect(
      await processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        job: overloadTestJob,
        now: () => now,
      }),
    ).toBe("messaged");
    expect(
      await processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        job: overloadTestJob,
        now: () => now + 1,
      }),
    ).toBe("duplicate");
    expect(
      await processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        job: secondOverloadJob,
        now: () => now + 2,
      }),
    ).toBe("messaged");

    expect(reddit.sendPrivateMessage).toHaveBeenCalledTimes(2);
    expect(reddit.sendPrivateMessage).toHaveBeenCalledWith({
      to: "Alan-Foster",
      subject: inviteNewSubsSubject,
      text: overloadTestJob.renderedMessage,
    });
    expect(
      redis.values.has("invite_new_subs:recipient_cooldown:v1:alan-foster"),
    ).toBe(false);
    expect(
      redis.sortedSets.get("invite_new_subs:delivery_metrics:v1")?.size,
    ).toBe(2);
  });

  it("deduplicates startup delivery by session and bypasses recipient cooldown", async () => {
    const redis = new FakeRedis();
    const secondSessionJob: InviteNewSubsDeliveryJob = {
      ...startupTestJob,
      startupSessionId: secondPublisherSessionId,
    };
    const reddit = { sendPrivateMessage: vi.fn().mockResolvedValue(undefined) };

    expect(
      await processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        job: startupTestJob,
      }),
    ).toBe("messaged");
    expect(
      await processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        job: startupTestJob,
      }),
    ).toBe("duplicate");
    expect(
      await processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        job: secondSessionJob,
      }),
    ).toBe("messaged");
    expect(reddit.sendPrivateMessage).toHaveBeenCalledTimes(2);
    expect(
      redis.values.has("invite_new_subs:recipient_cooldown:v1:alan-foster"),
    ).toBe(false);
  });

  it("delivers and records a full-batch test while releasing its queue entry", async () => {
    const redis = new FakeRedis();
    redis.sortedSets.set(
      "invite_new_subs:delivery_queue:v1",
      new Map([[fullBatchTestJob.queueEntryId!, Date.now()]]),
    );
    const reddit = { sendPrivateMessage: vi.fn().mockResolvedValue(undefined) };
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    expect(
      await processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        job: fullBatchTestJob,
      }),
    ).toBe("messaged");
    expect(
      await processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        job: fullBatchTestJob,
      }),
    ).toBe("duplicate");
    expect(reddit.sendPrivateMessage).toHaveBeenCalledOnce();
    expect(
      redis.sortedSets.get("invite_new_subs:delivery_queue:v1")?.size,
    ).toBe(0);
    expect(
      redis.values.get(
        `invite_new_subs:full_batch_marker:v1:${encodeURIComponent(fullBatchSignature)}`,
      ),
    ).toBe("delivered:2026-10-23T11:02:00Z");
    expect(
      diagnosticPayload(info, "invite_new_subs_full_batch_test_delivered"),
    ).toMatchObject({
      fullBatchEventId: "2026-10-23T11:02:00Z",
      recipientUsername: "alan-foster",
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
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

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
    expect(diagnosticPayload(info, "invite_new_subs_dm_sent")).toBeUndefined();
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

  it("releases a queue entry for invalid delivery data", async () => {
    const redis = new FakeRedis();
    redis.sortedSets.set(
      "invite_new_subs:delivery_queue:v1",
      new Map([["invalid-job-entry", Date.now()]]),
    );
    const reddit = { sendPrivateMessage: vi.fn() };

    expect(
      await processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        job: {
          ...job,
          subredditId: "invalid" as SubredditId,
          queueEntryId: "invalid-job-entry",
        },
      }),
    ).toBe("invalid");
    expect(
      redis.sortedSets.get("invite_new_subs:delivery_queue:v1")?.size,
    ).toBe(0);
  });

  it("rejects an incomplete overload-test delivery identity", async () => {
    const reddit = { sendPrivateMessage: vi.fn() };
    expect(
      await processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(new FakeRedis()),
        job: {
          ...overloadTestJob,
          overloadEventId: undefined,
        },
      }),
    ).toBe("invalid");
    expect(reddit.sendPrivateMessage).not.toHaveBeenCalled();
  });

  it("rejects an incomplete startup-test delivery identity", async () => {
    const reddit = { sendPrivateMessage: vi.fn() };
    expect(
      await processInviteNewSubsDelivery({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(new FakeRedis()),
        job: { ...startupTestJob, startupSessionId: undefined },
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

  it("includes successful and failed startup-test deliveries", async () => {
    const redis = new FakeRedis();
    const deliveryReddit = {
      sendPrivateMessage: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("blocked")),
    };
    const startupJob: InviteNewSubsDeliveryJob = {
      subredditId: "t5_subgoal",
      subredditName: "SubGoal",
      topModerator: "Alan-Foster",
      isNsfw: false,
      renderedMessage: "Detected r/SubGoal for u/Alan-Foster.",
      deliveryKind: "startup_test",
      startupSessionId: publisherSessionId,
    };

    await processInviteNewSubsDelivery({
      reddit: deliveryReddit as unknown as RedditClient,
      redis: asRedis(redis),
      job: startupJob,
      now: () => windowStart + 1,
    });
    await processInviteNewSubsDelivery({
      reddit: deliveryReddit as unknown as RedditClient,
      redis: asRedis(redis),
      job: {
        ...startupJob,
        startupSessionId: secondPublisherSessionId,
      },
      now: () => windowStart + 2,
    });

    const reddit = reportReddit();
    await expect(
      processInviteNewSubsReport({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        now: () => reportNow,
      }),
    ).resolves.toMatchObject({
      total: 2,
      successful: 1,
      failed: 1,
    });
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
