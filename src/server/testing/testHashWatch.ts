export async function watchTestString(
  redis: {
    get(key: string): Promise<string | undefined>;
    del(key: string): Promise<unknown>;
  },
  key: string,
) {
  const snapshot = await redis.get(key);
  let deleteKey: string | undefined;
  return {
    multi: async () => undefined,
    discard: async () => undefined,
    unwatch: async () => undefined,
    del: async (key: string) => {
      deleteKey = key;
    },
    exec: async () => {
      if (!deleteKey || (await redis.get(key)) !== snapshot) return [];
      await redis.del(deleteKey);
      return [1];
    },
  };
}

export async function watchTestHash(
  redis: {
    hGetAll(key: string): Promise<Record<string, string>>;
    hSet(key: string, changes: Record<string, string>): Promise<unknown>;
    zAdd?(
      key: string,
      ...members: { member: string; score: number }[]
    ): Promise<unknown>;
    zRem?(key: string, members: string[]): Promise<unknown>;
  },
  key: string,
  beforeExec?: () => Promise<void> | undefined,
) {
  const snapshot = JSON.stringify(await redis.hGetAll(key));
  const commands: Array<() => Promise<unknown>> = [];
  return {
    multi: async () => undefined,
    discard: async () => undefined,
    unwatch: async () => undefined,
    hSet: async (targetKey: string, fields: Record<string, string>) => {
      commands.push(() => redis.hSet(targetKey, fields));
    },
    zAdd: async (
      key: string,
      ...members: { member: string; score: number }[]
    ) => {
      commands.push(async () => redis.zAdd?.(key, ...members));
    },
    zRem: async (key: string, members: string[]) => {
      commands.push(async () => redis.zRem?.(key, members));
    },
    exec: async () => {
      await beforeExec?.();
      if (JSON.stringify(await redis.hGetAll(key)) !== snapshot) {
        return [];
      }
      const results = [];
      for (const command of commands) results.push(await command());
      return results;
    },
  };
}
