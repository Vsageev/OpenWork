import { store } from '../db/index.js';
import type { StoreRecord } from '../db/store.js';
import {
  createAgentChatTurnRecord,
  findAgentChatTurnRecordByRunId,
  findAgentChatTurnRecordByUserMessage,
  getAgentChatTurnRecord,
  listAgentChatTurnRecordsForConversation,
  updateAgentChatTurnRecord,
  type AgentChatTurnStatus,
  type AgentChatTurnType,
} from '../db/repositories/agent-chat-turns-repository.js';

export type { AgentChatTurnStatus, AgentChatTurnType };

export interface CreateAgentChatTurnParams {
  id?: string;
  conversationId: string;
  agentId: string;
  parentTurnId?: string | null;
  parentUserMessageId?: string | null;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  status?: AgentChatTurnStatus;
  runId?: string | null;
  source?: string;
  createdById?: string | null;
  turnType?: AgentChatTurnType;
  supersedesTurnId?: string | null;
  metadata?: Record<string, unknown>;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface LegacyAgentChatTurnValidationIssue {
  conversationId: string | null;
  agentId: string | null;
  code: string;
  message: string;
  messageId?: string;
  queueItemId?: string;
  runId?: string;
  turnId?: string;
}

export interface LegacyAgentChatTurnBackfillResult {
  migrated: number;
  skipped: number;
  repaired: number;
  invalid: number;
  created: number;
  updatedQueueItems: number;
  updatedRuns: number;
  repairedParentLinks: number;
  updatedActiveBranches: number;
  invalidRows: LegacyAgentChatTurnValidationIssue[];
}

export interface BackfillLegacyAgentChatTurnsOptions {
  linkReferences?: boolean;
}

export function createAgentChatTurn(params: CreateAgentChatTurnParams): StoreRecord {
  const superseded = params.supersedesTurnId
    ? getAgentChatTurnRecord(params.supersedesTurnId)
    : null;
  const parentTurnId =
    params.parentTurnId ??
    (superseded
      ? asString(superseded.parentTurnId)
      : resolveParentTurnId({
          agentId: params.agentId,
          conversationId: params.conversationId,
          userMessageId: params.userMessageId ?? null,
          parentUserMessageId: params.parentUserMessageId ?? null,
        }));

  const turn = createAgentChatTurnRecord({
    ...params,
    parentTurnId,
    metadata: normalizeMetadata(params.metadata),
  });
  if (params.supersedesTurnId) {
    markAgentChatTurnSuperseded(params.supersedesTurnId);
  }
  return turn;
}

export function createReplacementAgentChatTurn(
  supersedesTurnId: string,
  params: Omit<CreateAgentChatTurnParams, 'supersedesTurnId' | 'turnType'>,
): StoreRecord {
  const superseded = getAgentChatTurnRecord(supersedesTurnId);
  const replacement = createAgentChatTurn({
    ...params,
    parentTurnId:
      params.parentTurnId ??
      (typeof superseded?.parentTurnId === 'string' ? (superseded.parentTurnId as string) : null),
    supersedesTurnId,
    turnType: 'edit',
  });
  return replacement;
}

export function updateAgentChatTurn(
  turnId: string | null | undefined,
  patch: Partial<CreateAgentChatTurnParams>,
): StoreRecord | null {
  if (!turnId) return null;
  const existing = getAgentChatTurnRecord(turnId);
  const existingMetadata =
    existing?.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
      ? (existing.metadata as Record<string, unknown>)
      : {};
  const normalized = stripUndefined({
    ...patch,
    ...(patch.metadata
      ? { metadata: { ...existingMetadata, ...normalizeMetadata(patch.metadata) } }
      : {}),
  });
  return updateAgentChatTurnRecord(turnId, normalized);
}

function updateAgentChatTurnLifecycle(
  turnId: string | null | undefined,
  patch: Partial<CreateAgentChatTurnParams>,
): StoreRecord | null {
  if (!turnId) return null;
  const existing = getAgentChatTurnRecord(turnId);
  if (!existing) return null;
  const nextPatch = { ...patch };
  if (existing.status === 'superseded' && nextPatch.status !== 'superseded') {
    delete nextPatch.status;
  }
  return updateAgentChatTurn(turnId, nextPatch);
}

export function getAgentChatTurn(turnId: string): StoreRecord | null {
  return getAgentChatTurnRecord(turnId);
}

export function listAgentChatTurns(agentId: string, conversationId: string): StoreRecord[] {
  return listAgentChatTurnRecordsForConversation(agentId, conversationId);
}

export function findAgentChatTurnForUserMessage(
  agentId: string,
  conversationId: string,
  userMessageId: string,
): StoreRecord | null {
  return findAgentChatTurnRecordByUserMessage(agentId, conversationId, userMessageId);
}

// Legacy migration helper only. Remove after 2026-08-01 once all supported
// deployments have run `pnpm --filter backend chat-turns:migrate -- --validate-only`.
export function ensureLegacyAgentChatTurnForUserMessage(
  agentId: string,
  conversationId: string,
  userMessageId: string | null,
): StoreRecord | null {
  if (!userMessageId) return null;
  const existing = findAgentChatTurnRecordByUserMessage(agentId, conversationId, userMessageId);
  if (existing) return existing;

  const message = store.getById('messages', userMessageId);
  if (!message || message.conversationId !== conversationId || message.direction !== 'outbound') {
    return null;
  }

  const parentUserMessageId = resolvePreviousUserMessageId(userMessageId);
  const parentTurn = ensureLegacyAgentChatTurnForUserMessage(
    agentId,
    conversationId,
    parentUserMessageId,
  );
  const run = findRunForUserMessage(agentId, conversationId, userMessageId);
  const runId = asString(run?.id);
  const assistantMessageId = findAssistantMessageForRun(conversationId, runId, userMessageId);

  return createAgentChatTurn({
    agentId,
    conversationId,
    parentTurnId: asString(parentTurn?.id),
    parentUserMessageId,
    userMessageId,
    assistantMessageId,
    status: run ? runStatusToTurnStatus(run) : 'completed',
    runId,
    source: 'legacy_message',
    turnType: 'follow_up',
    metadata: { materializedFrom: 'legacy_message' },
    startedAt: asString(run?.startedAt),
    completedAt:
      asString(run?.finishedAt) ?? asString(message.updatedAt) ?? asString(message.createdAt),
    createdAt: asString(message.createdAt) ?? undefined,
    updatedAt: asString(message.updatedAt) ?? undefined,
  });
}

export function markAgentChatTurnRunning(
  turnId: string | null | undefined,
  params: { runId?: string | null; userMessageId?: string | null } = {},
): StoreRecord | null {
  return updateAgentChatTurnLifecycle(turnId, {
    status: 'running',
    runId: params.runId ?? undefined,
    userMessageId: params.userMessageId ?? undefined,
    startedAt: new Date().toISOString(),
    completedAt: null,
  });
}

export function markAgentChatTurnCompleted(
  turnId: string | null | undefined,
  params: { assistantMessageId?: string | null; runId?: string | null } = {},
): StoreRecord | null {
  return updateAgentChatTurnLifecycle(turnId, {
    status: 'completed',
    assistantMessageId: params.assistantMessageId ?? undefined,
    runId: params.runId ?? undefined,
    completedAt: new Date().toISOString(),
  });
}

export function markAgentChatTurnFailed(
  turnId: string | null | undefined,
  params: { runId?: string | null; errorMessage?: string | null } = {},
): StoreRecord | null {
  return updateAgentChatTurnLifecycle(turnId, {
    status: 'failed',
    runId: params.runId ?? undefined,
    completedAt: new Date().toISOString(),
    metadata: params.errorMessage ? { errorMessage: params.errorMessage } : undefined,
  });
}

export function markAgentChatTurnQueued(turnId: string | null | undefined): StoreRecord | null {
  return updateAgentChatTurnLifecycle(turnId, {
    status: 'queued',
    completedAt: null,
  });
}

export function markAgentChatTurnStopped(
  turnId: string | null | undefined,
  params: { runId?: string | null; errorMessage?: string | null } = {},
): StoreRecord | null {
  return updateAgentChatTurnLifecycle(turnId, {
    status: 'stopped',
    runId: params.runId ?? undefined,
    completedAt: new Date().toISOString(),
    metadata: params.errorMessage ? { errorMessage: params.errorMessage } : undefined,
  });
}

export function markAgentChatTurnSuperseded(turnId: string | null | undefined): StoreRecord | null {
  return updateAgentChatTurn(turnId, {
    status: 'superseded',
    completedAt: new Date().toISOString(),
  });
}

export function backfillLegacyAgentChatTurns(
  options: BackfillLegacyAgentChatTurnsOptions = {},
): LegacyAgentChatTurnBackfillResult {
  // Legacy migration command path only. Runtime transcript rendering must not
  // infer turns from messages, queue rows, runs, or message-id activeBranches.
  // Remove after 2026-08-01 with the retained compatibility columns.
  const linkReferences = options.linkReferences ?? true;
  const result: LegacyAgentChatTurnBackfillResult = {
    migrated: 0,
    skipped: 0,
    repaired: 0,
    invalid: 0,
    created: 0,
    updatedQueueItems: 0,
    updatedRuns: 0,
    repairedParentLinks: 0,
    updatedActiveBranches: 0,
    invalidRows: [],
  };
  const candidateConversationIds = collectAgentChatConversationIds();
  const migratedConversationIds = new Set<string>();
  const repairedConversationIds = new Set<string>();
  const invalidConversationIds = new Set<string>();
  const addIssue = (issue: LegacyAgentChatTurnValidationIssue) => {
    result.invalidRows.push(issue);
    if (issue.conversationId) invalidConversationIds.add(issue.conversationId);
  };

  const queueItems = store
    .getAll('agentChatQueue')
    .sort((a, b) => parseIsoDateMs(a.createdAt) - parseIsoDateMs(b.createdAt));
  for (const item of queueItems) {
    const agentId = asString(item.agentId);
    const conversationId = asString(item.conversationId);
    if (!agentId || !conversationId) continue;
    if (!agentExists(agentId)) {
      addIssue({
        conversationId,
        agentId,
        queueItemId: asString(item.id) ?? undefined,
        code: 'queue_agent_missing',
        message: 'Queue item references an agent that does not exist',
      });
      continue;
    }

    const existingTurnId = asString(item.turnId);
    const existingTurn = existingTurnId ? getAgentChatTurnRecord(existingTurnId) : null;
    const mode = asString(item.mode) ?? 'append_prompt';
    const userMessageId =
      asString(item.queuedMessageId) ??
      (mode === 'respond_to_message' ? asString(item.targetMessageId) : null);
    if (userMessageId && !messageExists(userMessageId, conversationId)) {
      addIssue({
        conversationId,
        agentId,
        queueItemId: asString(item.id) ?? undefined,
        messageId: userMessageId,
        code: 'queue_user_message_missing',
        message: 'Queue item references a user message that does not exist in the conversation',
      });
      continue;
    }
    const runId = asString(item.lastRunId) ?? asString(item.runId);
    const assistantMessageId = asString(item.responseMessageId);
    const supersedesTurnId = inferSupersededTurnId({
      agentId,
      conversationId,
      mode,
      userMessageId,
    });
    const turnType = supersedesTurnId
      ? 'edit'
      : mode === 'respond_to_message'
        ? 'response'
        : 'follow_up';
    const legacyTurn = findExistingLegacyTurn({ agentId, conversationId, userMessageId, runId });
    const shouldCreate = !existingTurn && !legacyTurn;
    const turn =
      existingTurn ??
      legacyTurn ??
      createAgentChatTurn({
        conversationId,
        agentId,
        parentUserMessageId: asString(item.previousUserMessageId),
        userMessageId,
        assistantMessageId,
        status: queueStatusToTurnStatus(asString(item.status)),
        runId,
        source: 'legacy_queue',
        turnType,
        supersedesTurnId,
        metadata: {
          mode,
          queueItemId: item.id,
          targetMessageId: item.targetMessageId ?? null,
        },
        startedAt: asString(item.startedAt),
        completedAt: asString(item.completedAt),
        createdAt: asString(item.createdAt) ?? undefined,
        updatedAt: asString(item.updatedAt) ?? undefined,
      });

    if (shouldCreate) {
      result.created++;
      migratedConversationIds.add(conversationId);
    }

    const turnId = asString(turn.id);
    if (linkReferences && turnId && item.turnId !== turnId && typeof item.id === 'string') {
      store.update('agentChatQueue', item.id, { turnId });
      result.updatedQueueItems++;
      repairedConversationIds.add(conversationId);
    }
    if (linkReferences && turnId && runId) {
      const run = store.getById('agent_runs', runId);
      if (run && run.turnId !== turnId) {
        store.update('agent_runs', runId, { turnId });
        result.updatedRuns++;
        repairedConversationIds.add(conversationId);
      }
    }
  }

  const runs = store
    .getAll('agent_runs')
    .sort((a, b) => parseIsoDateMs(a.startedAt) - parseIsoDateMs(b.startedAt));
  for (const run of runs) {
    const runId = asString(run.id);
    const agentId = asString(run.agentId);
    const conversationId = asString(run.conversationId);
    if (!runId || !agentId || !conversationId || run.triggerType !== 'chat') continue;
    if (!agentExists(agentId)) {
      addIssue({
        conversationId,
        agentId,
        runId,
        code: 'run_agent_missing',
        message: 'Agent run references an agent that does not exist',
      });
      continue;
    }
    if (asString(run.turnId) && getAgentChatTurnRecord(asString(run.turnId)!)) continue;
    const existing = findAgentChatTurnRecordByRunId(runId);
    if (existing && typeof existing.id === 'string') {
      if (linkReferences) {
        store.update('agent_runs', runId, { turnId: existing.id });
        result.updatedRuns++;
        repairedConversationIds.add(conversationId);
      }
      continue;
    }

    const userMessageId = asString(run.responseParentId);
    if (userMessageId && !messageExists(userMessageId, conversationId)) {
      addIssue({
        conversationId,
        agentId,
        runId,
        messageId: userMessageId,
        code: 'run_user_message_missing',
        message: 'Agent run references a response parent message that does not exist',
      });
      continue;
    }
    const assistantMessageId = findAssistantMessageForRun(conversationId, runId, userMessageId);
    const turn = createAgentChatTurn({
      conversationId,
      agentId,
      userMessageId,
      assistantMessageId,
      status: runStatusToTurnStatus(run),
      runId,
      source: 'legacy_run',
      turnType: 'follow_up',
      metadata: { triggerType: run.triggerType },
      startedAt: asString(run.startedAt),
      completedAt: asString(run.finishedAt),
      createdAt: asString(run.createdAt) ?? asString(run.startedAt) ?? undefined,
      updatedAt: asString(run.updatedAt) ?? asString(run.finishedAt) ?? undefined,
    });
    result.created++;
    migratedConversationIds.add(conversationId);
    if (linkReferences && typeof turn.id === 'string') {
      store.update('agent_runs', runId, { turnId: turn.id });
      result.updatedRuns++;
      repairedConversationIds.add(conversationId);
    }
  }

  const messages = store
    .getAll('messages')
    .filter((message) => message.direction === 'outbound')
    .sort((a, b) => parseIsoDateMs(a.createdAt) - parseIsoDateMs(b.createdAt));
  for (const message of messages) {
    const conversationId = asString(message.conversationId);
    const userMessageId = asString(message.id);
    if (!conversationId || !userMessageId) continue;
    const conversation = store.getById('conversations', conversationId);
    const agentId = asString(parseConversationMetadata(conversation?.metadata).agentId);
    if (!agentId) continue;
    if (!agentExists(agentId)) {
      addIssue({
        conversationId,
        agentId,
        messageId: userMessageId,
        code: 'message_agent_missing',
        message: 'Legacy user message belongs to a conversation whose agent does not exist',
      });
      continue;
    }
    if (findAgentChatTurnRecordByUserMessage(agentId, conversationId, userMessageId)) continue;
    const turn = ensureLegacyAgentChatTurnForUserMessage(agentId, conversationId, userMessageId);
    if (turn) {
      result.created++;
      migratedConversationIds.add(conversationId);
    }
  }

  const repairResult = repairExistingTurnParentLinks();
  result.repairedParentLinks = repairResult.repairedParentLinks;
  for (const conversationId of repairResult.conversationIds) {
    repairedConversationIds.add(conversationId);
    if (selectLatestTurnPath(conversationId) || selectLatestConversationPath(conversationId)) {
      result.updatedActiveBranches++;
    }
  }

  const validationIssues = validateAgentChatTurnChains({ requireLinkedReferences: linkReferences });
  for (const issue of validationIssues) {
    addIssue(issue);
  }

  result.migrated = migratedConversationIds.size;
  result.repaired = repairedConversationIds.size;
  result.invalid = invalidConversationIds.size;
  result.skipped = [...candidateConversationIds].filter(
    (conversationId) =>
      !migratedConversationIds.has(conversationId) &&
      !repairedConversationIds.has(conversationId) &&
      !invalidConversationIds.has(conversationId),
  ).length;

  return result;
}

export function validateAgentChatTurnChains(
  options: { requireLinkedReferences?: boolean } = {},
): LegacyAgentChatTurnValidationIssue[] {
  const requireLinkedReferences = options.requireLinkedReferences ?? true;
  const issues: LegacyAgentChatTurnValidationIssue[] = [];
  const turns = store.getAll('agentChatTurns');
  const turnsById = new Map(turns.map((turn) => [String(turn.id), turn]));
  const messages = store.getAll('messages');
  const messagesById = new Map(messages.map((message) => [String(message.id), message]));
  const runsById = new Map(store.getAll('agent_runs').map((run) => [String(run.id), run]));
  const turnsByUserMessage = new Map<string, StoreRecord[]>();

  const addIssue = (issue: LegacyAgentChatTurnValidationIssue) => {
    issues.push(issue);
  };

  for (const turn of turns) {
    const turnId = asString(turn.id);
    const agentId = asString(turn.agentId);
    const conversationId = asString(turn.conversationId);
    const userMessageId = asString(turn.userMessageId);
    if (!turnId || !agentId || !conversationId) continue;
    if (userMessageId) {
      const key = userTurnKey(agentId, conversationId, userMessageId);
      const existing = turnsByUserMessage.get(key);
      if (existing) existing.push(turn);
      else turnsByUserMessage.set(key, [turn]);
    }
  }

  for (const turn of turns) {
    const turnId = asString(turn.id);
    const agentId = asString(turn.agentId);
    const conversationId = asString(turn.conversationId);
    if (!turnId || !agentId || !conversationId) continue;

    const conversation = store.getById('conversations', conversationId);
    if (!conversation) {
      addIssue({
        conversationId,
        agentId,
        turnId,
        code: 'turn_conversation_missing',
        message: 'Turn references a conversation that does not exist',
      });
    }
    if (!agentExists(agentId)) {
      addIssue({
        conversationId,
        agentId,
        turnId,
        code: 'turn_agent_missing',
        message: 'Turn references an agent that does not exist',
      });
    }

    const parentTurnId = asString(turn.parentTurnId);
    if (parentTurnId) {
      const parent = turnsById.get(parentTurnId);
      if (!parent) {
        addIssue({
          conversationId,
          agentId,
          turnId,
          code: 'turn_parent_missing',
          message: 'Turn references a parent turn that does not exist',
        });
      } else if (parent.conversationId !== conversationId || parent.agentId !== agentId) {
        addIssue({
          conversationId,
          agentId,
          turnId,
          code: 'turn_parent_scope_mismatch',
          message: 'Turn parent belongs to a different agent or conversation',
        });
      } else if (wouldCreateTurnCycle(turnId, parentTurnId)) {
        addIssue({
          conversationId,
          agentId,
          turnId,
          code: 'turn_parent_cycle',
          message: 'Turn parent chain contains a cycle',
        });
      }
    }

    const supersedesTurnId = asString(turn.supersedesTurnId);
    if (supersedesTurnId) {
      const superseded = turnsById.get(supersedesTurnId);
      if (!superseded) {
        addIssue({
          conversationId,
          agentId,
          turnId,
          code: 'turn_supersedes_missing',
          message: 'Edit turn references a superseded turn that does not exist',
        });
      } else if (superseded.conversationId !== conversationId || superseded.agentId !== agentId) {
        addIssue({
          conversationId,
          agentId,
          turnId,
          code: 'turn_supersedes_scope_mismatch',
          message: 'Edit turn supersedes a turn from a different agent or conversation',
        });
      }
    }

    const userMessageId = asString(turn.userMessageId);
    if (userMessageId) {
      const userMessage = messagesById.get(userMessageId);
      if (!userMessage || userMessage.conversationId !== conversationId) {
        addIssue({
          conversationId,
          agentId,
          turnId,
          messageId: userMessageId,
          code: 'turn_user_message_missing',
          message: 'Turn references a user message that does not exist in the conversation',
        });
      } else if (userMessage.direction !== 'outbound') {
        addIssue({
          conversationId,
          agentId,
          turnId,
          messageId: userMessageId,
          code: 'turn_user_message_direction_invalid',
          message: 'Turn user message is not an outbound user message',
        });
      } else if (!supersedesTurnId) {
        const previousUserMessageId = resolvePreviousUserMessageId(userMessageId);
        if (previousUserMessageId) {
          const previousTurns =
            turnsByUserMessage.get(userTurnKey(agentId, conversationId, previousUserMessageId)) ??
            [];
          if (previousTurns.length > 0 && !previousTurns.some((parent) => parent.id === parentTurnId)) {
            addIssue({
              conversationId,
              agentId,
              turnId,
              messageId: userMessageId,
              code: 'turn_parent_lineage_mismatch',
              message: 'Turn parent does not match the stored previous user message lineage',
            });
          }
        }
      }
    }

    const assistantMessageId = asString(turn.assistantMessageId);
    if (assistantMessageId) {
      const assistantMessage = messagesById.get(assistantMessageId);
      if (!assistantMessage || assistantMessage.conversationId !== conversationId) {
        addIssue({
          conversationId,
          agentId,
          turnId,
          messageId: assistantMessageId,
          code: 'turn_assistant_message_missing',
          message: 'Turn references an assistant message that does not exist in the conversation',
        });
      } else if (assistantMessage.direction !== 'inbound') {
        addIssue({
          conversationId,
          agentId,
          turnId,
          messageId: assistantMessageId,
          code: 'turn_assistant_message_direction_invalid',
          message: 'Turn assistant message is not an inbound assistant message',
        });
      }
    }

    const runId = asString(turn.runId);
    if (runId) {
      const run = runsById.get(runId);
      if (!run || run.conversationId !== conversationId || run.agentId !== agentId) {
        addIssue({
          conversationId,
          agentId,
          turnId,
          runId,
          code: 'turn_run_missing',
          message: 'Turn references an agent run that does not belong to the conversation',
        });
      } else if (run.triggerType !== 'chat') {
        addIssue({
          conversationId,
          agentId,
          turnId,
          runId,
          code: 'turn_run_trigger_invalid',
          message: 'Turn references a non-chat agent run',
        });
      } else if (requireLinkedReferences && asString(run.turnId) && run.turnId !== turnId) {
        addIssue({
          conversationId,
          agentId,
          turnId,
          runId,
          code: 'run_turn_mismatch',
          message: 'Agent run turn reference does not match the canonical turn',
        });
      }
    }
  }

  for (const [key, userTurns] of turnsByUserMessage) {
    const activeTurns = userTurns.filter((turn) => turn.status !== 'superseded');
    if (activeTurns.length <= 1) continue;
    const representative = activeTurns[0];
    addIssue({
      conversationId: asString(representative?.conversationId),
      agentId: asString(representative?.agentId),
      messageId: key.slice(key.lastIndexOf(':') + 1),
      code: 'duplicate_active_user_message_turns',
      message: 'Multiple non-superseded turns reference the same user message',
    });
  }

  for (const conversationId of collectAgentChatConversationIds()) {
    const conversation = store.getById('conversations', conversationId);
    const agentId = asString(parseConversationMetadata(conversation?.metadata).agentId);
    if (!agentId) continue;
    for (const message of messages.filter(
      (candidate) => candidate.conversationId === conversationId && candidate.direction === 'outbound',
    )) {
      const messageId = asString(message.id);
      if (!messageId) continue;
      const turnsForMessage =
        turnsByUserMessage.get(userTurnKey(agentId, conversationId, messageId)) ?? [];
      if (turnsForMessage.length > 0) continue;
      addIssue({
        conversationId,
        agentId,
        messageId,
        code: 'legacy_user_message_without_turn',
        message: 'Outbound user message has no durable agent chat turn',
      });
    }

    const metadata = parseConversationMetadata(conversation?.metadata);
    const activeBranches =
      metadata.activeBranches &&
      typeof metadata.activeBranches === 'object' &&
      !Array.isArray(metadata.activeBranches)
        ? (metadata.activeBranches as Record<string, string>)
        : {};
    for (const [branchKey, selectedId] of Object.entries(activeBranches)) {
      if (branchKey.startsWith('turn:') && !turnsById.has(selectedId)) {
        addIssue({
          conversationId,
          agentId,
          turnId: selectedId,
          code: 'active_branch_turn_missing',
          message: 'Conversation active branch points at a turn that does not exist',
        });
      }
      if (branchKey.startsWith('user:') && !messagesById.has(selectedId)) {
        addIssue({
          conversationId,
          agentId,
          messageId: selectedId,
          code: 'active_branch_user_message_missing',
          message: 'Conversation active branch points at a user message that does not exist',
        });
      }
    }
  }

  if (requireLinkedReferences) {
    for (const queue of store.getAll('agentChatQueue')) {
      const agentId = asString(queue.agentId);
      const conversationId = asString(queue.conversationId);
      const queueItemId = asString(queue.id);
      if (!agentId || !conversationId || !queueItemId) continue;
      const turnId = asString(queue.turnId);
      if (!turnId || !turnsById.has(turnId)) {
        addIssue({
          conversationId,
          agentId,
          queueItemId,
          code: 'queue_turn_missing',
          message: 'Queue item is not linked to a durable agent chat turn',
        });
      }
    }
  }

  return issues;
}

function collectAgentChatConversationIds(): Set<string> {
  const conversationIds = new Set<string>();
  for (const conversation of store.getAll('conversations')) {
    const conversationId = asString(conversation.id);
    if (!conversationId) continue;
    const metadata = parseConversationMetadata(conversation.metadata);
    if (asString(metadata.agentId)) conversationIds.add(conversationId);
  }
  for (const queue of store.getAll('agentChatQueue')) {
    const conversationId = asString(queue.conversationId);
    if (conversationId) conversationIds.add(conversationId);
  }
  for (const run of store.getAll('agent_runs')) {
    const conversationId = asString(run.conversationId);
    if (conversationId && run.triggerType === 'chat') conversationIds.add(conversationId);
  }
  for (const turn of store.getAll('agentChatTurns')) {
    const conversationId = asString(turn.conversationId);
    if (conversationId) conversationIds.add(conversationId);
  }
  return conversationIds;
}

function userTurnKey(agentId: string, conversationId: string, userMessageId: string): string {
  return `${agentId}:${conversationId}:${userMessageId}`;
}

function repairExistingTurnParentLinks(): {
  repairedParentLinks: number;
  conversationIds: Set<string>;
} {
  let repairedParentLinks = 0;
  const repairedConversationIds = new Set<string>();
  const turns = store
    .getAll('agentChatTurns')
    .sort((a, b) => parseIsoDateMs(a.createdAt) - parseIsoDateMs(b.createdAt));

  for (const turn of turns) {
    const turnId = asString(turn.id);
    const agentId = asString(turn.agentId);
    const conversationId = asString(turn.conversationId);
    const userMessageId = asString(turn.userMessageId);
    if (!turnId || !agentId || !conversationId || !userMessageId) continue;
    if (!agentExists(agentId)) continue;

    const expectedParentTurnId = resolveExpectedParentTurnId({
      turn,
      agentId,
      conversationId,
      userMessageId,
    });
    if (expectedParentTurnId === turn.parentTurnId) continue;
    if (
      expectedParentTurnId &&
      (expectedParentTurnId === turnId || wouldCreateTurnCycle(turnId, expectedParentTurnId))
    ) {
      continue;
    }

    store.update('agentChatTurns', turnId, { parentTurnId: expectedParentTurnId });
    repairedParentLinks++;
    repairedConversationIds.add(conversationId);
  }

  return { repairedParentLinks, conversationIds: repairedConversationIds };
}

function resolveExpectedParentTurnId(options: {
  turn: StoreRecord;
  agentId: string;
  conversationId: string;
  userMessageId: string;
}): string | null {
  const supersedesTurnId = asString(options.turn.supersedesTurnId);
  if (supersedesTurnId) {
    const superseded = getAgentChatTurnRecord(supersedesTurnId);
    return asString(superseded?.parentTurnId);
  }

  return resolveParentTurnId({
    agentId: options.agentId,
    conversationId: options.conversationId,
    userMessageId: options.userMessageId,
    parentUserMessageId: null,
  });
}

function wouldCreateTurnCycle(turnId: string, parentTurnId: string): boolean {
  let currentId: string | null = parentTurnId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    if (currentId === turnId) return true;
    visited.add(currentId);
    const current = getAgentChatTurnRecord(currentId);
    currentId = asString(current?.parentTurnId);
  }
  return false;
}

function selectLatestConversationPath(conversationId: string): boolean {
  const messages = store
    .getAll('messages')
    .filter((message) => message.conversationId === conversationId && message.type !== 'system')
    .sort((a, b) => parseIsoDateMs(a.createdAt) - parseIsoDateMs(b.createdAt));
  const latest = messages[messages.length - 1];
  const latestId = asString(latest?.id);
  if (!latest || !latestId) return false;

  const messagesById = new Map(messages.map((message) => [String(message.id), message]));
  const targetUser =
    latest.direction === 'outbound'
      ? latest
      : findOutboundAncestorMessage(messagesById, asString(latest.parentId));
  const targetUserId = asString(targetUser?.id);
  if (!targetUser || !targetUserId) return false;

  const userLineage: StoreRecord[] = [];
  let currentUser: StoreRecord | null = targetUser;
  while (currentUser) {
    userLineage.push(currentUser);
    const previousUserMessageId = resolvePreviousUserMessageId(asString(currentUser.id));
    currentUser = previousUserMessageId ? (messagesById.get(previousUserMessageId) ?? null) : null;
  }

  const conversation = store.getById('conversations', conversationId);
  if (!conversation) return false;
  const metadata = parseConversationMetadata(conversation.metadata);
  const previousBranches =
    metadata.activeBranches &&
    typeof metadata.activeBranches === 'object' &&
    !Array.isArray(metadata.activeBranches)
      ? (metadata.activeBranches as Record<string, string>)
      : {};
  const nextBranches = { ...previousBranches };

  for (const userMessage of userLineage.reverse()) {
    const userMessageId = asString(userMessage.id);
    if (!userMessageId) continue;
    const previousUserMessageId = resolvePreviousUserMessageId(userMessageId);
    nextBranches[`user:${previousUserMessageId ?? '__root__'}`] = userMessageId;
  }
  if (latest.direction === 'inbound') {
    nextBranches[`reply:${targetUserId}`] = latestId;
  }

  if (shallowEqualRecord(previousBranches, nextBranches)) return false;
  store.update('conversations', conversationId, {
    metadata: { ...metadata, activeBranches: nextBranches },
  });
  return true;
}

function selectLatestTurnPath(conversationId: string): boolean {
  const conversation = store.getById('conversations', conversationId);
  if (!conversation) return false;
  const metadata = parseConversationMetadata(conversation.metadata);
  const agentId = asString(metadata.agentId);
  if (!agentId) return false;

  const turns = listAgentChatTurnRecordsForConversation(agentId, conversationId);
  const latest =
    [...turns].reverse().find((turn) => turn.status !== 'superseded') ??
    turns[turns.length - 1] ??
    null;
  const latestTurnId = asString(latest?.id);
  if (!latest || !latestTurnId) return false;

  const turnsById = new Map(turns.map((turn) => [String(turn.id), turn]));
  const turnLineage: StoreRecord[] = [];
  let current: StoreRecord | null = latest;
  const visited = new Set<string>();
  while (current) {
    const currentId = asString(current.id);
    if (!currentId || visited.has(currentId)) break;
    visited.add(currentId);
    turnLineage.push(current);
    const parentTurnId = asString(current.parentTurnId);
    current = parentTurnId ? (turnsById.get(parentTurnId) ?? null) : null;
  }

  const previousBranches =
    metadata.activeBranches &&
    typeof metadata.activeBranches === 'object' &&
    !Array.isArray(metadata.activeBranches)
      ? (metadata.activeBranches as Record<string, string>)
      : {};
  const nextBranches = { ...previousBranches };

  for (const turn of turnLineage.reverse()) {
    const turnId = asString(turn.id);
    const userMessageId = asString(turn.userMessageId);
    if (!turnId) continue;
    const parentTurnId = asString(turn.parentTurnId);
    const parentUserMessageId = parentTurnId
      ? asString(turnsById.get(parentTurnId)?.userMessageId)
      : null;
    nextBranches[`turn:${parentTurnId ?? '__root__'}`] = turnId;
    if (userMessageId) {
      nextBranches[`user:${parentUserMessageId ?? '__root__'}`] = userMessageId;
    }
  }

  if (shallowEqualRecord(previousBranches, nextBranches)) return false;
  store.update('conversations', conversationId, {
    metadata: { ...metadata, activeBranches: nextBranches },
  });
  return true;
}

function findOutboundAncestorMessage(
  messagesById: Map<string, StoreRecord>,
  parentId: string | null,
): StoreRecord | null {
  let currentId = parentId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const message = messagesById.get(currentId);
    if (!message) return null;
    if (message.direction === 'outbound') return message;
    currentId = asString(message.parentId);
  }
  return null;
}

function shallowEqualRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

function agentExists(agentId: string): boolean {
  return store.getById('agents', agentId) !== null;
}

function messageExists(messageId: string, conversationId: string): boolean {
  const message = store.getById('messages', messageId);
  return message?.conversationId === conversationId;
}

function findExistingLegacyTurn(options: {
  agentId: string;
  conversationId: string;
  userMessageId: string | null;
  runId: string | null;
}): StoreRecord | null {
  if (options.runId) {
    const runTurn = findAgentChatTurnRecordByRunId(options.runId);
    if (runTurn) return runTurn;
  }
  if (options.userMessageId) {
    return findAgentChatTurnRecordByUserMessage(
      options.agentId,
      options.conversationId,
      options.userMessageId,
    );
  }
  return null;
}

function resolveParentTurnId(options: {
  agentId: string;
  conversationId: string;
  userMessageId: string | null;
  parentUserMessageId: string | null;
}): string | null {
  const parentUserMessageId =
    options.parentUserMessageId ?? resolvePreviousUserMessageId(options.userMessageId);
  if (!parentUserMessageId) return null;
  const parent = findAgentChatTurnRecordByUserMessage(
    options.agentId,
    options.conversationId,
    parentUserMessageId,
  );
  return typeof parent?.id === 'string' ? (parent.id as string) : null;
}

function findRunForUserMessage(
  agentId: string,
  conversationId: string,
  userMessageId: string,
): StoreRecord | null {
  const runs = store
    .getAll('agent_runs')
    .filter(
      (run) =>
        run.agentId === agentId &&
        run.conversationId === conversationId &&
        run.triggerType === 'chat' &&
        run.responseParentId === userMessageId,
    )
    .sort((a, b) => parseIsoDateMs(a.startedAt) - parseIsoDateMs(b.startedAt));
  return runs[runs.length - 1] ?? null;
}

function resolvePreviousUserMessageId(userMessageId: string | null): string | null {
  if (!userMessageId) return null;
  const message = store.getById('messages', userMessageId);
  if (!message) return null;
  const stored = asString(message.previousUserMessageId);
  if (stored) return stored;
  return findPreviousOutboundAncestor(asString(message.conversationId), asString(message.parentId));
}

function findPreviousOutboundAncestor(
  conversationId: string | null,
  parentId: string | null,
): string | null {
  if (!conversationId || !parentId) return null;
  let currentId: string | null = parentId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const message = store.getById('messages', currentId);
    if (!message || message.conversationId !== conversationId) return null;
    if (message.direction === 'outbound' && typeof message.id === 'string') {
      return message.id as string;
    }
    currentId = asString(message.parentId);
  }
  return null;
}

function parseConversationMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function inferSupersededTurnId(options: {
  agentId: string;
  conversationId: string;
  mode: string;
  userMessageId: string | null;
}): string | null {
  if (options.mode !== 'respond_to_message' || !options.userMessageId) return null;
  const message = store.getById('messages', options.userMessageId);
  if (!message || message.direction !== 'outbound') return null;
  const siblings = store
    .getAll('messages')
    .filter(
      (candidate) =>
        candidate.id !== options.userMessageId &&
        candidate.conversationId === options.conversationId &&
        candidate.direction === 'outbound' &&
        ((candidate.parentId as string | null | undefined) ?? null) ===
          ((message.parentId as string | null | undefined) ?? null) &&
        ((candidate.previousUserMessageId as string | null | undefined) ?? null) ===
          ((message.previousUserMessageId as string | null | undefined) ?? null),
    )
    .sort((a, b) => parseIsoDateMs(a.createdAt) - parseIsoDateMs(b.createdAt));
  for (const sibling of siblings.reverse()) {
    const siblingMessageId = asString(sibling.id);
    if (!siblingMessageId) continue;
    const turn = findAgentChatTurnRecordByUserMessage(
      options.agentId,
      options.conversationId,
      siblingMessageId,
    );
    if (typeof turn?.id === 'string') return turn.id as string;
  }
  return null;
}

function findAssistantMessageForRun(
  conversationId: string,
  runId: string | null,
  userMessageId: string | null,
): string | null {
  const messages = store
    .getAll('messages')
    .filter(
      (message) => message.conversationId === conversationId && message.direction === 'inbound',
    )
    .sort((a, b) => parseIsoDateMs(a.createdAt) - parseIsoDateMs(b.createdAt));
  if (runId) {
    const byRun = messages.find(
      (message) => parseMessageMetadata(message.metadata).runId === runId,
    );
    if (typeof byRun?.id === 'string') return byRun.id as string;
  }
  if (!userMessageId) return null;
  const byParent = messages.find((message) => message.parentId === userMessageId);
  return typeof byParent?.id === 'string' ? (byParent.id as string) : null;
}

function queueStatusToTurnStatus(status: string | null): AgentChatTurnStatus {
  if (status === 'processing') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'stopped';
  return 'queued';
}

function runStatusToTurnStatus(run: StoreRecord): AgentChatTurnStatus {
  if (run.killedByUser === true || run.errorMessage === 'Killed by user') return 'stopped';
  if (run.status === 'queued') return 'queued';
  if (run.status === 'running') return 'running';
  if (run.status === 'completed') return 'completed';
  return 'failed';
}

function normalizeMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value || Array.isArray(value)) return {};
  return value;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

function parseMessageMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function parseIsoDateMs(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}
