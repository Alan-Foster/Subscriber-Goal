export async function watchTestHash(
  redis: {
    hGetAll(key: string): Promise<Record<string, string>>;
    hSet(key: string, changes: Record<string, string>): Promise<unknown>;
  },
  key: string,
) {
  const snapshot = JSON.stringify(await redis.hGetAll(key));
  let changes: Record<string, string> | undefined;
  return {
    multi: async () => undefined,
    discard: async () => undefined,
    unwatch: async () => undefined,
    hSet: async (_key: string, fields: Record<string, string>) => {
      changes = fields;
    },
    exec: async () => {
      if (!changes || JSON.stringify(await redis.hGetAll(key)) !== snapshot) {
        return [];
      }
      await redis.hSet(key, changes);
      return [1];
    },
  };
}
