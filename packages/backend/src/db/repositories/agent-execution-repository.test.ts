import { describe, expect, it } from 'vitest';
import {
  AGENT_CHAT_QUEUE_COLLECTION,
  AGENT_RUNS_COLLECTION,
  findLivePersistedChatRuns,
  findRunningAgentRuns,
} from './agent-execution-repository.js';

describe('agent-execution-repository', () => {
  it('uses stable collection names aligned with the SQL store adapter', () => {
    expect(AGENT_RUNS_COLLECTION).toBe('agent_runs');
    expect(AGENT_CHAT_QUEUE_COLLECTION).toBe('agentChatQueue');
  });

  it('findRunningAgentRuns is callable (live store read)', () => {
    expect(() => findRunningAgentRuns()).not.toThrow();
    expect(Array.isArray(findRunningAgentRuns())).toBe(true);
  });

  it('findLivePersistedChatRuns narrows by optional target message', () => {
    const rows = findLivePersistedChatRuns({
      agentId: '__no_such_agent__',
      conversationId: '__no_such_conv__',
      targetMessageId: null,
    });
    expect(rows).toEqual([]);
  });
});
