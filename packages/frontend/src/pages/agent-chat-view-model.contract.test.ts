import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAgentConversationViewModel } from './agent-chat-view-model';

function getCanonicalRendererSource(): string {
  const source = readFileSync(new URL('./agent-chat-view-model.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export function buildAgentConversationViewModel');
  const end = source.indexOf('export function buildAgentChatMarkdownExport');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('Unable to locate canonical chat renderer source bounds');
  }
  return source.slice(start, end);
}

describe('agent chat canonical frontend contract', () => {
  it('renders nothing until the canonical turn view is available', () => {
    const view = buildAgentConversationViewModel({
      canonicalView: null,
      activeAgentId: 'agent-1',
      activeConvId: 'conversation-1',
    });

    expect(view.visibleMessages).toEqual([]);
    expect(view.queuedQueueItems).toEqual([]);
    expect(view.activeConversationRun).toBeNull();
    expect(view.showStreamingBubble).toBe(false);
  });

  it('has no legacy queue/message/run transcript reconstruction in the renderer', () => {
    const rendererSource = getCanonicalRendererSource();

    expect(rendererSource).not.toContain('buildLegacyAgentConversationViewModel');
    expect(rendererSource).not.toContain('ROOT_PREVIOUS_USER_MESSAGE_KEY');
    expect(rendererSource).not.toMatch(/\boptions\.(messages|queueItems|activeConversationRuns)\b/);
    expect(rendererSource).not.toMatch(
      /\b(messages|queueItems|activeConversationRuns|optimisticResponseParentIds):/,
    );
    expect(rendererSource).not.toContain('optimisticResponseParentIds[');
  });
});
