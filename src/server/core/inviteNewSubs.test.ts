import { afterEach, describe, expect, it, vi } from "vitest";
import type { RedditClient, RedisClient } from "../types";
import {
  inviteNewSubsControlWikiPage,
  inviteNewSubsDeliveryJobName,
  inviteNewSubsHostSubreddit,
  inviteNewSubsListingUrl,
  inviteNewSubsMessageWikiPage,
  inviteNewSubsRecipient,
  inviteNewSubsRetentionSeconds,
  inviteNewSubsSubject,
  inviteNewSubsWikiVersion,
  processInviteNewSubsDelivery,
  processInviteNewSubsPoll,
  renderInviteNewSubsMessage,
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
  failNextRecordStatus: string | undefined;

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(
    key: string,
    value: string,
    options?: { nx?: boolean; expiration?: Date },
  ): Promise<string> {
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
}

const asRedis = (redis: FakeRedis): RedisClient =>
  redis as unknown as RedisClient;

const listingFetch = (...names: string[]) =>
  vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        children: names.map((display_name) => ({ data: { display_name } })),
      },
    }),
  });

const wikiReddit = (
  control = "enabled",
  template = inviteNewSubsMessageTemplate,
) => ({
  getWikiPage: vi.fn(
    async (
      _subredditName: string,
      page: string,
      _options?: { wikiVersion?: "v1" | "v2" },
    ) => ({
      content: page === inviteNewSubsControlWikiPage ? control : template,
      wikiVersion: inviteNewSubsWikiVersion,
      revisionId: "11111111-1111-1111-1111-111111111111",
      revisionDate: new Date("2026-10-22T11:55:00.000Z"),
    }),
  ),
  getSubredditByName: vi.fn(),
  getModerators: vi.fn(),
  sendPrivateMessage: vi.fn(),
});

describe("processInviteNewSubsPoll", () => {
  it("reads the current V2 pages and logs the evaluated gate and listing", async () => {
    const redis = new FakeRedis();
    const fetchClient = listingFetch("NewOne");
    const reddit = wikiReddit("  enabled\n");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const result = await processInviteNewSubsPoll({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler: { runJob: vi.fn() },
      subredditName: inviteNewSubsHostSubreddit,
      fetchClient,
    });

    expect(result.status).toBe("baseline");
    expect(reddit.getWikiPage).toHaveBeenNthCalledWith(
      1,
      inviteNewSubsHostSubreddit,
      inviteNewSubsControlWikiPage,
      { wikiVersion: "v2" },
    );
    expect(reddit.getWikiPage).toHaveBeenNthCalledWith(
      2,
      inviteNewSubsHostSubreddit,
      inviteNewSubsMessageWikiPage,
      { wikiVersion: "v2" },
    );
    expect(diagnosticPayload(info, "invite_new_subs_gate_evaluated")).toEqual({
      event: "invite_new_subs_gate_evaluated",
      workflow: "invite_new_subs",
      phase: "gate_read",
      subredditName: inviteNewSubsHostSubreddit,
      pageName: inviteNewSubsControlWikiPage,
      wikiVersion: "v2",
      extractedContent: "  enabled\n",
      normalizedValue: "enabled",
      enabled: true,
      revisionId: "11111111-1111-1111-1111-111111111111",
      revisionDate: "2026-10-22T11:55:00.000Z",
    });
    expect(diagnosticPayload(info, "invite_new_subs_listing_fetched")).toEqual({
      event: "invite_new_subs_listing_fetched",
      workflow: "invite_new_subs",
      phase: "listing_fetch",
      listingUrl: inviteNewSubsListingUrl,
      normalizedResultCount: 1,
    });
    expect(
      diagnosticPayload(info, "invite_new_subs_baseline_created"),
    ).toMatchObject({ baselineCount: 1 });
  });

  it("uses V2 content when the independent V1 page is disabled", async () => {
    const redis = new FakeRedis();
    const fetchClient = listingFetch("NewOne");
    const reddit = wikiReddit();
    reddit.getWikiPage.mockImplementation(
      async (_subredditName, page, options) => ({
        content:
          page === inviteNewSubsControlWikiPage
            ? options?.wikiVersion === "v2"
              ? "enabled"
              : "disabled"
            : inviteNewSubsMessageTemplate,
        wikiVersion: options?.wikiVersion ?? "v1",
        revisionId: "22222222-2222-2222-2222-222222222222",
        revisionDate: new Date("2026-10-22T11:55:00.000Z"),
      }),
    );

    const result = await processInviteNewSubsPoll({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler: { runJob: vi.fn() },
      subredditName: inviteNewSubsHostSubreddit,
      fetchClient,
    });

    expect(result.status).toBe("baseline");
    expect(fetchClient).toHaveBeenCalledWith(inviteNewSubsListingUrl, {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
  });

  it("does not fetch while the exact gate value is not enabled", async () => {
    const redis = new FakeRedis();
    const reddit = wikiReddit("Enabled");
    const fetchClient = listingFetch("Ignored");

    const result = await processInviteNewSubsPoll({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler: { runJob: vi.fn() },
      subredditName: "subscriber_goal_dev",
      fetchClient,
    });

    expect(result.status).toBe("disabled");
    expect(fetchClient).not.toHaveBeenCalled();
    expect([...redis.values.values()]).toContain("disabled");
  });

  it("baselines the first enabled listing and sends nothing", async () => {
    const now = Date.parse("2026-10-22T12:00:00.000Z");
    const redis = new FakeRedis();
    const reddit = wikiReddit();
    const runJob = vi.fn();

    const result = await processInviteNewSubsPoll({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler: { runJob },
      subredditName: "SUBSCRIBER_GOAL_DEV",
      fetchClient: listingFetch("NewOne", "OlderOne"),
      now: () => now,
    });

    expect(result).toEqual({
      status: "baseline",
      discovered: 2,
      queued: 0,
      skipped: 2,
    });
    expect(runJob).not.toHaveBeenCalled();
    const records = [...redis.values.entries()].filter(([key]) =>
      key.includes(":seen:"),
    );
    expect(records).toHaveLength(2);
    expect(
      records.every(([, value]) => JSON.parse(value).status === "baseline"),
    ).toBe(true);
    expect(
      [...redis.expirations.values()].every(
        (expiration) =>
          expiration.getTime() === now + inviteNewSubsRetentionSeconds * 1000,
      ),
    ).toBe(true);
  });

  it("baselines again after a confirmed disable and re-enable", async () => {
    const redis = new FakeRedis();
    const scheduler = { runJob: vi.fn() };
    const enabledReddit = wikiReddit();

    await processInviteNewSubsPoll({
      reddit: enabledReddit as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler,
      subredditName: "subscriber_goal_dev",
      fetchClient: listingFetch("First"),
    });
    await processInviteNewSubsPoll({
      reddit: wikiReddit("disabled") as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler,
      subredditName: "subscriber_goal_dev",
      fetchClient: listingFetch("Ignored"),
    });
    const result = await processInviteNewSubsPoll({
      reddit: enabledReddit as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler,
      subredditName: "subscriber_goal_dev",
      fetchClient: listingFetch("Second", "First"),
    });

    expect(result.status).toBe("baseline");
    expect(scheduler.runJob).not.toHaveBeenCalled();
  });

  it("queues unseen public communities oldest-first at one-minute offsets", async () => {
    const now = Date.parse("2026-10-22T12:00:00.000Z");
    const redis = new FakeRedis();
    const reddit = wikiReddit();
    const runJob = vi.fn().mockResolvedValue("job-id");

    await processInviteNewSubsPoll({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler: { runJob },
      subredditName: "subscriber_goal_dev",
      fetchClient: listingFetch("Existing"),
      now: () => now - 300_000,
    });
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

    const result = await processInviteNewSubsPoll({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler: { runJob },
      subredditName: "subscriber_goal_dev",
      fetchClient: listingFetch("Newest", "Older", "Existing", "Newest"),
      now: () => now,
    });

    expect(result).toEqual({
      status: "processed",
      discovered: 2,
      queued: 2,
      skipped: 0,
    });
    expect(runJob).toHaveBeenNthCalledWith(1, {
      name: inviteNewSubsDeliveryJobName,
      data: expect.objectContaining({
        subredditName: "Older",
        topModerator: "OlderOwner",
        isNsfw: false,
      }),
      runAt: new Date(now),
    });
    expect(runJob).toHaveBeenNthCalledWith(2, {
      name: inviteNewSubsDeliveryJobName,
      data: expect.objectContaining({
        subredditName: "Newest",
        topModerator: "NewestOwner",
        isNsfw: true,
        renderedMessage: expect.stringContaining("NSFW: yes"),
      }),
      runAt: new Date(now + 60_000),
    });
  });

  it("records non-public and failed lookups without retrying them", async () => {
    const redis = new FakeRedis();
    const reddit = wikiReddit();
    const scheduler = { runJob: vi.fn() };
    await processInviteNewSubsPoll({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler,
      subredditName: "subscriber_goal_dev",
      fetchClient: listingFetch("Existing"),
    });
    reddit.getSubredditByName.mockImplementation(async (name: string) => {
      if (name === "Broken") throw new Error("not found");
      return { name, type: "private", nsfw: false };
    });

    const first = await processInviteNewSubsPoll({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler,
      subredditName: "subscriber_goal_dev",
      fetchClient: listingFetch("Broken", "Private", "Existing"),
    });
    const second = await processInviteNewSubsPoll({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler,
      subredditName: "subscriber_goal_dev",
      fetchClient: listingFetch("Broken", "Private", "Existing"),
    });

    expect(first).toMatchObject({ discovered: 2, queued: 0, skipped: 2 });
    expect(second).toMatchObject({ discovered: 0, queued: 0, skipped: 0 });
    expect(reddit.getSubredditByName).toHaveBeenCalledTimes(2);
  });

  it("does not change enabled state or fetch when the gate read fails", async () => {
    const redis = new FakeRedis();
    await redis.set("invite_new_subs:gate_state:v1", "enabled");
    const reddit = wikiReddit();
    reddit.getWikiPage.mockRejectedValue(new Error("wiki unavailable"));
    const fetchClient = listingFetch("Ignored");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const result = await processInviteNewSubsPoll({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler: { runJob: vi.fn() },
      subredditName: "subscriber_goal_dev",
      fetchClient,
    });

    expect(result.status).toBe("gate_unavailable");
    expect(fetchClient).not.toHaveBeenCalled();
    expect(redis.values.get("invite_new_subs:gate_state:v1")).toBe("enabled");
    expect(diagnosticPayload(info, "invite_new_subs_disabled")).toBeUndefined();
  });

  it("treats a malformed gate response as unavailable, not disabled", async () => {
    const redis = new FakeRedis();
    await redis.set("invite_new_subs:gate_state:v1", "enabled");
    const reddit = wikiReddit();
    reddit.getWikiPage.mockResolvedValueOnce({
      content: undefined,
      wikiVersion: "v2",
      revisionId: "33333333-3333-3333-3333-333333333333",
      revisionDate: new Date("2026-10-22T11:55:00.000Z"),
    } as never);
    const fetchClient = listingFetch("Ignored");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const result = await processInviteNewSubsPoll({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler: { runJob: vi.fn() },
      subredditName: inviteNewSubsHostSubreddit,
      fetchClient,
    });

    expect(result.status).toBe("gate_unavailable");
    expect(fetchClient).not.toHaveBeenCalled();
    expect(redis.values.get("invite_new_subs:gate_state:v1")).toBe("enabled");
    expect(diagnosticPayload(info, "invite_new_subs_disabled")).toBeUndefined();
  });

  it("aborts before discovery when the message template is empty", async () => {
    const redis = new FakeRedis();
    const fetchClient = listingFetch("Ignored");

    const result = await processInviteNewSubsPoll({
      reddit: wikiReddit("enabled", "   ") as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler: { runJob: vi.fn() },
      subredditName: "subscriber_goal_dev",
      fetchClient,
    });

    expect(result.status).toBe("template_unavailable");
    expect(fetchClient).not.toHaveBeenCalled();
  });

  it("records a missing moderator and a scheduling failure as terminal", async () => {
    const redis = new FakeRedis();
    const reddit = wikiReddit();
    const runJob = vi
      .fn()
      .mockRejectedValue(new Error("scheduler unavailable"));
    await processInviteNewSubsPoll({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler: { runJob },
      subredditName: "subscriber_goal_dev",
      fetchClient: listingFetch("Existing"),
    });
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

    const first = await processInviteNewSubsPoll({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler: { runJob },
      subredditName: "subscriber_goal_dev",
      fetchClient: listingFetch("ScheduleFails", "NoMods", "Existing"),
    });
    const second = await processInviteNewSubsPoll({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler: { runJob },
      subredditName: "subscriber_goal_dev",
      fetchClient: listingFetch("ScheduleFails", "NoMods", "Existing"),
    });

    expect(first).toMatchObject({ discovered: 2, queued: 0, skipped: 2 });
    expect(second).toMatchObject({ discovered: 0, queued: 0, skipped: 0 });
    expect(runJob).toHaveBeenCalledOnce();
  });

  it("does not misclassify or requeue a job when queued-state persistence fails", async () => {
    const redis = new FakeRedis();
    const reddit = wikiReddit();
    const runJob = vi.fn().mockResolvedValue("job-id");
    await processInviteNewSubsPoll({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler: { runJob },
      subredditName: "subscriber_goal_dev",
      fetchClient: listingFetch("Existing"),
    });
    reddit.getSubredditByName.mockImplementation(async (name: string) => ({
      name,
      type: "public",
      nsfw: false,
    }));
    reddit.getModerators.mockReturnValue({
      get: vi.fn().mockResolvedValue([{ username: "Owner" }]),
    });
    redis.failNextRecordStatus = "queued";

    await expect(
      processInviteNewSubsPoll({
        reddit: reddit as unknown as RedditClient,
        redis: asRedis(redis),
        scheduler: { runJob },
        subredditName: "subscriber_goal_dev",
        fetchClient: listingFetch("NewCommunity", "Existing"),
      }),
    ).rejects.toThrow("failed to store queued state");

    const retry = await processInviteNewSubsPoll({
      reddit: reddit as unknown as RedditClient,
      redis: asRedis(redis),
      scheduler: { runJob },
      subredditName: "subscriber_goal_dev",
      fetchClient: listingFetch("NewCommunity", "Existing"),
    });
    expect(retry).toMatchObject({ discovered: 0, queued: 0, skipped: 0 });
    expect(runJob).toHaveBeenCalledOnce();
    expect(
      [...redis.values.values()].some((value) =>
        value.includes('"status":"schedule_failed"'),
      ),
    ).toBe(false);
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
  const job = {
    subredditName: "NewCommunity",
    topModerator: "FoundingMod",
    isNsfw: false,
    renderedMessage: "Detected r/NewCommunity for u/FoundingMod.",
  };

  it("sends to the fixed test recipient only once", async () => {
    const redis = new FakeRedis();
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
      to: inviteNewSubsRecipient,
      subject: inviteNewSubsSubject,
      text: job.renderedMessage,
    });
  });

  it("records a failed DM and never retries it", async () => {
    const redis = new FakeRedis();
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
