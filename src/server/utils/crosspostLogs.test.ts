import { describe, expect, it, vi } from 'vitest';
import { logCrosspostEvent } from './crosspostLogs';

describe('logCrosspostEvent', () => {
  it('logs compact JSON with only defined fields', () => {
    const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    logCrosspostEvent({
      event: 'crosspost_retry_started',
      targetSubreddit: 'PythiaSpeaks',
      currentInstallSubreddit: 'pythiaspeaks',
      authoritySubreddit: 'pythiaspeaks',
      ingestionAllowed: true,
    });

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const message = String(consoleInfoSpy.mock.calls[0]?.[0] ?? '');
    expect(message.startsWith('[crosspost] ')).toBe(true);
    const payload = JSON.parse(message.slice('[crosspost] '.length)) as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({
      event: 'crosspost_retry_started',
      targetSubreddit: 'PythiaSpeaks',
      currentInstallSubreddit: 'pythiaspeaks',
      authoritySubreddit: 'pythiaspeaks',
      ingestionAllowed: true,
    });
    expect('sourcePostId' in payload).toBe(false);
    expect('crosspostId' in payload).toBe(false);
    expect('errorMessage' in payload).toBe(false);
    consoleInfoSpy.mockRestore();
  });

  it('omits zero-valued numeric fields while keeping non-zero values', () => {
    const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    logCrosspostEvent({
      event: 'crosspost_retry_succeeded',
      targetSubreddit: 'PythiaSpeaks',
      crosspostsCreated: 0,
      crosspostsSkipped: 0,
      revisionsFetched: 13,
      newPostsSeen: 1,
      ingestionAllowed: true,
    });

    const message = String(consoleInfoSpy.mock.calls[0]?.[0] ?? '');
    const payload = JSON.parse(message.slice('[crosspost] '.length)) as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({
      event: 'crosspost_retry_succeeded',
      targetSubreddit: 'PythiaSpeaks',
      revisionsFetched: 13,
      newPostsSeen: 1,
      ingestionAllowed: true,
    });
    expect('crosspostsCreated' in payload).toBe(false);
    expect('crosspostsSkipped' in payload).toBe(false);
    consoleInfoSpy.mockRestore();
  });

  it('routes warn and error levels to the correct console methods', () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logCrosspostEvent(
      {
        event: 'crosspost_attempt_skipped',
        sourcePostId: 't3_abc123',
        reason: 'source_not_crosspostable',
      },
      'warn'
    );
    logCrosspostEvent(
      {
        event: 'crosspost_attempt_failed',
        sourcePostId: 't3_abc123',
        errorMessage: 'boom',
      },
      'error'
    );

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('does not throw when console forwarding fails', () => {
    const consoleInfoSpy = vi
      .spyOn(console, 'info')
      .mockImplementation(() => {
        throw new Error('forwarding failed');
      });
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    expect(() =>
      logCrosspostEvent({
        event: 'crosspost_retry_started',
      })
    ).not.toThrow();

    expect(stdoutSpy).toHaveBeenCalled();
    consoleInfoSpy.mockRestore();
    stdoutSpy.mockRestore();
  });
});
