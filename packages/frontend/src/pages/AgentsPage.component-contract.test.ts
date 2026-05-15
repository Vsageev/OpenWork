import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

const sourcePath = fileURLToPath(new URL('./AgentsPage.tsx', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');

function failContract(options: {
  componentName: string;
  stateInput: string;
  contractName: string;
  expected: string;
  actual: string;
}): never {
  throw new Error(
    `${options.componentName} component contract violated: stateInput=${options.stateInput} classOrContractName=${options.contractName} expected=${options.expected} actual=${options.actual}`,
  );
}

function sourceSlice(startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  if (start < 0) {
    failContract({
      componentName: 'AgentsPage',
      stateInput: 'source',
      contractName: startNeedle,
      expected: 'source marker exists',
      actual: 'missing',
    });
  }
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (end < 0) {
    failContract({
      componentName: 'AgentsPage',
      stateInput: 'source',
      contractName: endNeedle,
      expected: 'source marker exists after start marker',
      actual: 'missing',
    });
  }
  return source.slice(start, end);
}

function assertContains(options: {
  componentName: string;
  stateInput: string;
  contractName: string;
  sourceText: string;
  expected: string;
}) {
  if (!options.sourceText.includes(options.expected)) {
    failContract({
      componentName: options.componentName,
      stateInput: options.stateInput,
      contractName: options.contractName,
      expected: options.expected,
      actual: options.sourceText.trim().replace(/\s+/g, ' ').slice(0, 500),
    });
  }
}

describe('AgentsPage component contract', () => {
  it('binds active conversation selection to sidebar, chat, queued rows, and composer ownership', () => {
    const sidebar = sourceSlice('data-testid="agents-sidebar"', 'data-testid="agents-chat-panel"');
    assertContains({
      componentName: 'AgentsPageSidebar',
      stateInput: 'activeAgentId=agent-active activeConvId=conversation-active',
      contractName: 'active-selection-data-attributes',
      sourceText: sidebar,
      expected: 'data-active-agent-id={activeAgentId ?? \'\'}',
    });
    assertContains({
      componentName: 'AgentsPageSidebar',
      stateInput: 'activeAgentId=agent-active activeConvId=conversation-active',
      contractName: 'active-selection-data-attributes',
      sourceText: sidebar,
      expected: 'data-active-conversation-id={activeConvId ?? \'\'}',
    });
    assertContains({
      componentName: 'AgentSidebarItem',
      stateInput: 'activeAgentId=agent-active activeConvId=conversation-active',
      contractName: 'active-conversation-prop',
      sourceText: sidebar,
      expected: 'activeConversationId={activeAgentId === agent.id ? activeConvId : null}',
    });

    const chat = sourceSlice('data-testid="agents-chat-panel"', '<ReplyComposer');
    assertContains({
      componentName: 'AgentsPageChatPanel',
      stateInput: 'mobileChatOpen=true activeConvId=conversation-active',
      contractName: 'chat-panel-active-selection',
      sourceText: chat,
      expected: 'data-active-conversation-id={activeConvId ?? \'\'}',
    });

    const queuedRow = sourceSlice('data-testid="queued-message-row"', 'className={`${styles.messageRow}');
    assertContains({
      componentName: 'QueuedMessageRow',
      stateInput: 'activeAgentId=agent-active activeConvId=conversation-active',
      contractName: 'queued-row-active-owner',
      sourceText: queuedRow,
      expected: 'data-active-agent-id={activeAgentId ?? \'\'}',
    });
    assertContains({
      componentName: 'QueuedMessageRow',
      stateInput: 'activeAgentId=agent-active activeConvId=conversation-active',
      contractName: 'queued-row-active-owner',
      sourceText: queuedRow,
      expected: 'data-active-conversation-id={activeConvId ?? \'\'}',
    });

    const composer = sourceSlice('<ReplyComposer', '/>');
    assertContains({
      componentName: 'ReplyComposer',
      stateInput: 'activeAgentId=agent-active activeConvId=conversation-active',
      contractName: 'composer-owner-props',
      sourceText: composer,
      expected: 'activeAgentId={activeAgentId}',
    });
    assertContains({
      componentName: 'ReplyComposer',
      stateInput: 'activeAgentId=agent-active activeConvId=conversation-active',
      contractName: 'composer-owner-props',
      sourceText: composer,
      expected: 'activeConversationId={activeConvId}',
    });
    assertContains({
      componentName: 'ReplyComposer',
      stateInput: 'activeAgentId=agent-active activeConvId=conversation-active',
      contractName: 'composer-send-handler',
      sourceText: composer,
      expected: 'onSendText={sendTextMessage}',
    });
  });

  it('captures composer send ownership before async state can switch conversations', () => {
    const sendTextMessage = sourceSlice(
      'const sendTextMessage = useCallback(',
      'const toggleAgentCollapse = useCallback(',
    );
    for (const expected of [
      'const sentAgentId = activeAgentId;',
      'const sentConvId = activeConvId;',
      'agentId: sentAgentId',
      'conversationId: sentConvId',
      '`/agents/${sentAgentId}/chat/message`',
      'conversationId: sentConvId',
    ]) {
      assertContains({
        componentName: 'AgentsPage.sendTextMessage',
        stateInput: 'active switches while prompt is queued',
        contractName: 'composer-send-owner-capture',
        sourceText: sendTextMessage,
        expected,
      });
    }
  });
});
