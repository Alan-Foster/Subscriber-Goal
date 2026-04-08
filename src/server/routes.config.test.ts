import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formNames, internalRoutes } from '../shared/routes';

describe('devvit.json route alignment', () => {
  const configPath = join(process.cwd(), 'devvit.json');
  const devvitConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as {
    forms: Record<string, string>;
    triggers: Record<string, string>;
    scheduler: { tasks: { 'posts-updater-job': { endpoint: string } } };
    menu: { items: Array<{ endpoint: string; label: string }> };
  };

  it('maps forms to the same internal endpoints', () => {
    expect(devvitConfig.forms[formNames.createGoal]).toBe(internalRoutes.forms.createGoal);
    expect(devvitConfig.forms[formNames.deleteGoal]).toBe(internalRoutes.forms.deleteGoal);
    expect(devvitConfig.forms[formNames.eraseData]).toBe(internalRoutes.forms.eraseData);
  });

  it('maps triggers to the same internal endpoints', () => {
    expect(devvitConfig.triggers.onAppInstall).toBe(internalRoutes.triggers.onAppInstall);
    expect(devvitConfig.triggers.onAppUpgrade).toBe(internalRoutes.triggers.onAppUpgrade);
    expect(devvitConfig.triggers.onModAction).toBe(internalRoutes.triggers.onModAction);
  });

  it('maps scheduler task endpoint to the same internal endpoint', () => {
    expect(devvitConfig.scheduler.tasks['posts-updater-job'].endpoint).toBe(
      internalRoutes.scheduler.postsUpdaterJob
    );
  });

  it('includes expected menu endpoints', () => {
    const endpoints = new Set(devvitConfig.menu.items.map((item) => item.endpoint));

    expect(endpoints.has(internalRoutes.menu.createGoal)).toBe(true);
    expect(endpoints.has(internalRoutes.menu.deleteGoal)).toBe(true);
    expect(endpoints.has(internalRoutes.menu.eraseData)).toBe(true);
  });
});
