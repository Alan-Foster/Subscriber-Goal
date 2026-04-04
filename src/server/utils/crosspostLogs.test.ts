import { describe, expect, it, vi } from 'vitest';
import { logCrosspostEvent } from './crosspostLogs';

describe('logCrosspostEvent', () => {
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
