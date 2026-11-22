/**
 * In-memory Redis and Reddit fakes with scripted fault injection.
 *
 * The fakes keep real state (strings with expiry, hashes, sorted sets, posts,
 * post data), so production modules can run against them unmodified. Faults
 * are matched per call and either throw before the call takes effect or let
 * the call commit and then throw, which models "Reddit accepted the request
 * but the response was lost".
 *
 * Any method a test path touches that the fake does not implement throws a
 * descriptive error instead of silently returning undefined.
 */

export type FaultMode = "throw" | "commit-then-throw" | "pause";

/**
 * A gate that pauses a faked call until the test releases it. `reached`
 * resolves when the paused call arrives, so a test can run a competing
 * operation at exactly that point.
 */
export class Gate {
  private reachedResolve!: () => void;
  private releaseResolve!: () => void;
  readonly reached = new Promise<void>((resolve) => {
    this.reachedResolve = resolve;
  });
  readonly released = new Promise<void>((resolve) => {
    this.releaseResolve = resolve;
  });
  arrive(): void {
    this.reachedResolve();
  }
  release(): void {
    this.releaseResolve();
  }
}

export type FaultSpec = {
  target: "redis" | "reddit";
  method: string;
  match?: (args: unknown[]) => boolean;
  mode?: FaultMode;
  times?: number;
  error?: Error;
  /** Required for `pause`; when to pause relative to the call. */
  gate?: Gate;
  pauseAfter?: boolean;
};

type ActiveFault = Required<
  Omit<FaultSpec, "match" | "error" | "gate" | "pauseAfter">
> & {
  match?: (args: unknown[]) => boolean;
  error: Error;
  hits: number;
  gate?: Gate;
  pauseAfter: boolean;
};

export class FaultPlan {
  private faults: ActiveFault[] = [];
  readonly log: Array<{ target: string; method: string; args: unknown[] }> = [];

  add(spec: FaultSpec): void {
    this.faults.push({
      target: spec.target,
      method: spec.method,
      mode: spec.mode ?? "throw",
      times: spec.times ?? 1,
      error:
        spec.error ?? new Error(`injected ${spec.target}.${spec.method} fault`),
      hits: 0,
      pauseAfter: spec.pauseAfter ?? false,
      ...(spec.match ? { match: spec.match } : {}),
      ...(spec.gate ? { gate: spec.gate } : {}),
    });
  }

  clear(): void {
    this.faults = [];
    this.log.length = 0;
  }

  /** Returns the fault to apply to this call, consuming one use of it. */
  take(target: string, method: string, args: unknown[]): ActiveFault | null {
    this.log.push({ target, method, args });
    const fault = this.faults.find(
      (f) =>
        f.target === target &&
        f.method === method &&
        f.hits < f.times &&
        (!f.match || f.match(args)),
    );
    if (!fault) return null;
    fault.hits += 1;
    return fault;
  }

  calls(target: string, method: string): unknown[][] {
    return this.log
      .filter((entry) => entry.target === target && entry.method === method)
      .map((entry) => entry.args);
  }
}

/** Methods the real clients expose synchronously (they return a listing). */
const synchronousMethods = new Set(["getNewPosts", "searchPosts", "addPost"]);

function withFaults<T extends object>(
  target: "redis" | "reddit",
  impl: T,
  plan: FaultPlan,
): T {
  return new Proxy(impl, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof property !== "string") return value;
      if (typeof value !== "function") {
        if (value === undefined && !property.startsWith("_")) {
          // `then` is probed by `await`; everything else is a missing fake.
          if (property === "then" || property === "toJSON") return undefined;
          return (..._args: unknown[]) => {
            throw new Error(`fake ${target} does not implement ${property}()`);
          };
        }
        return value;
      }
      if (synchronousMethods.has(property)) {
        return (...args: unknown[]) => {
          const fault = plan.take(target, property, args);
          if (fault && fault.mode !== "pause") throw fault.error;
          const result = (value as (...a: unknown[]) => unknown).apply(
            object,
            args,
          );
          if (!fault) return result;
          // Listings are consumed through `.all()`; pause there.
          const listing = result as { all: () => Promise<unknown> };
          return {
            ...listing,
            all: async () => {
              fault.gate!.arrive();
              await fault.gate!.released;
              return listing.all();
            },
          };
        };
      }
      return async (...args: unknown[]) => {
        const fault = plan.take(target, property, args);
        if (fault?.mode === "throw") throw fault.error;
        const pause = async () => {
          fault!.gate!.arrive();
          await fault!.gate!.released;
        };
        if (fault?.mode === "pause" && !fault.pauseAfter) await pause();
        const result = await (value as (...a: unknown[]) => unknown).apply(
          object,
          args,
        );
        if (fault?.mode === "pause" && fault.pauseAfter) await pause();
        if (fault?.mode === "commit-then-throw") throw fault.error;
        return result;
      };
    },
  });
}

type ZEntry = { member: string; score: number };

export class FakeRedisImpl {
  strings = new Map<string, { value: string; expiresAt?: number }>();
  hashes = new Map<string, Map<string, string>>();
  zsets = new Map<string, Map<string, number>>();
  bitmaps = new Map<string, Uint8Array>();

  private live(key: string): { value: string } | undefined {
    const entry = this.strings.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.strings.delete(key);
      return undefined;
    }
    return entry;
  }

  private hash(key: string): Map<string, string> {
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    return hash;
  }

  private zset(key: string): Map<string, number> {
    let zset = this.zsets.get(key);
    if (!zset) {
      zset = new Map();
      this.zsets.set(key, zset);
    }
    return zset;
  }

  async get(key: string): Promise<string | undefined> {
    return this.live(key)?.value;
  }

  async set(
    key: string,
    value: string,
    options?: { nx?: boolean; expiration?: Date },
  ): Promise<string | null> {
    if (options?.nx && this.live(key)) return null;
    this.strings.set(key, {
      value,
      ...(options?.expiration
        ? { expiresAt: options.expiration.getTime() }
        : {}),
    });
    return "OK";
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys.flat()) {
      this.strings.delete(key);
      this.hashes.delete(key);
      this.zsets.delete(key);
      this.bitmaps.delete(key);
    }
  }

  /** Supports `get`/`set` on `u1` fields, Redis bit order (MSB first). */
  async bitfield(key: string, ...command: Array<string | number>) {
    const [op, type, rawOffset, value] = command;
    if (type !== "u1") throw new Error(`fake bitfield type ${String(type)}`);
    const expiresAt = this.bitmapExpiresAt.get(key);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      this.bitmaps.delete(key);
      this.bitmapExpiresAt.delete(key);
    }
    const offset = Number(rawOffset);
    const byteIndex = Math.floor(offset / 8);
    const mask = 0x80 >> (offset % 8);
    let bitmap = this.bitmaps.get(key) ?? new Uint8Array(0);
    if (bitmap.length <= byteIndex) {
      if (op === "get") return [0];
      const grown = new Uint8Array(byteIndex + 1);
      grown.set(bitmap);
      bitmap = grown;
      this.bitmaps.set(key, bitmap);
    }
    const previous = bitmap[byteIndex]! & mask ? 1 : 0;
    if (op === "set") {
      bitmap[byteIndex] = value
        ? bitmap[byteIndex]! | mask
        : bitmap[byteIndex]! & ~mask;
    } else if (op !== "get") {
      throw new Error(`fake bitfield op ${String(op)}`);
    }
    return [previous];
  }

  async getBuffer(key: string): Promise<Buffer | undefined> {
    const expiresAt = this.bitmapExpiresAt.get(key);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      this.bitmaps.delete(key);
      this.bitmapExpiresAt.delete(key);
    }
    const bitmap = this.bitmaps.get(key);
    return bitmap ? Buffer.from(bitmap) : undefined;
  }

  async exists(...keys: string[]): Promise<number> {
    return keys
      .flat()
      .filter((k) => this.live(k) || this.hashes.has(k) || this.zsets.has(k))
      .length;
  }

  bitmapExpiresAt = new Map<string, number>();

  async expire(key: string, seconds: number): Promise<void> {
    const entry = this.strings.get(key);
    if (entry) entry.expiresAt = Date.now() + seconds * 1000;
    if (this.bitmaps.has(key)) {
      this.bitmapExpiresAt.set(key, Date.now() + seconds * 1000);
    }
    // Hash expiry is recorded but not enforced; no test relies on it.
  }

  async incrBy(key: string, amount: number): Promise<number> {
    const next = (Number(this.live(key)?.value) || 0) + amount;
    this.strings.set(key, { value: String(next) });
    return next;
  }

  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hashes.get(key)?.get(field);
  }

  async hMGet(key: string, fields: string[]): Promise<(string | null)[]> {
    const hash = this.hashes.get(key);
    return fields.map((field) => hash?.get(field) ?? null);
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async hSet(key: string, fields: Record<string, string>): Promise<number> {
    const hash = this.hash(key);
    let added = 0;
    for (const [field, value] of Object.entries(fields)) {
      if (!hash.has(field)) added += 1;
      hash.set(field, String(value));
    }
    return added;
  }

  async hSetNX(key: string, field: string, value: string): Promise<number> {
    const hash = this.hash(key);
    if (hash.has(field)) return 0;
    hash.set(field, value);
    return 1;
  }

  async hDel(key: string, fields: string[]): Promise<number> {
    const hash = this.hashes.get(key);
    let removed = 0;
    for (const field of fields) if (hash?.delete(field)) removed += 1;
    return removed;
  }

  async hIncrBy(key: string, field: string, amount: number): Promise<number> {
    const hash = this.hash(key);
    const next = (Number(hash.get(field)) || 0) + amount;
    hash.set(field, String(next));
    return next;
  }

  async hKeys(key: string): Promise<string[]> {
    return [...(this.hashes.get(key)?.keys() ?? [])];
  }

  async hLen(key: string): Promise<number> {
    return this.hashes.get(key)?.size ?? 0;
  }

  async hScan(
    key: string,
    _cursor: number,
    _pattern?: string,
    _count?: number,
  ): Promise<{
    cursor: number;
    fieldValues: Array<{ field: string; value: string }>;
  }> {
    return {
      cursor: 0,
      fieldValues: [...(this.hashes.get(key) ?? [])].map(([field, value]) => ({
        field,
        value,
      })),
    };
  }

  async zAdd(key: string, ...entries: ZEntry[]): Promise<number> {
    const zset = this.zset(key);
    let added = 0;
    for (const { member, score } of entries.flat()) {
      if (!zset.has(member)) added += 1;
      zset.set(member, score);
    }
    return added;
  }

  async zRem(key: string, members: string[]): Promise<number> {
    const zset = this.zsets.get(key);
    let removed = 0;
    for (const member of members) if (zset?.delete(member)) removed += 1;
    return removed;
  }

  async zScore(key: string, member: string): Promise<number | undefined> {
    return this.zsets.get(key)?.get(member);
  }

  async zCard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0;
  }

  async zRange(
    key: string,
    start: number | string,
    stop: number | string,
    options?: {
      by?: "rank" | "score";
      reverse?: boolean;
      limit?: { offset: number; count: number };
    },
  ): Promise<ZEntry[]> {
    const all = [...(this.zsets.get(key) ?? [])]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    if (options?.by === "score") {
      const lo = start === "-inf" ? -Infinity : Number(start);
      const hi = stop === "+inf" ? Infinity : Number(stop);
      const ranged = all.filter((e) => e.score >= lo && e.score <= hi);
      const ordered = options.reverse ? ranged.reverse() : ranged;
      const { limit } = options;
      return limit
        ? ordered.slice(limit.offset, limit.offset + limit.count)
        : ordered;
    }
    const ordered = options?.reverse ? all.reverse() : all;
    const s = Number(start);
    const e = Number(stop);
    const end = e < 0 ? ordered.length + e + 1 : e + 1;
    return ordered.slice(s < 0 ? ordered.length + s : s, end);
  }

  /** Minimal optimistic transaction: commands queue and run on exec. */
  async watch(..._keys: string[]) {
    const queued: Array<() => Promise<unknown>> = [];
    return {
      multi: async () => {},
      del: async (...keys: string[]) => {
        queued.push(() => this.del(...keys));
      },
      hSet: async (key: string, fields: Record<string, string>) => {
        queued.push(() => this.hSet(key, fields));
      },
      hDel: async (key: string, fields: string[]) => {
        queued.push(() => this.hDel(key, fields));
      },
      zAdd: async (key: string, ...members: ZEntry[]) => {
        queued.push(() => this.zAdd(key, ...members));
      },
      zRem: async (key: string, members: string[]) => {
        queued.push(() => this.zRem(key, members));
      },
      async exec() {
        const results = [];
        for (const run of queued) results.push(await run());
        return results;
      },
      async discard() {
        queued.length = 0;
      },
      async unwatch() {},
    };
  }
}

export type FakePost = {
  id: `t3_${string}`;
  title: string;
  subredditId: string;
  subredditName: string;
  authorName: string;
  createdAt: Date;
  permalink: string;
  url: string;
  removedByCategory?: string;
  archived?: boolean;
  postData: Record<string, unknown>;
  mergePostData: (data: Record<string, unknown>) => Promise<void>;
  approve: () => Promise<void>;
  setCustomPostStyles: (styles: unknown) => Promise<void>;
  isHighlighted: () => Promise<boolean>;
  highlight: (options?: {
    highlightUntil?: Date;
    highlightLabelType?: string;
  }) => Promise<void>;
  unhighlight: () => Promise<void>;
};

export type FakeHighlight = {
  postId: `t3_${string}`;
  highlightedUntil?: Date;
  highlightLabel?: string;
};

/** Reddit's Community Highlights limit. */
export const fakeHighlightLimit = 6;

export type FakeSubreddit = {
  id: string;
  name: string;
  numberOfSubscribers: number;
  type: string;
  nsfw: boolean;
  language: string;
};

export class FakeRedditImpl {
  readonly modmailNotifications: {
    subredditId: string;
    subject: string;
    bodyMarkdown: string;
  }[] = [];

  get modMail() {
    return withFaults(
      "reddit",
      {
        createModNotification: async (
          notification: (typeof this.modmailNotifications)[number],
        ) => {
          this.modmailNotifications.push(notification);
          return "onboarding-modmail";
        },
      },
      this.plan,
    );
  }

  posts = new Map<string, FakePost>();
  approvals: string[] = [];
  wikiUpdates: Array<{ subredditName: string; page: string; content: string }> =
    [];
  highlights: FakeHighlight[] = [];
  /** Posts hidden from getNewPosts, modelling listing lag. */
  hiddenFromListing = new Set<string>();
  private nextId = 1;

  constructor(
    public subreddit: FakeSubreddit,
    private readonly plan: FaultPlan,
  ) {}

  addPost(
    overrides: Partial<FakePost> & { postData?: Record<string, unknown> } = {},
  ): FakePost {
    const id = overrides.id ?? (`t3_p${this.nextId++}` as const);
    const post: FakePost = {
      id,
      title: overrides.title ?? "post",
      subredditId: this.subreddit.id,
      subredditName: this.subreddit.name,
      authorName: overrides.authorName ?? "subscriber-goal",
      createdAt: overrides.createdAt ?? new Date(Date.now()),
      permalink: `/r/${this.subreddit.name}/comments/${id.slice(3)}/`,
      url: `https://www.reddit.com/r/${this.subreddit.name}/comments/${id.slice(3)}/`,
      postData: overrides.postData ?? {},
      ...(overrides.removedByCategory
        ? { removedByCategory: overrides.removedByCategory }
        : {}),
      ...(overrides.archived ? { archived: true } : {}),
      mergePostData: async (data) => {
        const stored = this.posts.get(id)!;
        if (stored.archived) {
          throw new Error("This post is archived and cannot be modified.");
        }
        stored.postData = { ...stored.postData, ...data };
      },
      approve: async () => {
        this.approvals.push(id);
      },
      setCustomPostStyles: async () => {
        if (this.posts.get(id)?.archived) {
          throw new Error("This post is archived and cannot be modified.");
        }
      },
      isHighlighted: async () => this.highlights.some((h) => h.postId === id),
      highlight: async (options) => {
        if (this.highlights.some((h) => h.postId === id)) return;
        if (this.highlights.length >= fakeHighlightLimit) {
          throw new Error("Community Highlights are full");
        }
        this.highlights.push({
          postId: id,
          ...(options?.highlightUntil
            ? { highlightedUntil: options.highlightUntil }
            : {}),
          ...(options?.highlightLabelType
            ? { highlightLabel: options.highlightLabelType }
            : {}),
        });
      },
      unhighlight: async () => {
        this.highlights = this.highlights.filter((h) => h.postId !== id);
      },
    };
    // Post methods bypass the client proxy, so wrap highlight writes here.
    post.highlight = withFaults(
      "reddit",
      { highlight: post.highlight },
      this.plan,
    ).highlight;
    this.posts.set(id, post);
    return post;
  }

  async getCurrentSubreddit() {
    return {
      ...this.subreddit,
      getHighlightedPosts: async () => this.highlights.map((h) => ({ ...h })),
    };
  }

  async getAppUser() {
    return { id: "t2_app", username: "subscriber-goal" };
  }

  searchPosts(options: { query: string }) {
    const author = /author:(\S+)/.exec(options.query)?.[1]?.toLowerCase();
    const matches = [...this.posts.values()]
      .filter((post) => !author || post.authorName.toLowerCase() === author)
      .filter((post) => !this.hiddenFromListing.has(post.id))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { all: async () => matches.map((post) => ({ ...post })) };
  }

  async getSubredditInfoByName(): Promise<FakeSubreddit> {
    return { ...this.subreddit };
  }

  async submitCustomPost(options: {
    title: string;
    subredditName: string;
    postData?: Record<string, unknown>;
  }): Promise<FakePost> {
    return this.addPost({
      title: options.title,
      postData: { ...(options.postData ?? {}) },
    });
  }

  async getPostById(id: string): Promise<FakePost> {
    const post = this.posts.get(id);
    if (!post) throw new Error(`404 Not Found: post ${id} does not exist`);
    // Return a snapshot so later mutations of the stored post (e.g. deletion)
    // are only visible on the next read, as with the real API.
    return { ...post };
  }

  async getPostData(id: string): Promise<Record<string, unknown> | undefined> {
    return this.posts.get(id)?.postData;
  }

  getNewPosts(_options: { subredditName: string; limit?: number }) {
    const visible = [...this.posts.values()]
      .filter((post) => !this.hiddenFromListing.has(post.id))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { all: async () => visible.map((post) => ({ ...post })) };
  }

  async updateWikiPage(options: {
    subredditName: string;
    page: string;
    content: string;
  }): Promise<void> {
    this.wikiUpdates.push(options);
  }
}

export type FaultWorld = {
  plan: FaultPlan;
  redisImpl: FakeRedisImpl;
  redditImpl: FakeRedditImpl;
  redis: FakeRedisImpl;
  reddit: FakeRedditImpl;
};

export function createFaultWorld(
  subreddit: Partial<FakeSubreddit> = {},
): FaultWorld {
  const plan = new FaultPlan();
  const redisImpl = new FakeRedisImpl();
  const redditImpl = new FakeRedditImpl(
    {
      id: "t5_test",
      name: "testsub",
      numberOfSubscribers: 5_000,
      type: "public",
      nsfw: false,
      language: "en",
      ...subreddit,
    },
    plan,
  );
  return {
    plan,
    redisImpl,
    redditImpl,
    redis: withFaults("redis", redisImpl, plan),
    reddit: withFaults("reddit", redditImpl, plan),
  };
}

/** The world the `@devvit/web/server` mock delegates to in fault tests. */
export const activeFaultWorld: { current?: FaultWorld } = {};

export function devvitServerMock() {
  const world = (): FaultWorld => {
    if (!activeFaultWorld.current) throw new Error("no active fault world");
    return activeFaultWorld.current;
  };
  return {
    get reddit() {
      return world().reddit;
    },
    get redis() {
      return world().redis;
    },
    scheduler: {
      runJob: async () => "job",
      cancelJob: async () => {},
      listJobs: async () => [],
    },
    context: { subredditName: "testsub", subredditId: "t5_test" },
    cache: async <T>(fn: () => Promise<T>) => fn(),
    EntrypointHeight: { HEIGHT_UNSPECIFIED: 0, REGULAR: 1, TALL: 2 },
  };
}
