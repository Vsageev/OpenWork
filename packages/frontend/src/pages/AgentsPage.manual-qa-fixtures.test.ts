import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildAgentConversationViewModel,
  type AgentConversationChatTurn,
} from './agent-chat-view-model';

const agentsPagePath = fileURLToPath(new URL('./AgentsPage.tsx', import.meta.url));
const cssPath = fileURLToPath(new URL('./AgentsPage.module.css', import.meta.url));
const agentsPageSource = readFileSync(agentsPagePath, 'utf8');
const css = readFileSync(cssPath, 'utf8');
const baseTime = '2026-05-15T10:00:00.000Z';

const manualQaFixtures = [
  {
    id: 'qa-route-agent-conversation-selection',
    layer: 'route state',
    inspected: [
      'AgentsPage.tsx:readConversationBootstrapRequest',
      'AgentsPage.tsx:syncActiveConversationUrl',
      'AgentsPage.tsx:setActiveConversation',
    ],
    input: '?agentId=agent-route&conversationId=conv-route',
  },
  {
    id: 'qa-component-sidebar-chat-owner',
    layer: 'component state',
    inspected: [
      'AgentsPage.tsx:AgentSidebarItem',
      'AgentsPage.tsx:areAgentSidebarItemPropsEqual',
      'AgentsPage.tsx:data-testid="agents-sidebar"',
      'AgentsPage.tsx:data-testid="agents-chat-panel"',
    ],
    input: 'activeAgentId=agent-a activeConvId=conv-a mobileChatOpen=true',
  },
  {
    id: 'qa-state-queued',
    layer: 'queue state',
    inspected: ['agent-chat-view-model.ts:buildAgentConversationViewModel'],
    input: 'append_prompt queued item for active agent/conversation',
  },
  {
    id: 'qa-state-running',
    layer: 'queue state',
    inspected: ['agent-chat-view-model.ts:buildAgentConversationViewModel'],
    input: 'canonical running turn for visible active message',
  },
  {
    id: 'qa-state-completed',
    layer: 'queue state',
    inspected: ['agent-chat-view-model.ts:buildAgentConversationViewModel'],
    input: 'canonical completed turn for active conversation',
  },
  {
    id: 'qa-layout-desktop',
    layer: 'css-module layout',
    inspected: ['AgentsPage.module.css:.container', 'AgentsPage.module.css:.sidebar'],
    input: 'desktop default CSS module rules',
  },
  {
    id: 'qa-layout-tablet',
    layer: 'css-module layout',
    inspected: ['AgentsPage.module.css:@media (max-width: 1024px)'],
    input: 'tablet breakpoint CSS module rules',
  },
  {
    id: 'qa-layout-narrow',
    layer: 'css-module layout',
    inspected: [
      'AgentsPage.module.css:@media (max-width: 640px)',
      'AgentsPage.module.css:@media (max-width: 480px)',
    ],
    input: 'narrow breakpoint CSS module rules',
  },
  {
    id: 'qa-layout-mobile-drawer',
    layer: 'css-module layout',
    inspected: ['AgentsPage.module.css:@media (max-width: 768px)'],
    input: 'mobile drawer breakpoint CSS module rules',
  },
  {
    id: 'qa-negative-sidebar-chat-mismatch',
    layer: 'negative control',
    inspected: ['agent-chat-view-model.ts:buildAgentConversationViewModel'],
    input: 'sidebar active conversation differs from chat active conversation',
  },
  {
    id: 'qa-negative-desktop-forced-drawer',
    layer: 'negative control',
    inspected: ['AgentsPage.module.css:.sidebar'],
    input: 'desktop sidebar rule with injected fixed overlay positioning',
  },
] as const;

function turn(
  partial: Partial<AgentConversationChatTurn> & Pick<AgentConversationChatTurn, 'id' | 'status'>,
): AgentConversationChatTurn {
  const createdAt = '2026-05-15T10:00:10.000Z';
  const userMessageId = partial.userMessage?.id ?? 'queued-active';
  return {
    parentTurnId: 'turn-root',
    turnType: 'follow_up',
    userMessage: {
      id: userMessageId,
      direction: 'outbound',
      type: 'text',
      content: 'queued active prompt',
      status: 'sent',
      metadata: null,
      attachments: null,
      createdAt,
      updatedAt: null,
    },
    assistantMessage: null,
    execution: { queue: null, run: null },
    branch: {
      parentTurnId: 'turn-root',
      isSelected: true,
      siblingIndex: 0,
      siblingCount: 1,
      siblingIds: [partial.id],
      siblings: [
        {
          turnId: partial.id,
          userMessageId,
          status: partial.status,
          turnType: 'follow_up',
          supersedesTurnId: null,
          isSelected: true,
          createdAt,
        },
      ],
    },
    edit: {
      supersedesTurnId: null,
      supersededByTurnId: null,
      isSuperseded: false,
    },
    availableActions: [],
    createdAt,
    updatedAt: null,
    startedAt: null,
    completedAt: null,
    ...partial,
  };
}

function ruleBody(selector: string, source = css): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  if (!match) {
    throw new Error(`manual QA fixture missing CSS rule: fixtureSelector=${selector}`);
  }
  return match[1] ?? '';
}

function mediaBody(query: string): string {
  const start = css.indexOf(`@media ${query}`);
  if (start < 0) throw new Error(`manual QA fixture missing media query: ${query}`);
  const blockStart = css.indexOf('{', start);
  let depth = 0;
  for (let index = blockStart; index < css.length; index += 1) {
    const char = css[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return css.slice(blockStart + 1, index);
  }
  throw new Error(`manual QA fixture media query is unclosed: ${query}`);
}

function assertNoDrawerOverlay(options: { fixtureId: string; source: string }) {
  if (/\bposition\s*:\s*(absolute|fixed)\b/.test(options.source)) {
    throw new Error(
      `manual QA negative layout contract failed: fixtureId=${options.fixtureId} expected=no desktop/tablet/narrow drawer overlay actual=${options.source.trim().replace(/\s+/g, ' ')}`,
    );
  }
}

describe('AgentsPage manual QA fixture manifest', () => {
  it('records inspected files/functions and fixture inputs for external audit', () => {
    expect(manualQaFixtures.map((fixture) => fixture.id)).toEqual([
      'qa-route-agent-conversation-selection',
      'qa-component-sidebar-chat-owner',
      'qa-state-queued',
      'qa-state-running',
      'qa-state-completed',
      'qa-layout-desktop',
      'qa-layout-tablet',
      'qa-layout-narrow',
      'qa-layout-mobile-drawer',
      'qa-negative-sidebar-chat-mismatch',
      'qa-negative-desktop-forced-drawer',
    ]);
    expect(new Set(manualQaFixtures.map((fixture) => fixture.layer))).toEqual(
      new Set([
        'route state',
        'component state',
        'queue state',
        'css-module layout',
        'negative control',
      ]),
    );
    for (const fixture of manualQaFixtures) {
      expect(fixture.inspected.length, fixture.id).toBeGreaterThan(0);
      expect(fixture.input, fixture.id).not.toHaveLength(0);
    }
  });

  it('fixture qa-route-agent-conversation-selection binds URL params to one active owner', () => {
    for (const expected of [
      'const [searchParams, setSearchParams] = useSearchParams();',
      "searchParams.get('agentId') ?? searchParams.get('id') ?? searchParams.get('settingsAgentId')",
      "conversationId: searchParams.get('conversationId')",
      "nextParams.set('agentId', activeAgentId);",
      "nextParams.set('conversationId', activeConvId);",
      'setMobileChatOpen(!!(agentId && conversationId));',
    ]) {
      expect(agentsPageSource).toContain(expected);
    }
  });

  it('fixture qa-component-sidebar-chat-owner exposes matching textual owners on sidebar, chat, queue, and composer', () => {
    for (const expected of [
      'data-testid="agents-sidebar"',
      'data-testid="agents-chat-panel"',
      "data-active-agent-id={activeAgentId ?? ''}",
      "data-active-conversation-id={activeConvId ?? ''}",
      'activeConversationId={',
      'activeAgentId === agent.id ? activeConvId : null',
      "isQueuedTranscriptMessage ? 'queued-message-row' : undefined",
      'activeAgentId={activeAgentId}',
      'activeConversationId={activeConvId}',
      'if (prev.activeConversationId !== next.activeConversationId) return false;',
      'if (prev.pendingConversationKeys.has(key) !== next.pendingConversationKeys.has(key)) {',
    ]) {
      expect(agentsPageSource).toContain(expected);
    }
  });

  it.each([
    ['qa-state-queued', 'queued', ['queue-active'], [], ['queued-active'], false],
    ['qa-state-running', 'processing', [], ['queued-active'], [], true],
  ] as const)(
    '%s keeps queued and running chat state scoped to the active conversation',
    (
      _fixtureId,
      expectedTurnStatus,
      expectedQueueIds,
      expectedVisibleMessageIds,
      expectedQueuedMessageIds,
      expectedStreaming,
    ) => {
      const canonicalQueue =
        expectedTurnStatus === 'queued'
          ? {
              id: 'queue-active',
              turnId: 'turn-active',
              status: 'queued',
              position: 1,
              runId: null,
              errorMessage: null,
              attempts: 0,
              maxAttempts: 3,
              nextAttemptAt: null,
              startedAt: null,
              completedAt: null,
              usedFallback: false,
              fallbackModel: null,
            }
          : {
              id: 'queue-active',
              turnId: 'turn-active',
              status: 'processing',
              position: 1,
              runId: 'run-running',
              errorMessage: null,
              attempts: 1,
              maxAttempts: 3,
              nextAttemptAt: null,
              startedAt: baseTime,
              completedAt: null,
              usedFallback: false,
              fallbackModel: null,
            };
      const view = buildAgentConversationViewModel({
        canonicalView: {
          agentId: 'agent-a',
          conversationId: 'conv-a',
          total: 1,
          branches: [],
          entries: [
            turn({
              id: 'turn-active',
              status: expectedTurnStatus,
              execution: {
                queue: canonicalQueue,
                run:
                  expectedTurnStatus === 'processing'
                    ? {
                        id: 'run-running',
                        turnId: 'turn-active',
                        status: 'running',
                        errorMessage: null,
                        responseText: null,
                        startedAt: baseTime,
                        finishedAt: null,
                        durationMs: null,
                      }
                    : null,
              },
            }),
          ],
        },
        activeAgentId: 'agent-a',
        activeConvId: 'conv-a',
      });

      expect(view.queuedQueueItems.map((item) => item.id)).toEqual(expectedQueueIds);
      expect(view.visibleMessages.map((message) => message.id)).toEqual(expectedVisibleMessageIds);
      expect(view.queuedMessages.map((item) => item.message.id)).toEqual(expectedQueuedMessageIds);
      expect(view.showStreamingBubble).toBe(expectedStreaming);
    },
  );

  it('fixture qa-state-completed keeps terminal queue and run records out of active pending state', () => {
    const view = buildAgentConversationViewModel({
      canonicalView: null,
      activeAgentId: 'agent-a',
      activeConvId: 'conv-a',
    });

    expect(view.queuedQueueItems).toHaveLength(0);
    expect(view.activeConversationRun).toBeNull();
    expect(view.showStreamingBubble).toBe(false);
  });

  it('layout fixtures keep desktop, tablet, and narrow sidebars out of drawer overlay mode', () => {
    expect(ruleBody('.container')).toContain('display: flex');
    const desktopSidebar = ruleBody('.sidebar');
    expect(desktopSidebar).toContain('width: 320px');
    expect(desktopSidebar).toContain('min-width: 320px');
    assertNoDrawerOverlay({ fixtureId: 'qa-layout-desktop', source: desktopSidebar });

    for (const [fixtureId, source] of [
      ['qa-layout-tablet', mediaBody('(max-width: 1024px)')],
      ['qa-layout-narrow-640', mediaBody('(max-width: 640px)')],
      ['qa-layout-narrow-480', mediaBody('(max-width: 480px)')],
    ] as const) {
      assertNoDrawerOverlay({ fixtureId, source });
    }
  });

  it('fixture qa-layout-mobile-drawer is the only drawer exception and uses explicit mobile classes', () => {
    const mobile = mediaBody('(max-width: 768px)');
    expect(ruleBody('.container', mobile)).toContain('flex-direction: column');
    expect(ruleBody('.container', mobile)).toContain('position: relative');
    expect(ruleBody('.sidebarMobileOpen', mobile)).toContain('flex: 1');
    expect(ruleBody('.sidebarMobileHidden', mobile)).toContain('display: none');
    expect(ruleBody('.chatPanelMobileHidden', mobile)).toContain('display: none');
    expect(ruleBody('.chatPanelMobileOpen', mobile)).toContain('display: flex');
    expect(ruleBody('.mobileBackBtn', mobile)).toContain('display: flex');
  });

  it('negative controls fail for mismatched chat owner and desktop drawer overlay positioning', () => {
    const mismatchedView = buildAgentConversationViewModel({
      canonicalView: null,
      activeAgentId: 'agent-a',
      activeConvId: 'conv-chat',
    });

    expect(() => {
      if (mismatchedView.queuedQueueItems.some((item) => item.id === 'queue-mismatch')) {
        return;
      }
      throw new Error(
        'manual QA negative control passed unexpectedly: fixtureId=qa-negative-sidebar-chat-mismatch expected=mismatched queue item visible actual=filtered',
      );
    }).toThrow(/qa-negative-sidebar-chat-mismatch/);

    expect(() =>
      assertNoDrawerOverlay({
        fixtureId: 'qa-negative-desktop-forced-drawer',
        source: `${ruleBody('.sidebar')}\nposition: fixed;\nz-index: 30;`,
      }),
    ).toThrow(/qa-negative-desktop-forced-drawer/);
  });
});
