import { describe, expect, it, vi } from "vitest";
import {
  communityHighlightLimit,
  highlightAndVerifyPost,
} from "./communityHighlights";

const verification = { maxWaitMs: 0, intervalMs: 0 };

function createHarness(initialIds: string[]) {
  let ids = [...initialIds];
  const makePost = (id: string) => ({
    id,
    highlight: vi.fn(async () => {
      if (!ids.includes(id)) ids.push(id);
    }),
    unhighlight: vi.fn(async () => {
      ids = ids.filter((value) => value !== id);
    }),
    isHighlighted: vi.fn(async () => ids.includes(id)),
  });
  const posts = new Map<string, ReturnType<typeof makePost>>();
  for (const id of initialIds) posts.set(id, makePost(id));
  const target = makePost("t3_target");
  posts.set(target.id, target);
  const subreddit = {
    name: "ExampleSub",
    getHighlightedPosts: vi.fn(async () =>
      ids.map((postId) => ({ postId: postId as `t3_${string}` })),
    ),
    reorderHighlightedPosts: vi.fn(async (order: readonly `t3_${string}`[]) => {
      ids = [...order];
    }),
  };
  const reddit = {
    getPostById: vi.fn(async (id: string) => posts.get(id)),
  };
  return { reddit, subreddit, target, posts, getIds: () => ids };
}

describe("Community Highlights manager", () => {
  it("verifies a new highlight in the position Reddit assigns it", async () => {
    const harness = createHarness(["t3_a", "t3_b"]);

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      harness.target,
      verification,
    );

    expect(result).toMatchObject({
      status: "highlighted",
      verifiedHighlighted: true,
      selectedPosition: 2,
    });
    expect(harness.getIds()).toEqual(["t3_a", "t3_b", "t3_target"]);
    expect(harness.target.highlight).toHaveBeenCalledWith();
    expect(harness.subreddit.reorderHighlightedPosts).not.toHaveBeenCalled();
  });

  it("does not attempt a seventh highlight when no managed slot is removable", async () => {
    const ids = Array.from(
      { length: communityHighlightLimit },
      (_, index) => `t3_other${index}`,
    );
    const harness = createHarness(ids);

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      harness.target,
      verification,
    );

    expect(result).toMatchObject({
      status: "not_highlighted",
      failureCategory: "capacity",
    });
    expect(harness.target.highlight).not.toHaveBeenCalled();
    expect(harness.getIds()).toEqual(ids);
  });

  it("replaces only an explicitly managed highlight when all slots are full", async () => {
    const ids = [
      "t3_oldgoal",
      "t3_other1",
      "t3_other2",
      "t3_other3",
      "t3_other4",
      "t3_other5",
    ];
    const harness = createHarness(ids);

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      harness.target,
      { ...verification, removableManagedPostIds: ["t3_oldgoal"] },
    );

    expect(result.removedManagedHighlightIds).toEqual(["t3_oldgoal"]);
    expect(harness.posts.get("t3_oldgoal")?.unhighlight).toHaveBeenCalledOnce();
    expect(harness.getIds()).toEqual([
      "t3_other1",
      "t3_other2",
      "t3_other3",
      "t3_other4",
      "t3_other5",
      "t3_target",
    ]);
  });

  it("restores a removed managed highlight with its metadata in a different slot", async () => {
    const ids = [
      "t3_oldgoal",
      "t3_other1",
      "t3_other2",
      "t3_other3",
      "t3_other4",
      "t3_other5",
    ];
    const harness = createHarness(ids);
    const expiration = new Date(Date.now() + 60 * 60 * 1000);
    harness.subreddit.getHighlightedPosts.mockImplementation(async () =>
      harness.getIds().map((postId) => ({
        postId: postId as `t3_${string}`,
        ...(postId === "t3_oldgoal"
          ? {
              highlightLabel: "EVENT" as const,
              highlightedUntil: expiration,
            }
          : {}),
      })),
    );
    harness.target.highlight.mockRejectedValueOnce(new Error("write failed"));

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      harness.target,
      { ...verification, removableManagedPostIds: ["t3_oldgoal"] },
    );

    expect(result).toMatchObject({
      status: "not_highlighted",
      failureCategory: "write",
      rollbackOutcome: "restored",
    });
    expect(harness.getIds()).toEqual([...ids.slice(1), "t3_oldgoal"]);
    expect(harness.posts.get("t3_oldgoal")?.highlight).toHaveBeenCalledWith({
      highlightUntil: expiration,
      highlightLabelType: "EVENT",
    });
    expect(harness.subreddit.reorderHighlightedPosts).not.toHaveBeenCalled();
  });

  it("restores the displaced app pin when a listed replacement cannot be independently verified", async () => {
    const ids = [
      "t3_old_tiny",
      "t3_other1",
      "t3_other2",
      "t3_other3",
      "t3_other4",
      "t3_other5",
    ];
    const harness = createHarness(ids);
    harness.target.isHighlighted.mockResolvedValue(false);

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      harness.target,
      {
        ...verification,
        removableManagedPostIds: ["t3_old_tiny"],
        rollbackUnverifiedReplacement: true,
      },
    );

    expect(result).toMatchObject({
      status: "not_highlighted",
      verifiedHighlighted: false,
      failureCategory: "verification",
      rollbackOutcome: "restored",
    });
    expect(harness.target.unhighlight).toHaveBeenCalledOnce();
    expect(harness.getIds()).toEqual([...ids.slice(1), "t3_old_tiny"]);
    for (const id of ids.slice(1)) {
      expect(harness.posts.get(id)?.unhighlight).not.toHaveBeenCalled();
    }
  });

  it("does not restore a managed highlight whose expiration passed during rollback", async () => {
    const ids = [
      "t3_oldgoal",
      "t3_other1",
      "t3_other2",
      "t3_other3",
      "t3_other4",
      "t3_other5",
    ];
    const harness = createHarness(ids);
    const expiration = new Date(Date.now() - 1_000);
    harness.subreddit.getHighlightedPosts.mockImplementation(async () =>
      harness.getIds().map((postId) => ({
        postId: postId as `t3_${string}`,
        ...(postId === "t3_oldgoal" ? { highlightedUntil: expiration } : {}),
      })),
    );
    harness.target.highlight.mockRejectedValueOnce(new Error("write failed"));

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      harness.target,
      { ...verification, removableManagedPostIds: ["t3_oldgoal"] },
    );

    expect(result.rollbackOutcome).toBe("expired");
    expect(harness.posts.get("t3_oldgoal")?.highlight).not.toHaveBeenCalled();
  });

  it("leaves existing highlight metadata alone", async () => {
    const harness = createHarness(["t3_a", "t3_target"]);
    const expiration = new Date(Date.now() + 60 * 60 * 1000);
    harness.subreddit.getHighlightedPosts.mockImplementation(async () =>
      harness.getIds().map((postId) => ({
        postId: postId as `t3_${string}`,
        ...(postId === "t3_target"
          ? {
              highlightLabel: "MEGATHREAD" as const,
              highlightedUntil: expiration,
            }
          : {}),
      })),
    );

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      harness.target,
      verification,
    );

    expect(result).toMatchObject({
      status: "highlighted",
      issues: [],
    });
    expect(harness.target.highlight).not.toHaveBeenCalled();
    expect(harness.subreddit.reorderHighlightedPosts).not.toHaveBeenCalled();
  });

  it("does not highlight when a full-capacity removal is a silent no-op", async () => {
    const ids = [
      "t3_oldgoal",
      "t3_other1",
      "t3_other2",
      "t3_other3",
      "t3_other4",
      "t3_other5",
    ];
    const harness = createHarness(ids);
    harness.posts
      .get("t3_oldgoal")!
      .unhighlight.mockImplementationOnce(async () => undefined);

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      harness.target,
      { ...verification, removableManagedPostIds: ["t3_oldgoal"] },
    );

    expect(result).toMatchObject({
      status: "not_highlighted",
      failureCategory: "cleanup",
      cleanupOutcome: "failed",
    });
    expect(harness.target.highlight).not.toHaveBeenCalled();
    expect(harness.getIds()).toEqual(ids);
  });

  it("refuses the write when capacity changes from five to six", async () => {
    const harness = createHarness([
      "t3_other1",
      "t3_other2",
      "t3_other3",
      "t3_other4",
      "t3_other5",
    ]);
    let snapshots = 0;
    harness.subreddit.getHighlightedPosts.mockImplementation(async () => {
      snapshots += 1;
      if (snapshots === 3) harness.getIds().push("t3_moderator");
      return harness
        .getIds()
        .map((postId) => ({ postId: postId as `t3_${string}` }));
    });

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      harness.target,
      verification,
    );

    expect(result).toMatchObject({
      status: "not_highlighted",
      capacityOutcome: "concurrent_change",
      failureCategory: "concurrency",
    });
    expect(harness.target.highlight).not.toHaveBeenCalled();
  });

  it("does not undo a moderator removal when capacity was below five", async () => {
    const harness = createHarness(["t3_a", "t3_b"]);
    harness.target.highlight.mockImplementationOnce(async () => {
      const ids = harness.getIds();
      ids.splice(ids.indexOf("t3_a"), 1);
      ids.push("t3_target");
    });

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      harness.target,
      verification,
    );

    expect(result).toMatchObject({
      status: "highlighted",
      rollbackOutcome: "not_needed",
    });
    expect(harness.getIds()).toEqual(["t3_b", "t3_target"]);
  });

  it("rolls back when a concurrent sixth highlight makes the app write seventh", async () => {
    const original = ["t3_a", "t3_b", "t3_c", "t3_d", "t3_e"];
    const harness = createHarness(original);
    harness.target.highlight.mockImplementationOnce(async () => {
      const ids = harness.getIds();
      ids.splice(ids.indexOf("t3_a"), 1);
      ids.push("t3_moderator", "t3_target");
    });

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      harness.target,
      verification,
    );

    expect(result).toMatchObject({
      status: "not_highlighted",
      capacityOutcome: "concurrent_change",
      rollbackOutcome: "restored",
    });
    expect(result.issues.map(({ category }) => category)).toContain(
      "concurrency",
    );
    expect(harness.getIds()).toEqual([
      "t3_b",
      "t3_c",
      "t3_d",
      "t3_e",
      "t3_moderator",
      "t3_a",
    ]);
    expect(harness.subreddit.reorderHighlightedPosts).not.toHaveBeenCalled();
  });

  it("reports the final state when the target disappears during cleanup", async () => {
    const harness = createHarness(["t3_oldgoal", "t3_target"]);
    harness.posts
      .get("t3_oldgoal")
      ?.unhighlight.mockImplementationOnce(async () => {
        const ids = harness.getIds();
        ids.splice(0, ids.length);
      });

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      harness.target,
      { ...verification, removableManagedPostIds: ["t3_oldgoal"] },
    );

    expect(result).toMatchObject({
      status: "not_highlighted",
      verifiedHighlighted: false,
    });
    expect(result.failureCategory).toBe("concurrency");
  });

  it("does not mutate highlights when isHighlighted is unavailable", async () => {
    const harness = createHarness(["t3_a"]);
    const targetWithoutVerification = {
      id: harness.target.id,
      highlight: harness.target.highlight,
      unhighlight: harness.target.unhighlight,
    };

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      targetWithoutVerification,
      verification,
    );

    expect(result).toMatchObject({
      status: "not_highlighted",
      verifiedHighlighted: false,
      failureCategory: "verification",
    });
    expect(harness.target.highlight).not.toHaveBeenCalled();
    expect(harness.target.unhighlight).not.toHaveBeenCalled();
  });

  it("reports degraded cleanup when an obsolete removal is not confirmed", async () => {
    const harness = createHarness(["t3_target", "t3_oldgoal"]);
    harness.posts
      .get("t3_oldgoal")!
      .unhighlight.mockImplementationOnce(async () => undefined);

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      harness.target,
      { ...verification, removableManagedPostIds: ["t3_oldgoal"] },
    );

    expect(result).toMatchObject({
      status: "highlighted",
      cleanupOutcome: "failed",
      failureCategory: "cleanup",
    });
    expect(result.removedManagedHighlightIds).toEqual([]);
    expect(harness.getIds()).toContain("t3_oldgoal");
  });

  it("leaves an already-highlighted goal in place behind a scheduled Sticky", async () => {
    const harness = createHarness(["t3_scheduled", "t3_target", "t3_b"]);

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      harness.target,
      verification,
    );

    expect(result).toMatchObject({
      status: "highlighted",
      selectedPosition: 1,
      issues: [],
    });
    expect(harness.target.highlight).not.toHaveBeenCalled();
    expect(harness.getIds()).toEqual(["t3_scheduled", "t3_target", "t3_b"]);
    expect(harness.subreddit.reorderHighlightedPosts).not.toHaveBeenCalled();
  });

  it("retains both the triggering issue and a rollback failure", async () => {
    const ids = [
      "t3_oldgoal",
      "t3_other1",
      "t3_other2",
      "t3_other3",
      "t3_other4",
      "t3_other5",
    ];
    const harness = createHarness(ids);
    harness.target.highlight.mockImplementationOnce(async () => {
      harness.getIds().push("t3_moderator");
      throw new Error("write failed");
    });

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      harness.target,
      { ...verification, removableManagedPostIds: ["t3_oldgoal"] },
    );

    expect(result.issues.map(({ category }) => category)).toEqual([
      "write",
      "rollback",
    ]);
    expect(result).toMatchObject({
      status: "not_highlighted",
      failureCategory: "write",
      rollbackOutcome: "failed",
    });
  });
});
