import { describe, expect, it } from 'vitest';
import { STREAM_JSON_INCOMPLETE_OUTPUT_ERROR_MESSAGE } from 'shared';
import { buildRunnerTerminalMessage } from './terminal-message.js';

describe('runner terminal protocol messages', () => {
  it('does not report incomplete Claude stream-json output as completed', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', cwd: '/workspace' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Work started.' }],
        },
      }),
      JSON.stringify({ type: 'rate_limit_event' }),
      JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting' }),
    ].join('\n');

    const message = buildRunnerTerminalMessage({
      jobId: 'job-1',
      runId: 'run-1',
      provider: 'claude',
      code: 0,
      stdout,
      stderr: '',
    });

    expect(message).toMatchObject({
      type: 'failed',
      code: 0,
      message: STREAM_JSON_INCOMPLETE_OUTPUT_ERROR_MESSAGE,
      stdout,
    });
  });

  it('reports completed only after a terminal stream-json result event', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', cwd: '/workspace' }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Done.',
      }),
    ].join('\n');

    expect(buildRunnerTerminalMessage({
      jobId: 'job-1',
      runId: 'run-1',
      provider: 'claude',
      code: 0,
      stdout,
      stderr: '',
    })).toMatchObject({ type: 'completed' });
  });
});
