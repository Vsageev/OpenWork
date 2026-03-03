import { useSyncExternalStore } from 'react';
import { getAccessToken } from '../lib/api';

export type AgentChatStreamStatus = 'streaming' | 'done' | 'error';

export interface AgentChatStreamState {
  id: string;
  agentId: string;
  conversationId: string;
  status: AgentChatStreamStatus;
  text: string;
  error: string | null;
  startedAt: number;
  updatedAt: number;
  messageId: string | null;
}

interface StartAgentChatStreamParams {
  agentId: string;
  conversationId: string;
  prompt: string;
}

interface StartAgentChatRespondParams {
  agentId: string;
  conversationId: string;
}

interface StartAgentChatStreamResult {
  fullText: string;
  messageId: string | null;
}

const STREAM_RETENTION_MS = 2 * 60 * 1000;
const MAX_STREAMS = 100;
const STREAM_STORAGE_KEY = 'agent-chat-streams:v1';
const UNREAD_STORAGE_KEY = 'agent-chat-unread-conversation-ids:v1';

const listeners = new Set<() => void>();
const streamsById = new Map<string, AgentChatStreamState>();
const unreadConversationIds = new Set<string>(loadUnreadConversationIds());
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
let snapshot: AgentChatStreamState[] = [];
let unreadSnapshot: string[] = Array.from(unreadConversationIds);

function streamId(agentId: string, conversationId: string): string {
  return `${agentId}:${conversationId}`;
}

function updateSnapshot() {
  snapshot = Array.from(streamsById.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  persistStreams(snapshot);
}

function updateUnreadSnapshot() {
  unreadSnapshot = Array.from(unreadConversationIds);
  persistUnreadConversationIds(unreadSnapshot);
}

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return snapshot;
}

function getUnreadSnapshot() {
  return unreadSnapshot;
}

function loadUnreadConversationIds(): string[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(UNREAD_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

function isValidStreamStatus(value: unknown): value is AgentChatStreamStatus {
  return value === 'streaming' || value === 'done' || value === 'error';
}

function loadPersistedStreams(): AgentChatStreamState[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(STREAM_STORAGE_KEY);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const now = Date.now();
    const hydrated: AgentChatStreamState[] = [];

    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const stream = entry as Partial<AgentChatStreamState>;
      if (
        typeof stream.id !== 'string' ||
        typeof stream.agentId !== 'string' ||
        typeof stream.conversationId !== 'string' ||
        !isValidStreamStatus(stream.status) ||
        typeof stream.text !== 'string' ||
        (stream.error !== null && typeof stream.error !== 'string') ||
        typeof stream.startedAt !== 'number' ||
        typeof stream.updatedAt !== 'number' ||
        (stream.messageId !== null && typeof stream.messageId !== 'string')
      ) {
        continue;
      }

      if (now - stream.updatedAt > STREAM_RETENTION_MS) continue;

      hydrated.push({
        id: stream.id,
        agentId: stream.agentId,
        conversationId: stream.conversationId,
        status: stream.status,
        text: stream.text,
        error: stream.error ?? null,
        startedAt: stream.startedAt,
        updatedAt: stream.updatedAt,
        messageId: stream.messageId ?? null,
      });
    }

    return hydrated;
  } catch {
    return [];
  }
}

function persistStreams(streams: AgentChatStreamState[]) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(STREAM_STORAGE_KEY, JSON.stringify(streams));
  } catch {
    // Ignore storage failures (private mode / quota / security policies).
  }
}

function persistUnreadConversationIds(ids: string[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(UNREAD_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Ignore storage failures (private mode / quota / security policies).
  }
}

function evictOldestStreams() {
  if (streamsById.size <= MAX_STREAMS) return;

  // Sort all entries oldest-first; prefer evicting completed/error streams first
  const entries = Array.from(streamsById.values()).sort((a, b) => {
    const aFinished = a.status !== 'streaming' ? 0 : 1;
    const bFinished = b.status !== 'streaming' ? 0 : 1;
    if (aFinished !== bFinished) return aFinished - bFinished;
    return a.updatedAt - b.updatedAt;
  });

  const toRemove = entries.slice(0, streamsById.size - MAX_STREAMS);
  for (const s of toRemove) {
    const timer = cleanupTimers.get(s.id);
    if (timer) { clearTimeout(timer); cleanupTimers.delete(s.id); }
    streamsById.delete(s.id);
  }
}

function commitStream(next: AgentChatStreamState) {
  streamsById.set(next.id, next);
  evictOldestStreams();
  updateSnapshot();
  notify();
}

function updateStream(
  id: string,
  updater: (current: AgentChatStreamState) => AgentChatStreamState,
): AgentChatStreamState | null {
  const current = streamsById.get(id);
  if (!current) return null;
  const next = updater(current);
  streamsById.set(id, next);
  updateSnapshot();
  notify();
  return next;
}

function scheduleCleanup(id: string) {
  const existing = cleanupTimers.get(id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    cleanupTimers.delete(id);
    streamsById.delete(id);
    updateSnapshot();
    notify();
  }, STREAM_RETENTION_MS);
  cleanupTimers.set(id, timer);
}

function cancelCleanup(id: string) {
  const existing = cleanupTimers.get(id);
  if (!existing) return;
  clearTimeout(existing);
  cleanupTimers.delete(id);
}

function hydrateStreamsFromStorage() {
  const persisted = loadPersistedStreams();
  if (persisted.length === 0) return;

  const now = Date.now();
  for (const stream of persisted) {
    streamsById.set(stream.id, stream);
    const age = now - stream.updatedAt;
    const remainingMs = Math.max(0, STREAM_RETENTION_MS - age);
    if (remainingMs === 0) continue;

    const timer = setTimeout(() => {
      cleanupTimers.delete(stream.id);
      streamsById.delete(stream.id);
      updateSnapshot();
      notify();
    }, remainingMs);
    cleanupTimers.set(stream.id, timer);
  }

  updateSnapshot();
}

hydrateStreamsFromStorage();

export function useAgentChatStreams() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useAgentChatUnreadConversationIds() {
  return useSyncExternalStore(subscribe, getUnreadSnapshot, getUnreadSnapshot);
}

export function markAgentChatConversationRead(conversationId: string) {
  if (!unreadConversationIds.delete(conversationId)) return;
  updateUnreadSnapshot();
  notify();
}

export function markAgentChatConversationUnread(conversationId: string) {
  if (unreadConversationIds.has(conversationId)) return;
  unreadConversationIds.add(conversationId);
  updateUnreadSnapshot();
  notify();
}

export function getLatestStreamingAgentChatStream(): AgentChatStreamState | null {
  for (const stream of snapshot) {
    if (stream.status === 'streaming') return stream;
  }
  return null;
}

export function isAgentChatStreaming(agentId: string, conversationId: string): boolean {
  for (const stream of snapshot) {
    if (
      stream.agentId === agentId &&
      stream.conversationId === conversationId &&
      stream.status === 'streaming'
    ) {
      return true;
    }
  }
  return false;
}

export async function startAgentChatStream(
  params: StartAgentChatStreamParams,
): Promise<StartAgentChatStreamResult> {
  if (isAgentChatStreaming(params.agentId, params.conversationId)) {
    throw new Error('Agent is already processing a prompt');
  }

  const id = streamId(params.agentId, params.conversationId);
  cancelCleanup(id);
  markAgentChatConversationRead(params.conversationId);

  const startedAt = Date.now();
  commitStream({
    id,
    agentId: params.agentId,
    conversationId: params.conversationId,
    status: 'streaming',
    text: '',
    error: null,
    startedAt,
    updatedAt: startedAt,
    messageId: null,
  });

  let fullText = '';
  let messageId: string | null = null;

  try {
    const token = getAccessToken();
    const response = await fetch(`/api/agents/${params.agentId}/chat/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        prompt: params.prompt,
        conversationId: params.conversationId,
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error((body as { message?: string })?.message || `HTTP ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response stream');

    const decoder = new TextDecoder();
    let buffer = '';
    let eventType = 'message';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
          continue;
        }
        if (!line.startsWith('data: ')) continue;

        const data = line.slice(6);
        try {
          const parsed: unknown = JSON.parse(data);
          if (eventType === 'done') {
            const maybeMessageId =
              parsed && typeof parsed === 'object' && 'messageId' in parsed
                ? (parsed as { messageId?: unknown }).messageId
                : null;
            if (typeof maybeMessageId === 'string') {
              messageId = maybeMessageId;
            }
          } else if (eventType === 'error') {
            const maybeError =
              parsed && typeof parsed === 'object' && 'error' in parsed
                ? (parsed as { error?: unknown }).error
                : null;
            const errorMessage = typeof maybeError === 'string' ? maybeError : 'Agent error';

            updateStream(id, (current) => ({
              ...current,
              status: 'error',
              error: errorMessage,
              updatedAt: Date.now(),
            }));
            scheduleCleanup(id);
            throw new Error(errorMessage);
          } else if (typeof parsed === 'string') {
            fullText += parsed;
            updateStream(id, (current) => ({
              ...current,
              text: fullText,
              updatedAt: Date.now(),
            }));
          }
        } catch (err) {
          if (err instanceof Error && eventType === 'error') {
            throw err;
          }
          // Ignore malformed SSE payloads and continue parsing.
        }

        eventType = 'message';
      }
    }

    updateStream(id, (current) => ({
      ...current,
      status: 'done',
      error: null,
      messageId,
      updatedAt: Date.now(),
    }));
    markAgentChatConversationUnread(params.conversationId);
    scheduleCleanup(id);

    return { fullText: fullText.trim(), messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to send message';
    const current = streamsById.get(id);

    if (current?.status === 'streaming') {
      // Attempt reconnection via GET stream endpoint before marking as error
      try {
        const reconnected = await attemptReconnectStream(
          params.agentId,
          params.conversationId,
          id,
        );
        if (reconnected) {
          return { fullText: reconnected.fullText, messageId: reconnected.messageId };
        }
      } catch {
        // Reconnection failed, fall through to error
      }

      updateStream(id, (stream) => ({
        ...stream,
        status: 'error',
        error: message,
        updatedAt: Date.now(),
      }));
      scheduleCleanup(id);
    }

    throw err;
  }
}

async function attemptReconnectStream(
  agentId: string,
  conversationId: string,
  id: string,
): Promise<{ fullText: string; messageId: string | null } | null> {
  const token = getAccessToken();
  const response = await fetch(
    `/api/agents/${agentId}/chat/stream?conversationId=${encodeURIComponent(conversationId)}`,
    {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
  );

  if (response.status === 204) {
    // Agent not busy anymore — mark stream done and let caller refresh messages
    updateStream(id, (current) => ({
      ...current,
      status: 'done',
      updatedAt: Date.now(),
    }));
    markAgentChatConversationUnread(conversationId);
    scheduleCleanup(id);
    return { fullText: '', messageId: null };
  }

  if (!response.ok) return null;

  const reader = response.body?.getReader();
  if (!reader) return null;

  const decoder = new TextDecoder();
  let buffer = '';
  let eventType = 'message';
  let fullText = '';
  let messageId: string | null = null;

  // Reset stream text since we'll get catch-up data
  updateStream(id, (current) => ({
    ...current,
    text: '',
    updatedAt: Date.now(),
  }));

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
        continue;
      }
      if (!line.startsWith('data: ')) continue;

      const data = line.slice(6);
      try {
        const parsed: unknown = JSON.parse(data);
        if (eventType === 'done') {
          const maybeMessageId =
            parsed && typeof parsed === 'object' && 'messageId' in parsed
              ? (parsed as { messageId?: unknown }).messageId
              : null;
          if (typeof maybeMessageId === 'string') {
            messageId = maybeMessageId;
          }
        } else if (eventType === 'error') {
          const maybeError =
            parsed && typeof parsed === 'object' && 'error' in parsed
              ? (parsed as { error?: unknown }).error
              : null;
          const errorMessage = typeof maybeError === 'string' ? maybeError : 'Agent error';

          updateStream(id, (current) => ({
            ...current,
            status: 'error',
            error: errorMessage,
            updatedAt: Date.now(),
          }));
          scheduleCleanup(id);
          return null;
        } else if (typeof parsed === 'string') {
          fullText += parsed;
          updateStream(id, (current) => ({
            ...current,
            text: fullText,
            updatedAt: Date.now(),
          }));
        }
      } catch {
        // Ignore malformed SSE payloads
      }

      eventType = 'message';
    }
  }

  updateStream(id, (current) => ({
    ...current,
    status: 'done',
    error: null,
    messageId,
    updatedAt: Date.now(),
  }));
  markAgentChatConversationUnread(conversationId);
  scheduleCleanup(id);

  return { fullText: fullText.trim(), messageId };
}

/**
 * Trigger the agent to respond to the latest message already in the conversation
 * (used after an image upload — the image message is already the user's turn).
 */
export async function startAgentChatRespondStream(
  params: StartAgentChatRespondParams,
): Promise<StartAgentChatStreamResult> {
  if (isAgentChatStreaming(params.agentId, params.conversationId)) {
    throw new Error('Agent is already processing a prompt');
  }

  const id = streamId(params.agentId, params.conversationId);
  cancelCleanup(id);
  markAgentChatConversationRead(params.conversationId);

  const startedAt = Date.now();
  commitStream({
    id,
    agentId: params.agentId,
    conversationId: params.conversationId,
    status: 'streaming',
    text: '',
    error: null,
    startedAt,
    updatedAt: startedAt,
    messageId: null,
  });

  let fullText = '';
  let messageId: string | null = null;

  try {
    const token = getAccessToken();
    const response = await fetch(`/api/agents/${params.agentId}/chat/respond`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ conversationId: params.conversationId }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error((body as { message?: string })?.message || `HTTP ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response stream');

    const decoder = new TextDecoder();
    let buffer = '';
    let eventType = 'message';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
          continue;
        }
        if (!line.startsWith('data: ')) continue;

        const data = line.slice(6);
        try {
          const parsed: unknown = JSON.parse(data);
          if (eventType === 'done') {
            const maybeMessageId =
              parsed && typeof parsed === 'object' && 'messageId' in parsed
                ? (parsed as { messageId?: unknown }).messageId
                : null;
            if (typeof maybeMessageId === 'string') {
              messageId = maybeMessageId;
            }
          } else if (eventType === 'error') {
            const maybeError =
              parsed && typeof parsed === 'object' && 'error' in parsed
                ? (parsed as { error?: unknown }).error
                : null;
            const errorMessage = typeof maybeError === 'string' ? maybeError : 'Agent error';

            updateStream(id, (current) => ({
              ...current,
              status: 'error',
              error: errorMessage,
              updatedAt: Date.now(),
            }));
            scheduleCleanup(id);
            throw new Error(errorMessage);
          } else if (typeof parsed === 'string') {
            fullText += parsed;
            updateStream(id, (current) => ({
              ...current,
              text: fullText,
              updatedAt: Date.now(),
            }));
          }
        } catch (err) {
          if (err instanceof Error && eventType === 'error') {
            throw err;
          }
        }

        eventType = 'message';
      }
    }

    updateStream(id, (current) => ({
      ...current,
      status: 'done',
      error: null,
      messageId,
      updatedAt: Date.now(),
    }));
    markAgentChatConversationUnread(params.conversationId);
    scheduleCleanup(id);

    return { fullText: fullText.trim(), messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to send message';
    const current = streamsById.get(id);

    if (current?.status === 'streaming') {
      updateStream(id, (stream) => ({
        ...stream,
        status: 'error',
        error: message,
        updatedAt: Date.now(),
      }));
      scheduleCleanup(id);
    }

    throw err;
  }
}
