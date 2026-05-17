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

function assertNotContains(options: {
  componentName: string;
  stateInput: string;
  contractName: string;
  sourceText: string;
  unexpected: string;
}) {
  if (options.sourceText.includes(options.unexpected)) {
    failContract({
      componentName: options.componentName,
      stateInput: options.stateInput,
      contractName: options.contractName,
      expected: `source does not include ${options.unexpected}`,
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
      expected: "data-active-agent-id={activeAgentId ?? ''}",
    });
    assertContains({
      componentName: 'AgentsPageSidebar',
      stateInput: 'activeAgentId=agent-active activeConvId=conversation-active',
      contractName: 'active-selection-data-attributes',
      sourceText: sidebar,
      expected: "data-active-conversation-id={activeConvId ?? ''}",
    });
    assertContains({
      componentName: 'AgentSidebarItem',
      stateInput: 'activeAgentId=agent-active activeConvId=conversation-active',
      contractName: 'active-conversation-prop',
      sourceText: sidebar,
      expected: 'activeConversationId={',
    });
    assertContains({
      componentName: 'AgentSidebarItem',
      stateInput: 'activeAgentId=agent-active activeConvId=conversation-active',
      contractName: 'active-conversation-prop-owner',
      sourceText: sidebar,
      expected: 'activeAgentId === agent.id ? activeConvId : null',
    });

    const chat = sourceSlice('data-testid="agents-chat-panel"', '<ReplyComposer');
    assertContains({
      componentName: 'AgentsPageChatPanel',
      stateInput: 'mobileChatOpen=true activeConvId=conversation-active',
      contractName: 'chat-panel-active-selection',
      sourceText: chat,
      expected: "data-active-conversation-id={activeConvId ?? ''}",
    });

    const queuedRow = sourceSlice(
      'data-testid="queued-message-row"',
      'className={`${styles.messageRow}',
    );
    assertContains({
      componentName: 'QueuedMessageRow',
      stateInput: 'activeAgentId=agent-active activeConvId=conversation-active',
      contractName: 'queued-row-active-owner',
      sourceText: queuedRow,
      expected: "data-active-agent-id={activeAgentId ?? ''}",
    });
    assertContains({
      componentName: 'QueuedMessageRow',
      stateInput: 'activeAgentId=agent-active activeConvId=conversation-active',
      contractName: 'queued-row-active-owner',
      sourceText: queuedRow,
      expected: "data-active-conversation-id={activeConvId ?? ''}",
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

  it('keeps backend-queued chat turns polling after the first send handoff', () => {
    const activeState = sourceSlice(
      'const activeMessageIds = useMemo(',
      'const activeAgentWorkspaceIds = useMemo(',
    );
    for (const expected of [
      'const activeChatSurfaceMessageIds = useMemo(() => {',
      'for (const { message } of queuedMessages) {',
      'activeChatSurfaceMessageIds.has(optimisticActiveTargetId)',
      'const shouldSyncActiveConversation = streaming || queuedQueueItems.length > 0;',
    ]) {
      assertContains({
        componentName: 'AgentsPage.activeConversationState',
        stateInput: 'first sent message is temporarily backend-queued',
        contractName: 'queued-turn-sync-handoff',
        sourceText: activeState,
        expected,
      });
    }

    const syncEffect = sourceSlice(
      '// While a run is active or queued, keep the active chat state in sync',
      'const wasStreamingRef = useRef(false);',
    );
    assertContains({
      componentName: 'AgentsPage.activeConversationSync',
      stateInput: 'canonical view has queued row but no streaming run yet',
      contractName: 'queued-turn-sync-loop',
      sourceText: syncEffect,
      expected: 'if (!shouldSyncActiveConversation || !activeAgentId || !activeConvId) {',
    });
  });

  it('detects stale AgentSidebarItem row state when active conversation or per-row pending keys change', () => {
    const memoEq = sourceSlice(
      'function areAgentSidebarItemPropsEqual(',
      'function areChatConversationListsEqual(',
    );
    assertContains({
      componentName: 'AgentSidebarItem.memo',
      stateInput: 'activeConversationId switch during queued/streaming badges',
      contractName: 'memo-active-conversation',
      sourceText: memoEq,
      expected: 'if (prev.activeConversationId !== next.activeConversationId) return false;',
    });
    assertContains({
      componentName: 'AgentSidebarItem.memo',
      stateInput: 'main chat Thinking/streaming without isBusy or pending keys',
      contractName: 'memo-open-chat-panel-streaming',
      sourceText: memoEq,
      expected: 'if (prev.openChatPanelStreaming !== next.openChatPanelStreaming) return false;',
    });
    assertContains({
      componentName: 'AgentSidebarItem.memo',
      stateInput: 'pendingConversationKeys differs for same conversation list ref',
      contractName: 'memo-pending-keys-per-conversation',
      sourceText: memoEq,
      expected:
        'if (prev.pendingConversationKeys.has(key) !== next.pendingConversationKeys.has(key)) {',
    });
    assertContains({
      componentName: 'AgentSidebarItem.memo',
      stateInput: 'runHandoffKeys differs for same conversation list ref',
      contractName: 'memo-run-handoff-keys-per-conversation',
      sourceText: memoEq,
      expected: 'if (prev.runHandoffKeys.has(key) !== next.runHandoffKeys.has(key)) {',
    });
  });

  it('ties sidebar/chat layout data attributes to the same mobileChatOpen switch', () => {
    const layout = sourceSlice(
      'data-testid="agents-layout-container"',
      'data-testid="agents-sidebar"',
    );
    assertContains({
      componentName: 'AgentsPage',
      stateInput: 'two-pane root',
      contractName: 'agents-layout-container',
      sourceText: layout,
      expected: 'data-testid="agents-layout-container"',
    });

    const sidebar = sourceSlice('data-testid="agents-sidebar"', 'data-testid="agents-chat-panel"');
    const chat = sourceSlice('data-testid="agents-chat-panel"', '{activeAgent && activeConvId');
    const layoutState =
      "data-layout-state={mobileChatOpen ? 'mobile-chat-open' : 'mobile-sidebar-open'}";
    assertContains({
      componentName: 'AgentsPage.sidebar',
      stateInput: 'mobileChatOpen boolean',
      contractName: 'data-layout-state',
      sourceText: sidebar,
      expected: layoutState,
    });
    assertContains({
      componentName: 'AgentsPage.chatPanel',
      stateInput: 'mobileChatOpen boolean',
      contractName: 'data-layout-state',
      sourceText: chat,
      expected: layoutState,
    });

    const sidebarOpenLine = sourceSlice(
      'className={`${styles.sidebar} ${mobileChatOpen ? styles.sidebarMobileHidden : styles.sidebarMobileOpen}`}',
      'data-testid="agents-sidebar"',
    );
    assertContains({
      componentName: 'AgentsPage.sidebar',
      stateInput: 'mobileChatOpen toggles sidebar visibility classes',
      contractName: 'mutually-exclusive-mobile-classNames',
      sourceText: sidebarOpenLine,
      expected:
        'className={`${styles.sidebar} ${mobileChatOpen ? styles.sidebarMobileHidden : styles.sidebarMobileOpen}`}',
    });

    const chatOpenLine = sourceSlice(
      'className={`${styles.chatPanel} ${mobileChatOpen ? styles.chatPanelMobileOpen : styles.chatPanelMobileHidden}`}',
      'data-testid="agents-chat-panel"',
    );
    assertContains({
      componentName: 'AgentsPage.chatPanel',
      stateInput: 'mobileChatOpen toggles chat visibility classes',
      contractName: 'mutually-exclusive-mobile-classNames',
      sourceText: chatOpenLine,
      expected:
        'className={`${styles.chatPanel} ${mobileChatOpen ? styles.chatPanelMobileOpen : styles.chatPanelMobileHidden}`}',
    });
  });

  it('routes queued branch-response edits through the queue editor without blocking active edits', () => {
    const messageRender = sourceSlice(
      'const pendingBranchExecutions =',
      '{queuedMessages.length > 0 && (',
    );
    for (const expected of [
      'effectivePendingBranchExecutionsByMessageId.get(msg.id) ?? []',
      "pendingBranchExecutions.find((item) => item.status === 'queued') ?? null",
      'editableBranchQueueItem',
      'startEditingQueuedMessage(msg, editableBranchQueueItem)',
      'startEditingMessage(msg)',
      "'Edit queued message'",
      'disabled={editingMessage?.isSubmitting}',
    ]) {
      assertContains({
        componentName: 'AgentsPage.messageMeta',
        stateInput: 'outbound message has queued respond_to_message item',
        contractName: 'branch-response-queue-edit-path',
        sourceText: messageRender,
        expected,
      });
    }
    for (const unexpected of [
      'isBranchQueueEditBlocked',
      "'Stop the running response before editing this message.'",
      'styles.editMsgBtnLocked',
    ]) {
      assertNotContains({
        componentName: 'AgentsPage.messageMeta',
        stateInput: 'outbound message has processing respond_to_message item',
        contractName: 'branch-response-active-edit-not-blocked',
        sourceText: messageRender,
        unexpected,
      });
    }
  });

  it('opens normal message editing for processing queued-message rows', () => {
    const queuedEditButton = sourceSlice(
      '{(queueItem || isProcessingQueuedItem) && (',
      '{queueItem && (',
    );
    for (const expected of [
      "isProcessingQueuedItem\n                                              ? 'Edit message'",
      'if (isProcessingQueuedItem) {',
      'startEditingMessage(message)',
      'startEditingQueuedMessage(message, queueItem)',
      'isQueuedItemBusy || editingMessage?.isSubmitting',
    ]) {
      assertContains({
        componentName: 'AgentsPage.queuedMessageRow',
        stateInput: 'queued message row has status=processing',
        contractName: 'processing-queued-row-edit-message',
        sourceText: queuedEditButton,
        expected,
      });
    }
    assertNotContains({
      componentName: 'AgentsPage.queuedMessageRow',
      stateInput: 'queued message row has status=processing',
      contractName: 'processing-queued-row-edit-message',
      sourceText: queuedEditButton,
      unexpected:
        'disabled={\n                                                isProcessingQueuedItem ||',
    });
  });
});
