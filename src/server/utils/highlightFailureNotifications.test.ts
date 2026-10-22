import { describe, expect, it, vi } from "vitest";
import type { LinkId } from "../types";
import type { HighlightResult } from "./communityHighlights";
import {
  clearActiveHighlightFailureIncident,
  clearHighlightFailureIncident,
  notifyHighlightFailure,
  notifyHighlightFailureIncident,
} from "./highlightFailureNotifications";

class IncidentRedis {
  values = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  expirations = new Map<string, number>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(
    key: string,
    value: string,
    options?: { nx?: boolean },
  ): Promise<void> {
    if (options?.nx && this.values.has(key)) return;
    this.values.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
    this.hashes.delete(key);
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async hSet(key: string, values: Record<string, string>): Promise<void> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, value] of Object.entries(values)) hash.set(field, value);
    this.hashes.set(key, hash);
  }

  async expire(key: string, seconds: number): Promise<void> {
    this.expirations.set(key, seconds);
  }
}

function result(
  postId: LinkId,
  category: "cleanup" | "reorder" = "cleanup",
): HighlightResult {
  return {
    status: "highlighted",
    selectedPostId: postId,
    verifiedHighlighted: true,
    failureCategory: category,
    errorMessage: `${category} failed`,
    issues: [{ category, message: `${category} failed`, postId }],
    capacityOutcome: "slot_available",
    cleanupOutcome: category === "cleanup" ? "failed" : "completed",
    removedManagedHighlightIds: [],
    preservedHighlightIds: [],
    rollbackOutcome: "not_needed",
    reorderOutcome: category === "reorder" ? "failed" : "reordered",
  };
}

function reddit(notification = vi.fn().mockResolvedValue(undefined)) {
  return {
    modMail: { createModNotification: notification },
    sendPrivateMessage: vi.fn().mockResolvedValue(undefined),
  };
}

const baseNotification = {
  subredditId: "t5_example" as const,
  subredditName: "ExampleSub",
  postTitle: "Subscriber Goal",
};

describe("highlight failure notifications", () => {
  it("passes degraded result details into moderator messages", async () => {
    const createModNotification = vi.fn().mockResolvedValue(undefined);
    const client = reddit(createModNotification);

    await notifyHighlightFailure({
      reddit: client as never,
      ...baseNotification,
      highlightResult: result("t3_goal"),
    });

    expect(createModNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("Needs Attention"),
        bodyMarkdown: expect.stringContaining(
          "obsolete classic Subscriber Goal highlight could not be removed",
        ),
      }),
    );
  });

  it("deduplicates a delivered incident and expires its Redis record", async () => {
    const redis = new IncidentRedis();
    const client = reddit();
    const incident = result("t3_goal");
    const params = {
      redis: redis as never,
      reddit: client as never,
      postId: "t3_goal" as const,
      result: incident,
      ...baseNotification,
      nowMs: 1_000,
    };

    await expect(notifyHighlightFailureIncident(params)).resolves.toBe("sent");
    await expect(
      notifyHighlightFailureIncident({ ...params, nowMs: 2_000 }),
    ).resolves.toBe("skipped_duplicate");

    expect(client.modMail.createModNotification).toHaveBeenCalledOnce();
    expect(redis.expirations.get("highlight_failure_incident_v1:t3_goal")).toBe(
      30 * 24 * 60 * 60,
    );
  });

  it("retries failed delivery after backoff and alerts for a changed signature", async () => {
    const redis = new IncidentRedis();
    const createModNotification = vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue(undefined);
    const client = reddit(createModNotification);
    const params = {
      redis: redis as never,
      reddit: client as never,
      postId: "t3_goal" as const,
      result: result("t3_goal"),
      ...baseNotification,
      nowMs: 1_000,
    };

    await expect(notifyHighlightFailureIncident(params)).resolves.toBe(
      "failed",
    );
    await expect(
      notifyHighlightFailureIncident({ ...params, nowMs: 2_000 }),
    ).resolves.toBe("skipped_duplicate");
    await expect(
      notifyHighlightFailureIncident({ ...params, nowMs: 3_602_000 }),
    ).resolves.toBe("sent");
    await expect(
      notifyHighlightFailureIncident({
        ...params,
        result: result("t3_goal", "reorder"),
        nowMs: 3_603_000,
      }),
    ).resolves.toBe("sent");
    expect(createModNotification).toHaveBeenCalledTimes(3);
  });

  it("clears replaced and resolved active incidents", async () => {
    const redis = new IncidentRedis();
    const client = reddit();
    await notifyHighlightFailureIncident({
      redis: redis as never,
      reddit: client as never,
      postId: "t3_old" as const,
      result: result("t3_old"),
      ...baseNotification,
      nowMs: 1_000,
    });
    await notifyHighlightFailureIncident({
      redis: redis as never,
      reddit: client as never,
      postId: "t3_new" as const,
      result: result("t3_new"),
      ...baseNotification,
      nowMs: 2_000,
    });

    expect(redis.hashes.has("highlight_failure_incident_v1:t3_old")).toBe(
      false,
    );
    await clearHighlightFailureIncident(redis as never, "t3_new");
    expect(redis.hashes.has("highlight_failure_incident_v1:t3_new")).toBe(
      false,
    );

    await notifyHighlightFailureIncident({
      redis: redis as never,
      reddit: client as never,
      postId: "t3_completed" as const,
      result: result("t3_completed"),
      ...baseNotification,
      nowMs: 3_000,
    });
    await clearActiveHighlightFailureIncident(redis as never);
    expect(redis.hashes.has("highlight_failure_incident_v1:t3_completed")).toBe(
      false,
    );
  });
});
