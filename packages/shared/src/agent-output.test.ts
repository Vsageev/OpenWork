import { describe, expect, it } from 'vitest';
import {
  CODEX_INCOMPLETE_OUTPUT_ERROR_MESSAGE,
  STREAM_JSON_INCOMPLETE_OUTPUT_ERROR_MESSAGE,
  extractAgentOutputIncompleteText,
  extractFinalResponseText,
  formatAgentOutputForDisplay,
  parseAgentOutputBlocks,
} from './agent-output.js';

describe('Codex structured output', () => {
  it('parses Codex JSONL into monitor blocks and extracts the final response', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item-1', type: 'agent_message', text: 'CODEX_JSON_OK' },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 14048,
          cached_input_tokens: 2432,
          output_tokens: 8,
          reasoning_output_tokens: 0,
        },
      }),
    ].join('\n');

    expect(parseAgentOutputBlocks(stdout)).toEqual([
      { type: 'assistant_text', content: 'CODEX_JSON_OK' },
      {
        type: 'result',
        usage: { inputTokens: 14048, cacheRead: 2432, outputTokens: 8 },
      },
    ]);
    expect(extractFinalResponseText(stdout)).toBe('CODEX_JSON_OK');
    expect(formatAgentOutputForDisplay(stdout)).toContain('Assistant\nCODEX_JSON_OK');
  });

  it('parses Codex failure events as error result blocks', () => {
    const stdout = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'Codex failed' } }),
    ].join('\n');

    expect(parseAgentOutputBlocks(stdout)).toEqual([
      { type: 'result', isError: true, text: 'Codex failed' },
    ]);
    expect(formatAgentOutputForDisplay(stdout)).toContain('Turn failed\nMessage: Codex failed');
  });

  it('prefers the runner Codex final-message event over progress messages', () => {
    const stdout = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'progress-1', type: 'agent_message', text: 'I am still working.' },
      }),
      JSON.stringify({ type: 'turn.completed' }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'openwork-final-message-run-1',
          type: 'openwork_final_message',
          text: 'DONE_FINAL_ANSWER',
        },
      }),
    ].join('\n');

    expect(extractFinalResponseText(stdout)).toBe('DONE_FINAL_ANSWER');
    expect(parseAgentOutputBlocks(stdout)).toEqual([
      { type: 'assistant_text', content: 'I am still working.' },
    ]);
  });

  it('reports Codex JSON output that never reaches a terminal result event', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'progress-1', type: 'agent_message', text: 'I am still working.' },
      }),
    ].join('\n');

    expect(extractAgentOutputIncompleteText(stdout)).toBe(CODEX_INCOMPLETE_OUTPUT_ERROR_MESSAGE);
  });

  it('does not report completed Codex JSON output as incomplete', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'progress-1', type: 'agent_message', text: 'Done.' },
      }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');

    expect(extractAgentOutputIncompleteText(stdout)).toBe('');
  });
});

describe('stream-json structured output', () => {
  it('reports Claude stream-json output that ends without a result event', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', cwd: '/workspace' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I started, but did not finish.' }],
          stop_reason: null,
        },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
        },
      }),
      JSON.stringify({ type: 'stream_event', event: { type: 'message_stop' } }),
      JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting' }),
    ].join('\n');

    expect(extractAgentOutputIncompleteText(stdout)).toBe(
      STREAM_JSON_INCOMPLETE_OUTPUT_ERROR_MESSAGE,
    );
  });

  it('does not report Claude stream-json output with a result event as incomplete', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', cwd: '/workspace' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Finished.' }],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Finished.',
      }),
    ].join('\n');

    expect(extractAgentOutputIncompleteText(stdout)).toBe('');
  });

  it('repairs Claude NDJSON broken by mid-line rate_limit_event injection (claude-code#49640)', () => {
    const line1 =
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"before{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}';
    const line2 = 'after"}]}}';
    const stdout = [
      line1,
      line2,
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }),
    ].join('\n');

    expect(extractAgentOutputIncompleteText(stdout)).toBe('');
    expect(extractFinalResponseText(stdout)).toBe('ok');
  });
});
