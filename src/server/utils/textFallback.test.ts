import { describe, expect, it } from 'vitest';
import { textFallbackMaker } from './textFallback';

describe('textFallbackMaker', () => {
  it('formats active subscriber counts with shared display rules', () => {
    expect(
      textFallbackMaker({
        goal: 15000,
        subscribers: 12632,
        subredditName: 'PakStartups',
        completedTime: null,
      })
    ).toContain('12632 / 15k subscribers.');
  });

  it('formats completed goal counts with shared display rules', () => {
    expect(
      textFallbackMaker({
        goal: 1500000,
        subscribers: 1500000,
        subredditName: 'PakStartups',
        completedTime: new Date('2026-04-26T00:00:00.000Z'),
      })
    ).toContain('reached 1.5m subscribers!');
  });

  it('renders Spanish fallback text', () => {
    expect(
      textFallbackMaker({
        goal: 15000,
        subscribers: 12632,
        subredditName: 'PakStartups',
        completedTime: null,
        language: 'es',
      })
    ).toContain('12632 / 15k suscriptores.');
  });
});
