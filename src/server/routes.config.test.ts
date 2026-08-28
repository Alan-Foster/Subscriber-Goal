import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formNames, internalRoutes } from "../shared/routes";

describe("devvit.json route alignment", () => {
  const configPath = join(process.cwd(), "devvit.json");
  const devvitConfig = JSON.parse(readFileSync(configPath, "utf-8")) as {
    post: {
      entrypoints: Record<
        string,
        { entry: string; height?: string; styles?: { height?: number } }
      >;
    };
    forms: Record<string, string>;
    triggers: Record<string, string>;
    scheduler: { tasks: { "posts-updater-job": { endpoint: string } } };
    menu: {
      items: Array<{ endpoint: string; label: string; forUserType?: string }>;
    };
    permissions: { reddit?: { asUser?: string[] } };
    settings?: { subreddit?: Record<string, unknown> };
  };

  it("maps forms to the same internal endpoints", () => {
    expect(devvitConfig.forms[formNames.createGoal]).toBe(
      internalRoutes.forms.createGoal,
    );
    expect(devvitConfig.forms[formNames.deleteGoal]).toBe(
      internalRoutes.forms.deleteGoal,
    );
    expect(devvitConfig.forms[formNames.eraseData]).toBe(
      internalRoutes.forms.eraseData,
    );
    expect(devvitConfig.forms[formNames.eraseMyData]).toBe(
      internalRoutes.forms.eraseMyData,
    );
  });

  it("keeps Tiny posts on a dedicated 120px entrypoint", () => {
    expect(devvitConfig.post.entrypoints.default).toMatchObject({
      entry: "app.html",
      height: "regular",
    });
    expect(devvitConfig.post.entrypoints["subscribe-only"]).toEqual({
      entry: "subscribe-only.html",
      styles: { height: 120 },
    });
  });

  it("maps triggers to the same internal endpoints", () => {
    expect(devvitConfig.triggers.onAppInstall).toBe(
      internalRoutes.triggers.onAppInstall,
    );
    expect(devvitConfig.triggers.onAppUpgrade).toBe(
      internalRoutes.triggers.onAppUpgrade,
    );
    expect(devvitConfig.triggers.onModAction).toBe(
      internalRoutes.triggers.onModAction,
    );
  });

  it("maps scheduler task endpoint to the same internal endpoint", () => {
    expect(devvitConfig.scheduler.tasks["posts-updater-job"].endpoint).toBe(
      internalRoutes.scheduler.postsUpdaterJob,
    );
  });

  it("includes expected menu endpoints", () => {
    const endpoints = new Set(
      devvitConfig.menu.items.map((item) => item.endpoint),
    );

    expect(endpoints.has(internalRoutes.menu.createGoal)).toBe(true);
    expect(endpoints.has(internalRoutes.menu.deleteGoal)).toBe(true);
    expect(endpoints.has(internalRoutes.menu.eraseData)).toBe(true);
    expect(endpoints.has(internalRoutes.menu.eraseMyData)).toBe(true);
  });

  it("keeps moderator and self-erasure menu visibility distinct", () => {
    const moderatorEraseItem = devvitConfig.menu.items.find(
      (item) => item.endpoint === internalRoutes.menu.eraseData,
    );
    const selfEraseItem = devvitConfig.menu.items.find(
      (item) => item.endpoint === internalRoutes.menu.eraseMyData,
    );

    expect(moderatorEraseItem).toMatchObject({
      label: "Sub Goal - Erase Another User's Data",
      forUserType: "moderator",
    });
    expect(selfEraseItem).toMatchObject({
      label: "Sub Goal - Erase My User Data",
    });
    expect(selfEraseItem).not.toHaveProperty("forUserType");
  });

  it("does not expose subreddit installation settings", () => {
    expect(devvitConfig.settings?.subreddit).toBeUndefined();
  });

  it("includes required runAs user scopes", () => {
    expect(devvitConfig.permissions.reddit?.asUser).toContain(
      "SUBSCRIBE_TO_SUBREDDIT",
    );
    expect(devvitConfig.permissions.reddit?.asUser).toContain("SUBMIT_POST");
  });
});
