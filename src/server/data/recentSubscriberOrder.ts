export type RecentSubscriberOrder = {
  timestamp: number;
  operationId: string;
  userId: string;
  erasureGeneration: string;
};

export const serializeRecentSubscriberOrder = (
  order: RecentSubscriberOrder,
): string => JSON.stringify(order);

export const parseRecentSubscriberOrder = (
  raw: string | undefined,
): RecentSubscriberOrder | undefined => {
  if (!raw) return;
  try {
    const value = JSON.parse(raw) as Partial<RecentSubscriberOrder>;
    if (
      typeof value.timestamp === "number" &&
      Number.isFinite(value.timestamp) &&
      typeof value.operationId === "string" &&
      typeof value.userId === "string" &&
      typeof value.erasureGeneration === "string"
    ) {
      return value as RecentSubscriberOrder;
    }
  } catch {
    // diagnostic-allow-silent: legacy posts do not have an ordering record.
  }
};

export const compareRecentSubscriberOrder = (
  left: Pick<RecentSubscriberOrder, "timestamp" | "operationId">,
  right: Pick<RecentSubscriberOrder, "timestamp" | "operationId">,
): number =>
  left.timestamp !== right.timestamp
    ? left.timestamp - right.timestamp
    : left.operationId === right.operationId
      ? 0
      : left.operationId < right.operationId
        ? -1
        : 1;
