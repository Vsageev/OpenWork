import { store } from '../connection.js';
import type { StoreRecord } from '../store.js';

export const AGENT_CHAT_TURNS_COLLECTION = 'agentChatTurns';

export type AgentChatTurnStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'superseded';

export type AgentChatTurnType = 'follow_up' | 'edit' | 'response';

export interface CreateAgentChatTurnRecord {
  id?: string;
  conversationId: string;
  agentId: string;
  parentTurnId?: string | null;
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

export function createAgentChatTurnRecord(params: CreateAgentChatTurnRecord): StoreRecord {
  return store.insert(AGENT_CHAT_TURNS_COLLECTION, {
    ...(params.id ? { id: params.id } : {}),
    conversationId: params.conversationId,
    agentId: params.agentId,
    parentTurnId: params.parentTurnId ?? null,
    userMessageId: params.userMessageId ?? null,
    assistantMessageId: params.assistantMessageId ?? null,
    status: params.status ?? 'queued',
    runId: params.runId ?? null,
    source: params.source ?? 'user',
    createdById: params.createdById ?? null,
    turnType: params.turnType ?? 'follow_up',
    supersedesTurnId: params.supersedesTurnId ?? null,
    metadata: params.metadata ?? {},
    startedAt: params.startedAt ?? null,
    completedAt: params.completedAt ?? null,
    ...(params.createdAt ? { createdAt: params.createdAt } : {}),
    ...(params.updatedAt ? { updatedAt: params.updatedAt } : {}),
  });
}

export function updateAgentChatTurnRecord(
  turnId: string,
  patch: Partial<CreateAgentChatTurnRecord>,
): StoreRecord | null {
  return store.update(AGENT_CHAT_TURNS_COLLECTION, turnId, patch as StoreRecord);
}

export function getAgentChatTurnRecord(turnId: string): StoreRecord | null {
  return store.getById(AGENT_CHAT_TURNS_COLLECTION, turnId);
}

export function listAgentChatTurnRecordsForConversation(
  agentId: string,
  conversationId: string,
): StoreRecord[] {
  return store
    .getAll(AGENT_CHAT_TURNS_COLLECTION)
    .filter((turn) => turn.agentId === agentId && turn.conversationId === conversationId)
    .sort((a, b) => parseIsoDateMs(a.createdAt) - parseIsoDateMs(b.createdAt));
}

export function findAgentChatTurnRecordByUserMessage(
  agentId: string,
  conversationId: string,
  userMessageId: string,
): StoreRecord | null {
  const matches = listAgentChatTurnRecordsForConversation(agentId, conversationId).filter(
    (turn) => turn.userMessageId === userMessageId,
  );
  return matches[matches.length - 1] ?? null;
}

export function findAgentChatTurnRecordByRunId(runId: string): StoreRecord | null {
  const matches = store
    .getAll(AGENT_CHAT_TURNS_COLLECTION)
    .filter((turn) => turn.runId === runId)
    .sort((a, b) => parseIsoDateMs(a.createdAt) - parseIsoDateMs(b.createdAt));
  return matches[matches.length - 1] ?? null;
}

function parseIsoDateMs(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}
