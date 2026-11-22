import { watchTestHash, watchTestString } from "./testHashWatch";

export class InMemoryRedis {
  async watch(key: string) {
    return (await this.get(key)) === undefined
      ? watchTestHash(this, key)
      : watchTestString(this, key);
  }

  hashes = new Map<string, Map<string, string>>();
  values = new Map<string, string>();
  sortedSets = new Map<string, Map<string, number>>();
  failWorkflowWrite = false;

  async set(
    key: string,
    value: string,
    options?: { nx?: boolean },
  ): Promise<void> {
    if (options?.nx && this.values.has(key)) return;
    this.values.set(key, value);
  }

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
    this.hashes.delete(key);
  }

  async expire(): Promise<void> {}

  async hGetAll(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hashes.get(key)?.get(field);
  }

  async hDel(key: string, fields: string[]): Promise<void> {
    const hash = this.hashes.get(key);
    for (const field of fields) hash?.delete(field);
  }

  async hSet(key: string, values: Record<string, string>): Promise<void> {
    if (values.warningState !== undefined && this.failWorkflowWrite) {
      throw new Error("workflow write failed");
    }
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, value] of Object.entries(values)) hash.set(field, value);
    this.hashes.set(key, hash);
  }

  async hIncrBy(
    key: string,
    field: string,
    increment: number,
  ): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    const value = Number(hash.get(field) ?? 0) + increment;
    hash.set(field, String(value));
    this.hashes.set(key, hash);
    return value;
  }

  async zRange(key: string): Promise<{ member: string; score: number }[]> {
    return [...(this.sortedSets.get(key) ?? [])]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score);
  }

  async zAdd(
    key: string,
    entry: { member: string; score: number },
  ): Promise<void> {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    set.set(entry.member, entry.score);
    this.sortedSets.set(key, set);
  }

  async zScore(key: string, member: string): Promise<number | undefined> {
    return this.sortedSets.get(key)?.get(member);
  }

  async zRem(key: string, members: string[]): Promise<void> {
    const set = this.sortedSets.get(key);
    for (const member of members) set?.delete(member);
  }

  async hScan(key: string): Promise<{
    cursor: number;
    fieldValues: { field: string; value: string }[];
  }> {
    return {
      cursor: 0,
      fieldValues: [...(this.hashes.get(key) ?? [])].map(([field, value]) => ({
        field,
        value,
      })),
    };
  }

  async hMGet(key: string, fields: string[]): Promise<(string | undefined)[]> {
    return fields.map((field) => this.hashes.get(key)?.get(field));
  }
}

export const nowMs = Date.parse("2026-09-17T12:00:00.000Z");

export async function seedGoalData(
  redis: InMemoryRedis,
  postId: string,
  {
    goal,
    completedTime = 0,
    autoCreateNextGoal = true,
  }: {
    goal: number;
    completedTime?: number;
    autoCreateNextGoal?: boolean | null;
  },
): Promise<void> {
  await redis.hSet("subscriber_goals", {
    [`${postId}_post_kind`]: "subscriber-goal-v1",
    [`${postId}_post_height`]: "regular",
    [`${postId}_goal`]: String(goal),
    [`${postId}_completed_time`]: String(completedTime),
    ...(autoCreateNextGoal === null
      ? {}
      : {
          [`${postId}_auto_create_next_goal`]: String(autoCreateNextGoal),
        }),
    [`${postId}_subreddit_display_name`]: "ExampleSub",
    [`${postId}_language`]: "en",
    [`${postId}_color_theme`]: "blue",
  });
}
