import { describe, expect, it } from 'vitest';
import { finalizeCodexRunnerLogs } from './codex-final-message.js';

describe('Codex final-message handoff', () => {
  it('appends a hidden OpenWork final-message event when Codex writes the last-message file', () => {
    const finalized = finalizeCodexRunnerLogs({
      runId: 'run-1',
      code: 0,
      stdout: '{"type":"turn.completed"}\n',
      stderr: '',
      outputLastMessagePath: '/tmp/openwork-runner/codex-last-messages/run-1.txt',
      lastMessage: 'Actual final answer',
    });

    expect(finalized.code).toBe(0);
    expect(finalized.appendedFinalMessage).toBe(true);
    expect(finalized.stdout).toContain('"type":"openwork_final_message"');
    expect(finalized.stdout).toContain('Actual final answer');
  });

  it('leaves logs unchanged when the final-message file is empty', () => {
    const finalized = finalizeCodexRunnerLogs({
      runId: 'run-2',
      code: 0,
      stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"progress"}}\n',
      stderr: '',
      outputLastMessagePath: '/tmp/openwork-runner/codex-last-messages/run-2.txt',
      lastMessage: '',
    });

    expect(finalized.code).toBe(0);
    expect(finalized.appendedFinalMessage).toBe(false);
    expect(finalized.stdout).toContain('progress');
    expect(finalized.stderr).toBe('');
  });

  it('does not rewrite an already failing Codex process without a final message', () => {
    const finalized = finalizeCodexRunnerLogs({
      runId: 'run-3',
      code: 2,
      stdout: '',
      stderr: 'process failed\n',
      outputLastMessagePath: '/tmp/openwork-runner/codex-last-messages/run-3.txt',
      lastMessage: '',
    });

    expect(finalized.code).toBe(2);
    expect(finalized.stderr).toBe('process failed\n');
  });
});
