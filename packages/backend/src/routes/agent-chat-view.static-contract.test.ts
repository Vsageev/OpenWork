import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function getCanonicalViewSource(): string {
  return readFileSync(new URL('../services/agent-chat-view.ts', import.meta.url), 'utf8');
}

describe('agent chat canonical view static contract', () => {
  it('does not reintroduce legacy transcript synthesis in the chat view service', () => {
    const source = getCanonicalViewSource();

    expect(source).toContain('listAgentChatTurns');
    for (const forbidden of [
      'legacy_view_',
      'findAssistantMessageIdForTurn',
      'findAssistantMessageIdForRun',
      'findAssistantMessageIdForUserMessage',
      'findPreviousOutboundAncestor',
      'queueStatusToTurnStatus',
      'runStatusToTurnStatus',
      'queuedMessageId',
      'targetMessageId',
      'responseParentId',
      '`user:${',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).not.toMatch(/parentId\s*===\s*userMessageId/);
  });
});
