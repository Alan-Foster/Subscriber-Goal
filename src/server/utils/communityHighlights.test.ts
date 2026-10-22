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
  it("highlights a target, moves it first, and preserves relative order", async () => {
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
      reorderOutcome: "reordered",
    });
    expect(harness.getIds()).toEqual(["t3_target", "t3_a", "t3_b"]);
    expect(harness.target.highlight).toHaveBeenCalledWith();
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
      "t3_target",
      "t3_other1",
      "t3_other2",
      "t3_other3",
      "t3_other4",
      "t3_other5",
    ]);
  });

  it("restores a removed managed highlight and its order when replacement fails", async () => {
    const ids = [
      "t3_oldgoal",
      "t3_other1",
      "t3_other2",
      "t3_other3",
      "t3_other4",
      "t3_other5",
    ];
    const harness = createHarness(ids);
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
    expect(harness.getIds()).toEqual(ids);
  });

  it("refetches and retries once when reordering races with another moderator", async () => {
    const harness = createHarness(["t3_a"]);
    harness.subreddit.reorderHighlightedPosts
      .mockRejectedValueOnce(new Error("order changed"))
      .mockImplementationOnce(async (order) => {
        const ids = [...order];
        const current = harness.getIds();
        current.splice(0, current.length, ...ids);
      });

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      harness.target,
      verification,
    );

    expect(result.reorderOutcome).toBe("reordered");
    expect(harness.subreddit.reorderHighlightedPosts).toHaveBeenCalledTimes(2);
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
    expect(harness.getIds()).toEqual(["t3_target", "t3_b"]);
  });

  it("rolls back a plausible concurrent seventh-post eviction", async () => {
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
    expect(harness.getIds()).toEqual([...original, "t3_moderator"]);
  });

  it("reports the final state when the target disappears during reordering", async () => {
    const harness = createHarness(["t3_a"]);
    harness.subreddit.reorderHighlightedPosts.mockImplementation(async () => {
      const ids = harness.getIds();
      ids.splice(ids.indexOf("t3_target"), 1);
    });

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      harness.target,
      verification,
    );

    expect(result).toMatchObject({
      status: "not_highlighted",
      verifiedHighlighted: false,
      reorderOutcome: "failed",
    });
    expect(result.issues.map(({ category }) => category)).toEqual(
      expect.arrayContaining(["reorder", "concurrency"]),
    );
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

  it("moves an already-highlighted target first", async () => {
    const harness = createHarness(["t3_a", "t3_target", "t3_b"]);

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      harness.target,
      verification,
    );

    expect(result).toMatchObject({
      status: "highlighted",
      reorderOutcome: "reordered",
      issues: [],
    });
    expect(harness.target.highlight).not.toHaveBeenCalled();
    expect(harness.getIds()).toEqual(["t3_target", "t3_a", "t3_b"]);
  });

  it("reports reorder failure when Reddit never applies the requested order", async () => {
    const harness = createHarness(["t3_a", "t3_target"]);
    harness.subreddit.reorderHighlightedPosts.mockImplementation(
      async () => undefined,
    );

    const result = await highlightAndVerifyPost(
      harness.reddit as never,
      harness.subreddit,
      harness.target,
      verification,
    );

    expect(result).toMatchObject({
      status: "highlighted",
      reorderOutcome: "failed",
      failureCategory: "reorder",
    });
    expect(harness.subreddit.reorderHighlightedPosts).toHaveBeenCalledTimes(2);
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
