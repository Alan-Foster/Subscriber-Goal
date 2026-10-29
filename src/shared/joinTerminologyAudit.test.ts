import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const visibleCopyFiles = [
  "src/shared/subGoalPostI18n.ts",
  "src/shared/i18n/messages.json",
  "src/client/hooks/useSubGoal.ts",
  "src/server/routes/internalUi.ts",
  "src/server/routes/publicApi.ts",
] as const;

const legacyVisiblePhrases = [
  "Subscribed to r/",
  "Show my username when I subscribe",
  "Thanks for Subscribing",
  "just subscribed",
  "Thanks for subscribing",
  "Subscription failed",
  "Please log in to subscribe",
  "Subscribe Button",
  "Subscribe-Only Details",
  "subscribe-only post",
  "After Subscribing",
  "subscribed users",
  "user subscribes",
  "after-subscribed button",
  "After Subscription",
  "Subscription is required",
  "Invalid subscription attempt ID",
  "does not support subscribing",
  "Subscription could not be completed",
] as const;

describe("visible Join terminology", () => {
  it("does not reintroduce legacy subscription-action copy", () => {
    const source = visibleCopyFiles
      .map((file) => readFileSync(join(globalThis.process.cwd(), file), "utf8"))
      .join("\n");
    const readmeCurrentCopy = readFileSync(
      join(globalThis.process.cwd(), "README.md"),
      "utf8",
    ).split("## Changelog")[0];

    for (const phrase of legacyVisiblePhrases) {
      expect(source, phrase).not.toContain(phrase);
      expect(readmeCurrentCopy, phrase).not.toContain(phrase);
    }
  });
});
