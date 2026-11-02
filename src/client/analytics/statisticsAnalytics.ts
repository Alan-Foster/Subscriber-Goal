import { apiRoutes } from "../../shared/routes";
import type { StatisticsEventRequest } from "../../shared/types/api";
import { logDiagnostic } from "../../shared/diagnostics";

const visitorStorageKey = "subscriber-goal:statistics-visitor-v1";

export const createStatisticsEventId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
};

let fallbackVisitorId: string | null = null;

export const getStatisticsVisitorId = (): string => {
  try {
    const existing = window.localStorage.getItem(visitorStorageKey);
    if (existing) return existing;
    const created = createStatisticsEventId();
    window.localStorage.setItem(visitorStorageKey, created);
    return created;
  } catch {
    // diagnostic-allow-silent: storage can be unavailable in privacy modes; the in-memory ID is safe.
    fallbackVisitorId ??= createStatisticsEventId();
    return fallbackVisitorId;
  }
};

export const statisticsRequestHeaders = (
  eventId?: string,
): Record<string, string> => ({
  "X-SG-Visitor-ID": getStatisticsVisitorId(),
  ...(eventId ? { "X-SG-Event-ID": eventId } : {}),
});

export const recordStatisticsEvent = (
  type: StatisticsEventRequest["type"],
): void => {
  const request: StatisticsEventRequest = {
    type,
    eventId: createStatisticsEventId(),
  };
  void Promise.resolve(
    fetch(apiRoutes.statisticsEvent, {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        ...statisticsRequestHeaders(),
      },
      body: JSON.stringify(request),
    }),
  )
    .then((response) => {
      if (!response.ok) {
        logDiagnostic("warn", "statistics_event_failed", {
          workflow: "statistics",
          phase: type,
          status: response.status,
        });
      }
    })
    .catch((error: unknown) => {
      logDiagnostic(
        "warn",
        "statistics_event_failed",
        { workflow: "statistics", phase: type },
        error,
      );
    });
};
