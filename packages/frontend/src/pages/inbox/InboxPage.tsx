import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import {
  Search,
  MessageSquare,
  Send,
  Zap,
  X,
  Archive,
  CheckCircle2,
  RotateCcw,
  User,
  Bold,
  Italic,
  Code,
  Link,
  Grid3X3,
  Plus,
  Trash2,
  Paperclip,
  FileText,
  Download,
  Play,
  MapPin,
  CheckSquare,
  Square,
  MinusSquare,
  Pin,
  PinOff,
  ArrowLeft,
  AlertTriangle,
} from 'lucide-react';
import { api, apiUpload, ApiError } from '../../lib/api';
import { toast } from '../../stores/toast';
import { CreateCardModal } from '../../ui/CreateCardModal';
import type { CreateCardData } from '../../ui/CreateCardModal';
import { getFirstImageFromClipboardData, prepareImageForUpload } from '../../lib/image-upload';
import { useAuth } from '../../stores/useAuth';
import { Tooltip } from '../../ui';
import { formatBytes } from 'shared';
import styles from './InboxPage.module.css';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useDebounce } from '../../hooks/useDebounce';

/* ── Types ── */

interface ConversationContact {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
}

interface ConversationAssignee {
  id: string;
  firstName: string;
  lastName: string | null;
}

interface Conversation {
  id: string;
  contactId: string;
  assigneeId: string | null;
  channelType: string;
  status: 'open' | 'closed' | 'archived';
  subject: string | null;
  externalId: string | null;
  isUnread: boolean;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageDirection: 'inbound' | 'outbound' | null;
  closedAt: string | null;
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
  contact: ConversationContact | null;
  assignee: ConversationAssignee | null;
}

interface MessageSender {
  id: string;
  firstName: string;
  lastName: string | null;
}

interface Message {
  id: string;
  conversationId: string;
  senderId: string | null;
  direction: 'inbound' | 'outbound';
  type: 'text' | 'image' | 'video' | 'document' | 'voice' | 'sticker' | 'location' | 'system';
  content: string | null;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  externalId: string | null;
  attachments: unknown;
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
  sender: MessageSender | null;
}

interface QuickReplyTemplate {
  id: string;
  name: string;
  content: string;
  category: string | null;
  shortcut: string | null;
  isGlobal: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface TelegramTemplate {
  id: string;
  name: string;
  content: string;
  parseMode?: string | null;
  inlineKeyboard?: InlineKeyboardButton[][] | null;
  category: string | null;
  isGlobal: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface PaginatedResponse<T> {
  total: number;
  limit: number;
  offset: number;
  entries: T[];
}

interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}

/* ── Channel labels ── */

const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  internal: 'Internal',
  other: 'Other',
  email: 'Email',
  web_chat: 'Web Chat',
};

const INBOX_REFRESH_INTERVAL_MS = 5000;
const LOCAL_INBOX_DRAFTS_KEY = 'openwork_inbox_local_drafts';

/* ── Helpers ── */

function getContactName(c: ConversationContact | null): string {
  if (!c) return 'Unknown';
  return [c.firstName, c.lastName].filter(Boolean).join(' ');
}

function getContactInitials(c: ConversationContact | null): string {
  if (!c) return '?';
  const first = c.firstName?.[0] || '';
  const last = c.lastName?.[0] || '';
  return (first + last).toUpperCase() || '?';
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'Now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHr < 24) return `${diffHr}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatMessageTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatDateGroup(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor((today.getTime() - msgDate.getTime()) / 86400000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return date.toLocaleDateString('en-US', { weekday: 'long' });
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function groupMessagesByDate(msgs: Message[]): { label: string; messages: Message[] }[] {
  const groups: { label: string; messages: Message[] }[] = [];
  let currentLabel = '';

  for (const msg of msgs) {
    const label = formatDateGroup(msg.createdAt);
    if (label !== currentLabel) {
      currentLabel = label;
      groups.push({ label, messages: [] });
    }
    groups[groups.length - 1].messages.push(msg);
  }

  return groups;
}

function areConversationListsEqual(a: Conversation[], b: Conversation[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].id !== b[i].id ||
      a[i].updatedAt !== b[i].updatedAt ||
      a[i].lastMessageAt !== b[i].lastMessageAt ||
      a[i].status !== b[i].status ||
      a[i].isUnread !== b[i].isUnread
    ) {
      return false;
    }
  }
  return true;
}

function areMessageListsEqual(a: Message[], b: Message[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].id !== b[i].id ||
      a[i].updatedAt !== b[i].updatedAt ||
      a[i].status !== b[i].status
    ) {
      return false;
    }
  }
  return true;
}

interface LocalInboxDraftMap {
  [conversationId: string]: string;
}

function readLocalInboxDrafts(): LocalInboxDraftMap {
  if (typeof window === 'undefined') return {};

  try {
    const raw = window.localStorage.getItem(LOCAL_INBOX_DRAFTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === 'string' && typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function writeLocalInboxDraft(conversationId: string, content: string) {
  if (typeof window === 'undefined') return;

  const drafts = readLocalInboxDrafts();
  if (content) {
    drafts[conversationId] = content;
  } else {
    delete drafts[conversationId];
  }

  try {
    if (Object.keys(drafts).length === 0) {
      window.localStorage.removeItem(LOCAL_INBOX_DRAFTS_KEY);
    } else {
      window.localStorage.setItem(LOCAL_INBOX_DRAFTS_KEY, JSON.stringify(drafts));
    }
  } catch {
    // Ignore storage quota and serialization failures.
  }
}

function getLocalInboxDraft(conversationId: string): string {
  return readLocalInboxDrafts()[conversationId] ?? '';
}

function clearLocalInboxDraft(conversationId: string) {
  writeLocalInboxDraft(conversationId, '');
}

/**
 * Parse message metadata to extract inline keyboard if present.
 */
function getMessageInlineKeyboard(msg: Message): InlineKeyboardButton[][] | null {
  if (!msg.metadata) return null;
  try {
    const meta = JSON.parse(msg.metadata);
    if (meta.inlineKeyboard && Array.isArray(meta.inlineKeyboard)) {
      return meta.inlineKeyboard;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Render HTML-formatted message content safely.
 * Supports Telegram HTML tags: <b>, <i>, <code>, <pre>, <a>, <s>, <u>.
 * Uses DOMPurify for proper XSS protection.
 */
function renderFormattedContent(content: string): string {
  return DOMPurify.sanitize(content, {
    ALLOWED_TAGS: ['b', 'strong', 'i', 'em', 'code', 'pre', 's', 'u', 'a'],
    ALLOWED_ATTR: ['href', 'target', 'rel'],
    ADD_ATTR: ['target', 'rel'],
  });
}

/**
 * Check if content contains HTML formatting tags.
 */
function hasHtmlFormatting(content: string): boolean {
  return /<(b|i|code|pre|a\s|s|u|strong|em)[\s>]/i.test(content);
}

/* ── Media helpers ── */

interface MessageAttachment {
  type: string;
  fileId?: string;
  fileUniqueId?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  duration?: number;
  localPath?: string;
  latitude?: number;
  longitude?: number;
  emoji?: string;
}

function getMessageAttachments(msg: Message): MessageAttachment[] {
  if (!msg.attachments) return [];
  if (Array.isArray(msg.attachments)) return msg.attachments as MessageAttachment[];
  return [];
}

function getMediaUrl(messageId: string, index: number): string {
  return `/api/media/${messageId}/${index}`;
}


function formatDuration(seconds: number | undefined): string {
  if (!seconds) return '0:00';
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

/* ── Component ── */

export function InboxPage() {
  useDocumentTitle('Inbox');
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // Conversation list state
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convsLoading, setConvsLoading] = useState(true);
  const [convsError, setConvsError] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebounce(searchInput, 300);
  const [statusFilter, setStatusFilter] = useState<string>('open');
  const [channelFilter, setChannelFilter] = useState<string>('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [markingAllRead, setMarkingAllRead] = useState(false);
  const [statusCounts, setStatusCounts] = useState<{ open: number; closed: number; archived: number; all: number }>({ open: 0, closed: 0, archived: 0, all: 0 });

  // Active conversation
  const selectedId = searchParams.get('id') || null;
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);

  // Messages state
  const [messages, setMessages] = useState<Message[]>([]);
  const [msgsLoading, setMsgsLoading] = useState(false);
  const [msgsError, setMsgsError] = useState('');

  // Reply state
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);

  // Templates state
  const [templates, setTemplates] = useState<QuickReplyTemplate[]>([]);
  const [telegramTemplates, setTelegramTemplates] = useState<TelegramTemplate[]>([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templateSearch, setTemplateSearch] = useState('');
  const [templateTab, setTemplateTab] = useState<'quick' | 'telegram'>('quick');

  // Inline keyboard builder state
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [keyboardRows, setKeyboardRows] = useState<InlineKeyboardButton[][]>([]);

  // File attachment state
  const [attachedFile, setAttachedFile] = useState<File | null>(null);

  // Draft state
  const [draftConversationIds, setDraftConversationIds] = useState<Set<string>>(new Set());
  const [draftSavedIndicator, setDraftSavedIndicator] = useState(false);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftIndicatorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedDraftRef = useRef<{ conversationId: string; content: string } | null>(null);

  // Bulk selection state
  const [selectedConvIds, setSelectedConvIds] = useState<Set<string>>(new Set());
  const [bulkActing, setBulkActing] = useState(false);

  // Pinned conversations (localStorage-based)
  const PINNED_STORAGE_KEY = 'inbox-pinned-conversations';
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('inbox-pinned-conversations');
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  });

  const togglePin = useCallback((conversationId: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) {
        next.delete(conversationId);
        toast.success('Conversation unpinned');
      } else {
        next.add(conversationId);
        toast.success('Conversation pinned');
      }
      try { localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Create card from conversation
  const [showCreateCard, setShowCreateCard] = useState(false);

  // Keyboard navigation state for conversation list
  const conversationListRef = useRef<HTMLDivElement>(null);

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const replyInputRef = useRef<HTMLTextAreaElement>(null);
  const templatesRef = useRef<HTMLDivElement>(null);
  const keyboardRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isTelegram = activeConversation?.channelType === 'telegram';

  /* ── Fetch conversations ── */
  const fetchConversations = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!silent) {
      setConvsLoading(true);
      setConvsError('');
    }
    try {
      const params = new URLSearchParams();
      params.set('limit', '100');
      if (statusFilter) params.set('status', statusFilter);
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (channelFilter) params.set('channelType', channelFilter);
      if (unreadOnly) params.set('isUnread', 'true');
      if (assignedToMe && user) params.set('assigneeId', user.id);

      const data = await api<PaginatedResponse<Conversation>>(`/conversations?${params}`);
      setConversations((prev) => (areConversationListsEqual(prev, data.entries) ? prev : data.entries));
    } catch (err) {
      if (!silent) {
        setConvsError(err instanceof ApiError ? err.message : 'Failed to load conversations');
      }
    } finally {
      if (!silent) {
        setConvsLoading(false);
      }
    }
  }, [statusFilter, debouncedSearch, channelFilter, unreadOnly, assignedToMe, user]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  /* ── Fetch status counts ── */
  const fetchStatusCounts = useCallback(async () => {
    try {
      const [openRes, closedRes, archivedRes, allRes] = await Promise.all([
        api<{ total: number }>('/conversations?status=open&countOnly=true'),
        api<{ total: number }>('/conversations?status=closed&countOnly=true'),
        api<{ total: number }>('/conversations?status=archived&countOnly=true'),
        api<{ total: number }>('/conversations?countOnly=true'),
      ]);
      setStatusCounts({ open: openRes.total, closed: closedRes.total, archived: archivedRes.total, all: allRes.total });
    } catch {
      // best-effort
    }
  }, []);

  useEffect(() => {
    fetchStatusCounts();
  }, [fetchStatusCounts]);

  /* ── Fetch drafts on mount ── */
  useEffect(() => {
    api<PaginatedResponse<{ id: string; conversationId: string }>>('/message-drafts?limit=200')
      .then((data) => {
        setDraftConversationIds(new Set(data.entries.map((d) => d.conversationId)));
      })
      .catch(() => {});
  }, []);

  /* ── Fetch messages for selected conversation ── */
  const fetchMessages = useCallback(async (conversationId: string, options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!silent) {
      setMsgsLoading(true);
      setMsgsError('');
    }
    try {
      const data = await api<PaginatedResponse<Message>>(
        `/messages?conversationId=${conversationId}&limit=200`,
      );
      // API returns newest first; reverse to show oldest at top
      const next = data.entries.reverse();
      setMessages((prev) => (areMessageListsEqual(prev, next) ? prev : next));
    } catch (err) {
      if (!silent) {
        setMsgsError(err instanceof ApiError ? err.message : 'Failed to load messages');
      }
    } finally {
      if (!silent) {
        setMsgsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setActiveConversation(null);
      setMessages([]);
      return;
    }

    // Fetch selected conversation once on selection change (fallback if list is stale).
    api<Conversation>(`/conversations/${selectedId}`)
      .then(setActiveConversation)
      .catch(() => setActiveConversation(null));

    fetchMessages(selectedId);

    // Mark as read
    api(`/conversations/${selectedId}/read`, { method: 'POST' }).catch(() => {});
  }, [selectedId, fetchMessages]);

  const loadDraftForConversation = useCallback((conversationId: string) => {
    api<PaginatedResponse<{ id: string; conversationId: string; content: string }>>(
      `/message-drafts?conversationId=${conversationId}&limit=1`,
    )
      .then((data) => {
        const draft = data.entries[0];
        const localDraft = getLocalInboxDraft(conversationId);
        setReplyText(localDraft || (draft ? draft.content : ''));
        lastSavedDraftRef.current = draft
          ? { conversationId, content: draft.content }
          : null;
      })
      .catch(() => {
        setReplyText(getLocalInboxDraft(conversationId));
        lastSavedDraftRef.current = null;
      });
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setReplyText('');
      lastSavedDraftRef.current = null;
      return;
    }

    loadDraftForConversation(selectedId);
  }, [loadDraftForConversation, selectedId]);

  useEffect(() => {
    if (!selectedId) return;

    const found = conversations.find((c) => c.id === selectedId);
    if (!found) return;

    setActiveConversation((prev) => {
      if (!prev) return found;
      if (prev.id !== found.id) return found;
      if (prev.updatedAt !== found.updatedAt || prev.lastMessageAt !== found.lastMessageAt || prev.isUnread !== found.isUnread || prev.status !== found.status) {
        return found;
      }
      return prev;
    });
  }, [selectedId, conversations]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (document.hidden) return;
      fetchConversations({ silent: true });
      fetchStatusCounts();
      if (selectedId) {
        fetchMessages(selectedId, { silent: true });
      }
    }, INBOX_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [fetchConversations, fetchMessages, fetchStatusCounts, selectedId]);

  /* ── Scroll to bottom on new messages or streaming ── */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /* ── Auto-save draft (debounced) ── */
  useEffect(() => {
    if (!selectedId) return;
    writeLocalInboxDraft(selectedId, replyText);
  }, [replyText, selectedId]);

  useEffect(() => {
    if (!selectedId) return;

    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);

    draftTimerRef.current = setTimeout(() => {
      const trimmed = replyText.trim();
      const lastSaved = lastSavedDraftRef.current;

      // Skip if nothing changed
      if (lastSaved && lastSaved.conversationId === selectedId && lastSaved.content === trimmed) return;
      if (!lastSaved && !trimmed) return;

      if (trimmed) {
        api('/message-drafts', {
          method: 'PUT',
          body: JSON.stringify({ conversationId: selectedId, content: trimmed }),
        })
          .then(() => {
            lastSavedDraftRef.current = { conversationId: selectedId, content: trimmed };
            // Flash "Draft saved" indicator
            setDraftSavedIndicator(true);
            if (draftIndicatorTimerRef.current) clearTimeout(draftIndicatorTimerRef.current);
            draftIndicatorTimerRef.current = setTimeout(() => setDraftSavedIndicator(false), 2000);
            setDraftConversationIds((prev) => {
              if (prev.has(selectedId)) return prev;
              const next = new Set(prev);
              next.add(selectedId);
              return next;
            });
          })
          .catch(() => {});
      } else {
        // Delete draft if text is empty
        api<PaginatedResponse<{ id: string; conversationId: string }>>(
          `/message-drafts?conversationId=${selectedId}&limit=1`,
        )
          .then((data) => {
            const draft = data.entries[0];
            if (draft) {
              return api(`/message-drafts/${draft.id}`, { method: 'DELETE' });
            }
          })
          .then(() => {
            lastSavedDraftRef.current = null;
            setDraftConversationIds((prev) => {
              if (!prev.has(selectedId)) return prev;
              const next = new Set(prev);
              next.delete(selectedId);
              return next;
            });
          })
          .catch(() => {});
      }
    }, 1000);

    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
  }, [replyText, selectedId]);

  /* ── Close templates popover on outside click ── */
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (templatesRef.current && !templatesRef.current.contains(e.target as Node)) {
        setTemplatesOpen(false);
        setTemplateSearch('');
      }
      if (keyboardRef.current && !keyboardRef.current.contains(e.target as Node)) {
        setKeyboardOpen(false);
      }
    }
    if (templatesOpen || keyboardOpen) {
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }
  }, [templatesOpen, keyboardOpen]);

  /* ── Sort conversations: pinned first, then by original order ── */
  const sortedConversations = useMemo(() => {
    if (pinnedIds.size === 0) return conversations;
    const pinned: Conversation[] = [];
    const unpinned: Conversation[] = [];
    for (const conv of conversations) {
      if (pinnedIds.has(conv.id)) pinned.push(conv);
      else unpinned.push(conv);
    }
    return [...pinned, ...unpinned];
  }, [conversations, pinnedIds]);

  const pinnedCount = useMemo(
    () => sortedConversations.filter((c) => pinnedIds.has(c.id)).length,
    [sortedConversations, pinnedIds],
  );



  /* ── Fetch templates when popover opens ── */
  useEffect(() => {
    if (!templatesOpen) return;
    api<PaginatedResponse<QuickReplyTemplate>>('/quick-reply-templates?limit=100')
      .then((data) => setTemplates(data.entries))
      .catch(() => setTemplates([]));
    if (isTelegram) {
      api<PaginatedResponse<TelegramTemplate>>('/telegram-message-templates?limit=100')
        .then((data) => setTelegramTemplates(data.entries))
        .catch(() => setTelegramTemplates([]));
    }
  }, [templatesOpen, isTelegram]);

  /* ── Select conversation ── */
  function selectConversation(id: string) {
    setSearchParams({ id });
    setAttachedFile(null);
    setTemplatesOpen(false);
    setTemplateSearch('');
    setKeyboardOpen(false);
    setKeyboardRows([]);
    setDraftSavedIndicator(false);
  }

  /* ── Formatting helpers ── */
  function wrapSelection(openTag: string, closeTag: string) {
    const ta = replyInputRef.current;
    if (!ta) return;

    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = replyText.substring(start, end);
    const before = replyText.substring(0, start);
    const after = replyText.substring(end);

    if (selected) {
      setReplyText(before + openTag + selected + closeTag + after);
      // Move cursor to after the closing tag
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(start + openTag.length, end + openTag.length);
      });
    } else {
      // Insert tags at cursor with cursor between them
      setReplyText(before + openTag + closeTag + after);
      requestAnimationFrame(() => {
        ta.focus();
        const pos = start + openTag.length;
        ta.setSelectionRange(pos, pos);
      });
    }
  }

  function insertBold() {
    wrapSelection('<b>', '</b>');
  }

  function insertItalic() {
    wrapSelection('<i>', '</i>');
  }

  function insertCode() {
    wrapSelection('<code>', '</code>');
  }

  function insertLink() {
    const ta = replyInputRef.current;
    if (!ta) return;

    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = replyText.substring(start, end);
    const before = replyText.substring(0, start);
    const after = replyText.substring(end);

    const linkText = selected || 'link text';
    const insertion = `<a href="url">${linkText}</a>`;
    setReplyText(before + insertion + after);

    requestAnimationFrame(() => {
      ta.focus();
      // Select the "url" part for easy replacement
      const urlStart = start + '<a href="'.length;
      const urlEnd = urlStart + 'url'.length;
      ta.setSelectionRange(urlStart, urlEnd);
    });
  }

  /* ── Inline keyboard builder ── */
  function addKeyboardRow() {
    setKeyboardRows((prev) => [...prev, [{ text: '', callback_data: '' }]]);
  }

  function addButtonToRow(rowIndex: number) {
    setKeyboardRows((prev) =>
      prev.map((row, i) =>
        i === rowIndex ? [...row, { text: '', callback_data: '' }] : row,
      ),
    );
  }

  function updateButton(rowIndex: number, btnIndex: number, field: keyof InlineKeyboardButton, value: string) {
    setKeyboardRows((prev) =>
      prev.map((row, ri) =>
        ri === rowIndex
          ? row.map((btn, bi) =>
              bi === btnIndex ? { ...btn, [field]: value } : btn,
            )
          : row,
      ),
    );
  }

  function removeButton(rowIndex: number, btnIndex: number) {
    setKeyboardRows((prev) =>
      prev
        .map((row, ri) =>
          ri === rowIndex ? row.filter((_, bi) => bi !== btnIndex) : row,
        )
        .filter((row) => row.length > 0),
    );
  }

  function removeKeyboardRow(rowIndex: number) {
    setKeyboardRows((prev) => prev.filter((_, i) => i !== rowIndex));
  }

  function getValidKeyboard(): InlineKeyboardButton[][] | undefined {
    const valid = keyboardRows
      .map((row) =>
        row.filter((btn) => btn.text.trim() && (btn.callback_data?.trim() || btn.url?.trim())),
      )
      .filter((row) => row.length > 0);

    return valid.length > 0 ? valid : undefined;
  }

  /* ── Send message ── */
  async function handleSend() {
    const hasText = replyText.trim().length > 0;
    const hasFile = attachedFile !== null;

    if ((!hasText && !hasFile) || !selectedId || sending) return;

    setSending(true);
    try {
      let msg: Message;

      if (hasFile) {
        // Upload file as media message
        const formData = new FormData();
        const uploadFile = await prepareImageForUpload(attachedFile);
        formData.append('file', uploadFile, uploadFile.name);
        formData.append('conversationId', selectedId);
        if (hasText) {
          formData.append('caption', replyText.trim());
        }

        msg = await apiUpload<Message>('/media/upload', formData);
      } else {
        // Text-only message
        const content = replyText.trim();
        const inlineKeyboard = getValidKeyboard();
        const useHtml = isTelegram && hasHtmlFormatting(content);

        const body: Record<string, unknown> = {
          conversationId: selectedId,
          direction: 'outbound',
          type: 'text',
          content,
        };

        if (useHtml) {
          body.parseMode = 'HTML';
        }

        if (inlineKeyboard) {
          body.inlineKeyboard = inlineKeyboard;
        }

        msg = await api<Message>('/messages', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }

      setMessages((prev) => [...prev, { ...msg, sender: user ? { id: user.id, firstName: user.firstName, lastName: user.lastName } : null }]);
      setReplyText('');
      setAttachedFile(null);
      setKeyboardRows([]);
      setKeyboardOpen(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      replyInputRef.current?.focus();

      // Clear draft for this conversation
      lastSavedDraftRef.current = null;
      if (selectedId) {
        clearLocalInboxDraft(selectedId);
        api<PaginatedResponse<{ id: string; conversationId: string }>>(
          `/message-drafts?conversationId=${selectedId}&limit=1`,
        )
          .then((data) => {
            const draft = data.entries[0];
            if (draft) api(`/message-drafts/${draft.id}`, { method: 'DELETE' }).catch(() => {});
          })
          .catch(() => {});
        setDraftConversationIds((prev) => {
          if (!prev.has(selectedId)) return prev;
          const next = new Set(prev);
          next.delete(selectedId);
          return next;
        });
      }

      // Update conversation in list
      setConversations((prev) =>
        prev.map((c) =>
          c.id === selectedId
            ? { ...c, lastMessageAt: new Date().toISOString(), isUnread: false }
            : c,
        ),
      );
    } catch (err) {
      const errorMsg = err instanceof ApiError ? err.message : 'Failed to send message';
      setMsgsError(errorMsg);
      toast.error(errorMsg);
    } finally {
      setSending(false);
    }
  }

  /* ── Handle keyboard in reply box ── */
  function handleReplyKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleReplyPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const imageFile = getFirstImageFromClipboardData(e.clipboardData);
    if (!imageFile) return;

    e.preventDefault();
    setAttachedFile(imageFile);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  /* ── Update conversation status ── */
  async function updateConversationStatus(status: 'open' | 'closed' | 'archived', conversationId?: string) {
    const id = conversationId ?? selectedId;
    if (!id) return;
    const prevStatus = conversations.find((c) => c.id === id)?.status;
    try {
      const updated = await api<Conversation>(`/conversations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      if (id === selectedId) {
        setActiveConversation((prev) => (prev ? { ...prev, ...updated } : prev));
      }
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, status } : c)));
      fetchStatusCounts();
      const statusLabel = status === 'open' ? 'Reopened' : status === 'closed' ? 'Closed' : 'Archived';
      toast.success(`Conversation ${statusLabel.toLowerCase()}`, {
        action: prevStatus ? {
          label: 'Undo',
          onClick: () => void updateConversationStatus(prevStatus, id),
        } : undefined,
      });
    } catch {
      toast.error('Failed to update conversation');
    }
  }

  async function toggleConversationUnread(conversationId: string) {
    const conv = conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    const newUnread = !conv.isUnread;
    try {
      await api(`/conversations/${conversationId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isUnread: newUnread }),
      });
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, isUnread: newUnread } : c)),
      );
      if (activeConversation?.id === conversationId) {
        setActiveConversation((prev) => (prev ? { ...prev, isUnread: newUnread } : prev));
      }
      toast.success(newUnread ? 'Marked as unread' : 'Marked as read');
    } catch {
      toast.error('Failed to update conversation');
    }
  }

  /* ── Select template ── */
  function selectTemplate(template: QuickReplyTemplate) {
    setReplyText(template.content);
    setTemplatesOpen(false);
    replyInputRef.current?.focus();
  }

  function selectTelegramTemplate(template: TelegramTemplate) {
    setReplyText(template.content);
    if (template.inlineKeyboard && (template.inlineKeyboard as InlineKeyboardButton[][]).length > 0) {
      setKeyboardRows(template.inlineKeyboard as InlineKeyboardButton[][]);
    }
    setTemplatesOpen(false);
    replyInputRef.current?.focus();
  }

  /* ── Filter templates ── */
  const filteredTemplates = templates.filter(
    (t) =>
      !templateSearch ||
      t.name.toLowerCase().includes(templateSearch.toLowerCase()) ||
      t.content.toLowerCase().includes(templateSearch.toLowerCase()) ||
      (t.shortcut && t.shortcut.toLowerCase().includes(templateSearch.toLowerCase())),
  );

  const filteredTelegramTemplates = telegramTemplates.filter(
    (t) =>
      !templateSearch ||
      t.name.toLowerCase().includes(templateSearch.toLowerCase()) ||
      t.content.toLowerCase().includes(templateSearch.toLowerCase()),
  );

  /* ── Mark all conversations as read ── */
  async function handleMarkAllRead() {
    if (markingAllRead) return;
    setMarkingAllRead(true);
    try {
      await api('/conversations/read-all', { method: 'POST' });
      setConversations((prev) => prev.map((c) => ({ ...c, isUnread: false })));
      toast.success('All conversations marked as read');
    } catch {
      toast.error('Failed to mark conversations as read');
    } finally {
      setMarkingAllRead(false);
    }
  }

  /* ── Create card from conversation ── */
  async function handleCreateCard(data: CreateCardData) {
    if (!activeConversation || !data.collectionId) return;
    const card = await api<{ id: string }>('/cards', {
      method: 'POST',
      body: JSON.stringify({
        collectionId: data.collectionId,
        name: data.name,
        description: data.description,
        assigneeId: data.assigneeId,
      }),
    });
    await Promise.all([
      ...data.tagIds.map((tagId) =>
        api(`/cards/${card.id}/tags`, { method: 'POST', body: JSON.stringify({ tagId }) }),
      ),
      ...data.linkedCardIds.map((targetCardId) =>
        api(`/cards/${card.id}/links`, { method: 'POST', body: JSON.stringify({ targetCardId }) }),
      ),
    ]);
    // Post a comment linking back to the source conversation
    const contactName = getContactName(activeConversation.contact);
    const conversationRef = activeConversation.subject
      ? `"${activeConversation.subject}"`
      : `conversation with ${contactName}`;
    await api(`/cards/${card.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        content: `Created from ${conversationRef} in Inbox.\n\n[View conversation](/inbox?id=${activeConversation.id})`,
      }),
    }).catch(() => {/* best-effort */});
    setShowCreateCard(false);
    toast.success('Card created from conversation', {
      action: { label: 'Open card', onClick: () => { window.location.href = `/cards/${card.id}`; } },
    });
  }

  /* ── Bulk selection helpers ── */
  function toggleConvSelection(id: string) {
    setSelectedConvIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllConversations() {
    setSelectedConvIds(new Set(sortedConversations.map((c) => c.id)));
  }

  function deselectAll() {
    setSelectedConvIds(new Set());
  }

  const allSelected = sortedConversations.length > 0 && selectedConvIds.size === sortedConversations.length;
  const someSelected = selectedConvIds.size > 0 && !allSelected;

  async function bulkUpdateStatus(status: 'open' | 'closed' | 'archived') {
    if (bulkActing || selectedConvIds.size === 0) return;
    const count = selectedConvIds.size;
    setBulkActing(true);
    try {
      await Promise.all(
        [...selectedConvIds].map((cid) =>
          api(`/conversations/${cid}`, {
            method: 'PATCH',
            body: JSON.stringify({ status }),
          }),
        ),
      );
      setConversations((prev) =>
        prev.map((c) => (selectedConvIds.has(c.id) ? { ...c, status } : c)),
      );
      if (selectedId && selectedConvIds.has(selectedId)) {
        setActiveConversation((prev) => (prev ? { ...prev, status } : prev));
      }
      fetchStatusCounts();
      deselectAll();
      const statusLabel = status === 'open' ? 'reopened' : status === 'closed' ? 'closed' : 'archived';
      toast.success(`${count} conversation${count > 1 ? 's' : ''} ${statusLabel}`);
    } catch {
      toast.error('Failed to update conversations');
    } finally {
      setBulkActing(false);
    }
  }

  async function bulkMarkRead() {
    if (bulkActing || selectedConvIds.size === 0) return;
    const count = selectedConvIds.size;
    setBulkActing(true);
    try {
      await Promise.all(
        [...selectedConvIds].map((cid) =>
          api(`/conversations/${cid}/read`, { method: 'POST' }),
        ),
      );
      setConversations((prev) =>
        prev.map((c) => (selectedConvIds.has(c.id) ? { ...c, isUnread: false } : c)),
      );
      deselectAll();
      toast.success(`${count} conversation${count > 1 ? 's' : ''} marked as read`);
    } catch {
      toast.error('Failed to mark conversations as read');
    } finally {
      setBulkActing(false);
    }
  }

  async function bulkDelete() {
    if (bulkActing || selectedConvIds.size === 0) return;
    const count = selectedConvIds.size;
    if (!window.confirm(`Delete ${count} conversation${count > 1 ? 's' : ''}? This cannot be undone.`)) return;
    setBulkActing(true);
    try {
      await Promise.all(
        [...selectedConvIds].map((cid) =>
          api(`/conversations/${cid}`, { method: 'DELETE' }),
        ),
      );
      setConversations((prev) => prev.filter((c) => !selectedConvIds.has(c.id)));
      if (selectedId && selectedConvIds.has(selectedId)) {
        setSearchParams({});
      }
      fetchStatusCounts();
      deselectAll();
      toast.success(`${count} conversation${count > 1 ? 's' : ''} deleted`);
    } catch {
      toast.error('Failed to delete conversations');
    } finally {
      setBulkActing(false);
    }
  }

  // Clear selection when filters change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    deselectAll();
  }, [statusFilter, debouncedSearch, channelFilter, unreadOnly, assignedToMe]);

  /* ── Render ── */

  const dateGroups = groupMessagesByDate(messages);

  return (
    <>
    <div className={styles.wrapper}>
      <div className={styles.container}>
        {/* ── Left: Conversation list ── */}
        <div className={`${styles.sidebar}${selectedId ? ` ${styles.sidebarHidden}` : ''}`}>
          <div className={styles.sidebarHeader}>
            {selectedConvIds.size > 0 ? (
              <div className={styles.bulkBar}>
                <button
                  className={styles.bulkSelectToggle}
                  onClick={allSelected ? deselectAll : selectAllConversations}
                  title={allSelected ? 'Deselect all' : 'Select all'}
                >
                  {allSelected ? <CheckSquare size={16} /> : someSelected ? <MinusSquare size={16} /> : <Square size={16} />}
                </button>
                <span className={styles.bulkCount}>{selectedConvIds.size} selected</span>
                <div className={styles.bulkActions}>
                  <Tooltip label="Mark read">
                    <button className={styles.bulkBtn} onClick={() => { void bulkMarkRead(); }} disabled={bulkActing}>
                      <CheckCircle2 size={14} />
                    </button>
                  </Tooltip>
                  <Tooltip label="Close">
                    <button className={styles.bulkBtn} onClick={() => { void bulkUpdateStatus('closed'); }} disabled={bulkActing}>
                      <X size={14} />
                    </button>
                  </Tooltip>
                  <Tooltip label="Archive">
                    <button className={styles.bulkBtn} onClick={() => { void bulkUpdateStatus('archived'); }} disabled={bulkActing}>
                      <Archive size={14} />
                    </button>
                  </Tooltip>
                  <Tooltip label="Reopen">
                    <button className={styles.bulkBtn} onClick={() => { void bulkUpdateStatus('open'); }} disabled={bulkActing}>
                      <RotateCcw size={14} />
                    </button>
                  </Tooltip>
                  <Tooltip label="Delete">
                    <button className={`${styles.bulkBtn} ${styles.bulkBtnDanger}`} onClick={() => { void bulkDelete(); }} disabled={bulkActing}>
                      <Trash2 size={14} />
                    </button>
                  </Tooltip>
                </div>
                <button className={styles.bulkDismiss} onClick={deselectAll} title="Cancel selection">
                  <X size={14} />
                </button>
              </div>
            ) : (
              <>
                <span className={styles.sidebarTitle}>Inbox</span>
                {sortedConversations.some((c) => c.isUnread) && (
                  <button
                    className={styles.markAllReadBtn}
                    onClick={() => { void handleMarkAllRead(); }}
                    disabled={markingAllRead}
                    title="Mark all as read"
                  >
                    <CheckCircle2 size={14} />
                    <span>{markingAllRead ? 'Marking…' : 'Mark all read'}</span>
                  </button>
                )}
              </>
            )}
          </div>

          <div className={styles.statusTabs}>
            {([
              { value: 'open', label: 'Open', count: statusCounts.open },
              { value: 'closed', label: 'Closed', count: statusCounts.closed },
              { value: 'archived', label: 'Archived', count: statusCounts.archived },
              { value: '', label: 'All', count: statusCounts.all },
            ] as const).map((tab) => (
              <button
                key={tab.value}
                className={`${styles.statusTab}${statusFilter === tab.value ? ` ${styles.statusTabActive}` : ''}`}
                onClick={() => setStatusFilter(tab.value)}
              >
                {tab.label}
                {tab.count > 0 && <span className={styles.statusTabCount}>{tab.count}</span>}
              </button>
            ))}
          </div>

          <div className={styles.filterRow}>
            <div className={`${styles.searchWrap} ${styles.searchWrapFullRow}`}>
              <Search size={14} className={styles.searchIcon} />
              <input
                type="text"
                placeholder="Search conversations..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className={styles.searchInput}
              />
              {searchInput && (
                <button
                  className={styles.searchClear}
                  onClick={() => setSearchInput('')}
                  aria-label="Clear search"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value)}
              className={styles.channelFilterSelect}
            >
              <option value="">All channels</option>
              <option value="email">Email</option>
              <option value="web_chat">Web Chat</option>
              <option value="telegram">Telegram</option>
              <option value="internal">Internal</option>
              <option value="other">Other</option>
            </select>
            <button
              type="button"
              className={[styles.unreadFilterBtn, unreadOnly && styles.unreadFilterBtnActive].filter(Boolean).join(' ')}
              onClick={() => setUnreadOnly((v) => !v)}
              title="Show unread only"
            >
              Unread
            </button>
            <button
              type="button"
              className={[styles.unreadFilterBtn, assignedToMe && styles.unreadFilterBtnActive].filter(Boolean).join(' ')}
              onClick={() => setAssignedToMe((v) => !v)}
              title="Show only conversations assigned to me"
            >
              Mine
            </button>
          </div>

          <div className={styles.conversationList} ref={conversationListRef}>
            {convsLoading ? (
              <div className={styles.convSkeletonList}>
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className={styles.convSkeleton}>
                    <div className={styles.convSkeletonAvatar} />
                    <div className={styles.convSkeletonLines}>
                      <div className={styles.convSkeletonLine} style={{ width: i % 2 === 0 ? '60%' : '45%' }} />
                      <div className={styles.convSkeletonLine} style={{ width: i % 2 === 0 ? '80%' : '70%' }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : convsError ? (
              <div className={styles.errorState}>{convsError}</div>
            ) : sortedConversations.length === 0 ? (
              <div className={styles.emptyPanel}>
                {(debouncedSearch || channelFilter || unreadOnly || assignedToMe) ? (
                  <>
                    <Search size={36} className={styles.emptyIcon} />
                    <span className={styles.emptyTitle}>No matching conversations</span>
                    <div className={styles.activeFilters}>
                      {debouncedSearch && <span className={styles.activeFilterChip}>Search: &ldquo;{debouncedSearch}&rdquo;</span>}
                      {channelFilter && <span className={styles.activeFilterChip}>{CHANNEL_LABELS[channelFilter] || channelFilter}</span>}
                      {statusFilter && statusFilter !== 'open' && <span className={styles.activeFilterChip}>Status: {statusFilter}</span>}
                      {statusFilter === '' && <span className={styles.activeFilterChip}>All statuses</span>}
                      {unreadOnly && <span className={styles.activeFilterChip}>Unread only</span>}
                      {assignedToMe && <span className={styles.activeFilterChip}>Assigned to me</span>}
                    </div>
                    <button
                      className={styles.clearFiltersBtn}
                      onClick={() => {
                        setSearchInput('');
                        setChannelFilter('');
                        setStatusFilter('open');
                        setUnreadOnly(false);
                        setAssignedToMe(false);
                      }}
                    >
                      <RotateCcw size={13} />
                      Reset filters
                    </button>
                  </>
                ) : statusFilter === 'closed' ? (
                  <>
                    <CheckCircle2 size={36} className={styles.emptyIcon} />
                    <span className={styles.emptyTitle}>No closed conversations</span>
                    <span className={styles.emptyText}>
                      Conversations you close will appear here for reference.
                    </span>
                  </>
                ) : statusFilter === 'archived' ? (
                  <>
                    <Archive size={36} className={styles.emptyIcon} />
                    <span className={styles.emptyTitle}>No archived conversations</span>
                    <span className={styles.emptyText}>
                      Archived conversations are stored here for long-term record keeping.
                    </span>
                  </>
                ) : statusFilter === '' ? (
                  <>
                    <MessageSquare size={40} className={styles.emptyIcon} />
                    <span className={styles.emptyTitle}>No conversations yet</span>
                    <span className={styles.emptyText}>
                      Conversations will appear here when contacts reach out or you start a new chat.
                    </span>
                  </>
                ) : (
                  <>
                    <MessageSquare size={40} className={styles.emptyIcon} />
                    <span className={styles.emptyTitle}>No conversations yet</span>
                    <span className={styles.emptyText}>
                      Conversations will appear here when contacts reach out or you start a new chat.
                    </span>
                  </>
                )}
              </div>
            ) : (
              sortedConversations.map((conv, index) => {
                const isActive = conv.id === selectedId;
                const isFocused = false;
                const isChecked = selectedConvIds.has(conv.id);
                const isPinned = pinnedIds.has(conv.id);
                const showPinnedSeparator = pinnedCount > 0 && index === pinnedCount;
                const cls = [
                  styles.conversationItem,
                  isActive && styles.conversationItemActive,
                  isFocused && styles.conversationItemFocused,
                  conv.isUnread && styles.conversationItemUnread,
                  isChecked && styles.conversationItemChecked,
                  isPinned && styles.conversationItemPinned,
                ]
                  .filter(Boolean)
                  .join(' ');

                return (
                  <div key={conv.id}>
                    {showPinnedSeparator && (
                      <div className={styles.pinnedSeparator}>
                        <span className={styles.pinnedSeparatorLine} />
                      </div>
                    )}
                    <div
                      className={cls}
                      data-conv-item
                      onClick={(e) => {
                        if (e.shiftKey || selectedConvIds.size > 0) {
                          e.preventDefault();
                          toggleConvSelection(conv.id);
                        } else {
                          selectConversation(conv.id);
                        }
                      }}
                    >
                      <button
                        className={[
                          styles.convCheckbox,
                          isChecked && styles.convCheckboxChecked,
                          selectedConvIds.size > 0 && styles.convCheckboxVisible,
                        ].filter(Boolean).join(' ')}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleConvSelection(conv.id);
                        }}
                        aria-label={isChecked ? 'Deselect conversation' : 'Select conversation'}
                      >
                        {isChecked ? <CheckSquare size={16} /> : <Square size={16} />}
                      </button>
                      <span className={styles.convAvatar}>
                        {getContactInitials(conv.contact)}
                      </span>
                      <div className={styles.convContent}>
                        <div className={styles.convHeader}>
                          <span className={styles.convName}>
                            {isPinned && <Pin size={11} className={styles.pinnedIcon} />}
                            {getContactName(conv.contact)}
                          </span>
                          <span className={styles.convTime} title={new Date(conv.lastMessageAt || conv.createdAt).toLocaleString()}>
                            {formatRelativeTime(conv.lastMessageAt || conv.createdAt)}
                          </span>
                        </div>
                        {conv.subject && (
                          <div className={styles.convSubject}>{conv.subject}</div>
                        )}
                        <div className={styles.convFooter}>
                          <span className={styles.convPreview}>
                            {conv.lastMessagePreview
                              ? (conv.lastMessageDirection === 'outbound' ? 'You: ' : '') + conv.lastMessagePreview
                              : conv.subject || CHANNEL_LABELS[conv.channelType] || conv.channelType}
                          </span>
                          <span className={styles.channelBadge}>
                            {CHANNEL_LABELS[conv.channelType] || conv.channelType}
                          </span>
                          {conv.assignee && (
                            <span className={styles.convAssigneeBadge} title={`Assigned to ${conv.assignee.firstName} ${conv.assignee.lastName ?? ''}`}>
                              {conv.assignee.firstName[0]}{conv.assignee.lastName?.[0] ?? ''}
                            </span>
                          )}
                          {conv.isUnread && <span className={styles.unreadDot} />}
                          {draftConversationIds.has(conv.id) && <span className={styles.draftBadge}>Draft</span>}
                        </div>
                      </div>
                      <button
                        className={[
                          styles.convPinBtn,
                          isPinned && styles.convPinBtnActive,
                        ].filter(Boolean).join(' ')}
                        onClick={(e) => {
                          e.stopPropagation();
                          togglePin(conv.id);
                        }}
                        title={isPinned ? 'Unpin conversation' : 'Pin conversation'}
                        aria-label={isPinned ? 'Unpin conversation' : 'Pin conversation'}
                      >
                        {isPinned ? <PinOff size={13} /> : <Pin size={13} />}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ── Right: Thread view ── */}
        {selectedId && activeConversation ? (
          <div className={styles.threadPanel}>
            {/* Thread header */}
            <div className={styles.threadHeader}>
              <button
                className={styles.backBtn}
                onClick={() => setSearchParams({})}
                aria-label="Back to conversations"
              >
                <ArrowLeft size={18} />
              </button>
              <div className={styles.threadContactInfo}>
                <span className={styles.threadAvatar}>
                  {getContactInitials(activeConversation.contact)}
                </span>
                <div>
                  <div className={styles.threadContactName}>
                    {getContactName(activeConversation.contact)}
                  </div>
                  {(activeConversation.contact?.email || activeConversation.contact?.phone) && (
                    <div className={styles.threadContactMeta}>
                      {activeConversation.contact.email && (
                        <span className={styles.threadContactEmail}>
                          {activeConversation.contact.email}
                        </span>
                      )}
                      {activeConversation.contact.phone && (
                        <span className={styles.threadContactPhone}>
                          {activeConversation.contact.phone}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {activeConversation.assignee && (
                <div className={styles.threadAssigneeBadge}>
                  <User size={11} />
                  {activeConversation.assignee.firstName} {activeConversation.assignee.lastName ?? ''}
                </div>
              )}
              <div className={styles.threadActions}>
                <Tooltip label="Create card from conversation">
                  <button
                    className={styles.iconBtn}
                    onClick={() => setShowCreateCard(true)}
                    aria-label="Create card from conversation"
                  >
                    <FileText size={16} />
                  </button>
                </Tooltip>
                <Tooltip label={`${pinnedIds.has(activeConversation.id) ? 'Unpin' : 'Pin'} conversation (P)`}>
                  <button
                    className={`${styles.iconBtn}${pinnedIds.has(activeConversation.id) ? ` ${styles.iconBtnActive}` : ''}`}
                    onClick={() => togglePin(activeConversation.id)}
                  >
                    {pinnedIds.has(activeConversation.id) ? <PinOff size={16} /> : <Pin size={16} />}
                  </button>
                </Tooltip>
                <Tooltip label={`${activeConversation.isUnread ? 'Mark read' : 'Mark unread'} (U)`}>
                  <button
                    className={styles.iconBtn}
                    onClick={() => void toggleConversationUnread(activeConversation.id)}
                  >
                    <MessageSquare size={16} />
                  </button>
                </Tooltip>
                {activeConversation.status === 'open' ? (
                  <>
                    <Tooltip label="Close conversation (X)">
                      <button
                        className={styles.iconBtn}
                        onClick={() => updateConversationStatus('closed')}
                      >
                        <CheckCircle2 size={16} />
                      </button>
                    </Tooltip>
                    <Tooltip label="Archive conversation (E)">
                      <button
                        className={styles.iconBtn}
                        onClick={() => updateConversationStatus('archived')}
                      >
                        <Archive size={16} />
                      </button>
                    </Tooltip>
                  </>
                ) : (
                  <Tooltip label="Reopen conversation (X)">
                    <button
                      className={styles.iconBtn}
                      onClick={() => updateConversationStatus('open')}
                    >
                      <RotateCcw size={16} />
                    </button>
                  </Tooltip>
                )}
              </div>
            </div>

            {/* Messages area */}
            <div className={styles.messagesArea}>
              {msgsLoading ? (
                <div className={styles.msgSkeletonList}>
                  {[
                    { dir: 'in', w: 220, h: 38 },
                    { dir: 'in', w: 180, h: 52 },
                    { dir: 'out', w: 200, h: 38 },
                    { dir: 'in', w: 260, h: 38 },
                    { dir: 'out', w: 240, h: 52 },
                    { dir: 'out', w: 160, h: 38 },
                    { dir: 'in', w: 200, h: 66 },
                  ].map((s, i) => (
                    <div
                      key={i}
                      className={`${styles.msgSkeleton} ${s.dir === 'in' ? styles.msgSkeletonInbound : styles.msgSkeletonOutbound}`}
                    >
                      <div
                        className={styles.msgSkeletonBubble}
                        style={{ width: s.w, height: s.h, animationDelay: `${i * 0.08}s` }}
                      />
                      <div className={styles.msgSkeletonMeta} />
                    </div>
                  ))}
                </div>
              ) : msgsError ? (
                <div className={styles.errorState}>{msgsError}</div>
              ) : messages.length === 0 ? (
                <div className={styles.emptyPanel}>
                  <MessageSquare size={32} className={styles.emptyIcon} />
                  <span className={styles.emptyText}>No messages yet. Start the conversation!</span>
                </div>
              ) : (
                dateGroups.map((group) => (
                  <div key={group.label} className={styles.dateGroupContainer}>
                    <div className={styles.dateGroup}>
                      <span className={styles.dateLine} />
                      <span className={styles.dateLabel}>{group.label}</span>
                      <span className={styles.dateLine} />
                    </div>
                    {group.messages.map((msg) => {
                      if (msg.type === 'system') {
                        const meta = msg.metadata ? (() => { try { return JSON.parse(msg.metadata); } catch { return null; } })() : null;
                        if (meta?.fallbackRetry) {
                          return (
                            <div key={msg.id} className={styles.fallbackNotice}>
                              <AlertTriangle size={14} />
                              <span>Model error — switched to <strong>{meta.fallbackModel ?? 'fallback'}</strong></span>
                            </div>
                          );
                        }
                        return (
                          <div key={msg.id} className={styles.systemMessage}>
                            {msg.content}
                          </div>
                        );
                      }

                      const bubbleCls = [
                        styles.messageBubble,
                        msg.direction === 'inbound'
                          ? styles.messageInbound
                          : styles.messageOutbound,
                      ].join(' ');

                      const senderName =
                        msg.direction === 'outbound'
                          ? 'You'
                          : msg.sender
                            ? [msg.sender.firstName, msg.sender.lastName]
                                .filter(Boolean)
                                .join(' ')
                            : getContactName(activeConversation.contact);

                      const inlineKb = getMessageInlineKeyboard(msg);
                      const contentHtml = msg.content && hasHtmlFormatting(msg.content);

                      const attachments = getMessageAttachments(msg);

                      return (
                        <div key={msg.id} className={bubbleCls}>
                          {/* Media attachments */}
                          {attachments.length > 0 && (
                            <div className={styles.attachmentsArea}>
                              {attachments.map((att, ai) => {
                                const mediaUrl = getMediaUrl(msg.id, ai);

                                if (att.type === 'photo') {
                                  return (
                                    <a key={ai} href={mediaUrl} target="_blank" rel="noopener noreferrer" className={styles.mediaImageLink}>
                                      <img
                                        src={mediaUrl}
                                        alt="Photo"
                                        className={styles.mediaImage}
                                        loading="lazy"
                                      />
                                    </a>
                                  );
                                }

                                if (att.type === 'video') {
                                  return (
                                    <div key={ai} className={styles.mediaVideo}>
                                      <video
                                        src={mediaUrl}
                                        controls
                                        preload="metadata"
                                        className={styles.mediaVideoPlayer}
                                      />
                                      {att.duration != null && (
                                        <span className={styles.mediaDuration}>{formatDuration(att.duration)}</span>
                                      )}
                                    </div>
                                  );
                                }

                                if (att.type === 'voice') {
                                  return (
                                    <div key={ai} className={styles.mediaVoice}>
                                      <Play size={14} className={styles.mediaVoiceIcon} />
                                      <audio src={mediaUrl} controls preload="metadata" className={styles.mediaAudioPlayer} />
                                      {att.duration != null && (
                                        <span className={styles.mediaDuration}>{formatDuration(att.duration)}</span>
                                      )}
                                    </div>
                                  );
                                }

                                if (att.type === 'sticker') {
                                  return (
                                    <img
                                      key={ai}
                                      src={mediaUrl}
                                      alt={att.emoji || 'Sticker'}
                                      className={styles.mediaSticker}
                                      loading="lazy"
                                    />
                                  );
                                }

                                if (att.type === 'location') {
                                  return (
                                    <div key={ai} className={styles.mediaLocation}>
                                      <MapPin size={16} />
                                      <span>{att.latitude}, {att.longitude}</span>
                                    </div>
                                  );
                                }

                                // Document / audio / other files
                                return (
                                  <a
                                    key={ai}
                                    href={mediaUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={styles.mediaDocument}
                                  >
                                    <FileText size={18} className={styles.mediaDocIcon} />
                                    <div className={styles.mediaDocInfo}>
                                      <span className={styles.mediaDocName}>{att.fileName || 'Document'}</span>
                                      {att.fileSize && (
                                        <span className={styles.mediaDocSize}>{formatBytes(att.fileSize)}</span>
                                      )}
                                    </div>
                                    <Download size={14} className={styles.mediaDocDownload} />
                                  </a>
                                );
                              })}
                            </div>
                          )}
                          {/* Text content */}
                          {msg.content && contentHtml ? (
                            <div
                              className={styles.formattedContent}
                              dangerouslySetInnerHTML={{
                                __html: renderFormattedContent(msg.content),
                              }}
                            />
                          ) : msg.content ? (
                            <div>{msg.content}</div>
                          ) : null}
                          {inlineKb && (
                            <div className={styles.inlineKeyboardDisplay}>
                              {inlineKb.map((row, ri) => (
                                <div key={ri} className={styles.inlineKeyboardRow}>
                                  {row.map((btn, bi) => (
                                    btn.url ? (
                                      <a
                                        key={bi}
                                        href={btn.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className={styles.inlineKeyboardBtn}
                                      >
                                        {btn.text}
                                      </a>
                                    ) : (
                                      <span key={bi} className={styles.inlineKeyboardBtn}>
                                        {btn.text}
                                      </span>
                                    )
                                  ))}
                                </div>
                              ))}
                            </div>
                          )}
                          <div className={styles.messageMeta}>
                            <span>{senderName}</span>
                            <span title={new Date(msg.createdAt).toLocaleString()}>{formatMessageTime(msg.createdAt)}</span>
                            {msg.direction === 'outbound' && (
                              <span className={styles.messageStatus}>
                                {msg.status === 'read'
                                  ? '✓✓'
                                  : msg.status === 'delivered'
                                    ? '✓✓'
                                    : msg.status === 'sent'
                                      ? '✓'
                                      : msg.status === 'failed'
                                        ? '✗'
                                        : '⏳'}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Reply box */}
            <div className={styles.replyBox}>
              {/* Formatting toolbar — only for Telegram conversations */}
              {isTelegram && (
                <div className={styles.formattingToolbar}>
                  <Tooltip label="Bold" position="bottom">
                    <button
                      className={styles.fmtBtn}
                      onClick={insertBold}
                      type="button"
                    >
                      <Bold size={14} />
                    </button>
                  </Tooltip>
                  <Tooltip label="Italic" position="bottom">
                    <button
                      className={styles.fmtBtn}
                      onClick={insertItalic}
                      type="button"
                    >
                      <Italic size={14} />
                    </button>
                  </Tooltip>
                  <Tooltip label="Code" position="bottom">
                    <button
                      className={styles.fmtBtn}
                      onClick={insertCode}
                      type="button"
                    >
                      <Code size={14} />
                    </button>
                  </Tooltip>
                  <Tooltip label="Insert link" position="bottom">
                    <button
                      className={styles.fmtBtn}
                      onClick={insertLink}
                      type="button"
                    >
                      <Link size={14} />
                    </button>
                  </Tooltip>
                  <span className={styles.fmtSep} />
                  <div className={styles.keyboardAnchor} ref={keyboardRef}>
                    <Tooltip label="Inline keyboard" position="bottom">
                      <button
                        className={[
                          styles.fmtBtn,
                          keyboardRows.length > 0 ? styles.fmtBtnActive : '',
                        ].join(' ')}
                        onClick={() => setKeyboardOpen((v) => !v)}
                        type="button"
                      >
                        <Grid3X3 size={14} />
                      </button>
                    </Tooltip>
                    {keyboardOpen && (
                      <div className={styles.keyboardPopover}>
                        <div className={styles.keyboardPopoverHeader}>
                          <span className={styles.templatesTitle}>Inline Keyboard</span>
                          <button
                            className={styles.iconBtn}
                            onClick={() => setKeyboardOpen(false)}
                            style={{ border: 'none', width: 24, height: 24 }}
                            type="button"
                          >
                            <X size={14} />
                          </button>
                        </div>
                        <div className={styles.keyboardPopoverBody}>
                          {keyboardRows.length === 0 ? (
                            <div className={styles.keyboardEmpty}>
                              No buttons yet. Add a row to get started.
                            </div>
                          ) : (
                            keyboardRows.map((row, ri) => (
                              <div key={ri} className={styles.keyboardRowEditor}>
                                <div className={styles.keyboardRowLabel}>
                                  <span>Row {ri + 1}</span>
                                  <Tooltip label="Remove row">
                                    <button
                                      className={styles.keyboardRemoveRow}
                                      onClick={() => removeKeyboardRow(ri)}
                                      type="button"
                                    >
                                      <Trash2 size={12} />
                                    </button>
                                  </Tooltip>
                                </div>
                                {row.map((btn, bi) => (
                                  <div key={bi} className={styles.keyboardBtnEditor}>
                                    <input
                                      type="text"
                                      placeholder="Button text"
                                      value={btn.text}
                                      onChange={(e) => updateButton(ri, bi, 'text', e.target.value)}
                                      className={styles.keyboardInput}
                                    />
                                    <input
                                      type="text"
                                      placeholder="Callback data or URL"
                                      value={btn.url || btn.callback_data || ''}
                                      onChange={(e) => {
                                        const val = e.target.value;
                                        if (val.startsWith('http://') || val.startsWith('https://')) {
                                          updateButton(ri, bi, 'url', val);
                                          updateButton(ri, bi, 'callback_data', '');
                                        } else {
                                          updateButton(ri, bi, 'callback_data', val);
                                          updateButton(ri, bi, 'url', '');
                                        }
                                      }}
                                      className={styles.keyboardInput}
                                    />
                                    <Tooltip label="Remove button">
                                      <button
                                        className={styles.keyboardRemoveBtn}
                                        onClick={() => removeButton(ri, bi)}
                                        type="button"
                                      >
                                        <X size={12} />
                                      </button>
                                    </Tooltip>
                                  </div>
                                ))}
                                <button
                                  className={styles.keyboardAddBtn}
                                  onClick={() => addButtonToRow(ri)}
                                  type="button"
                                >
                                  <Plus size={12} /> Add button
                                </button>
                              </div>
                            ))
                          )}
                          <button
                            className={styles.keyboardAddRow}
                            onClick={addKeyboardRow}
                            type="button"
                          >
                            <Plus size={14} /> Add row
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  {keyboardRows.length > 0 && (
                    <span className={styles.fmtHint}>
                      {keyboardRows.reduce((sum, r) => sum + r.length, 0)} button(s)
                    </span>
                  )}
                </div>
              )}

              <div className={styles.replyRow}>
                <div className={styles.templatesAnchor} ref={templatesRef}>
                  <Tooltip label="Quick replies">
                    <button
                      className={styles.iconBtn}
                      onClick={() => setTemplatesOpen((v) => !v)}
                    >
                      <Zap size={16} />
                    </button>
                  </Tooltip>
                  {templatesOpen && (
                    <div className={styles.templatesPopover}>
                      <div className={styles.templatesHeader}>
                        <span className={styles.templatesTitle}>Templates</span>
                        <Tooltip label="Close">
                          <button
                            className={styles.iconBtn}
                            onClick={() => setTemplatesOpen(false)}
                            style={{ border: 'none', width: 24, height: 24 }}
                          >
                            <X size={14} />
                          </button>
                        </Tooltip>
                      </div>
                      {isTelegram && (
                        <div className={styles.templatesTabs}>
                          <button
                            className={[styles.templatesTabBtn, templateTab === 'quick' && styles.templatesTabBtnActive].filter(Boolean).join(' ')}
                            onClick={() => setTemplateTab('quick')}
                          >
                            Quick Replies
                          </button>
                          <button
                            className={[styles.templatesTabBtn, templateTab === 'telegram' && styles.templatesTabBtnActive].filter(Boolean).join(' ')}
                            onClick={() => setTemplateTab('telegram')}
                          >
                            Telegram
                          </button>
                        </div>
                      )}
                      <input
                        type="text"
                        placeholder="Search templates..."
                        value={templateSearch}
                        onChange={(e) => setTemplateSearch(e.target.value)}
                        className={styles.templatesSearch}
                        autoFocus
                      />
                      <div className={styles.templatesList}>
                        {(!isTelegram || templateTab === 'quick') ? (
                          filteredTemplates.length === 0 ? (
                            <div className={styles.templatesEmpty}>No templates found</div>
                          ) : (
                            filteredTemplates.map((tpl) => (
                              <button
                                key={tpl.id}
                                className={styles.templateItem}
                                onClick={() => selectTemplate(tpl)}
                              >
                                <div className={styles.templateName}>
                                  {tpl.name}
                                  {tpl.shortcut && (
                                    <span className={styles.templateShortcut}>/{tpl.shortcut}</span>
                                  )}
                                </div>
                                <div className={styles.templatePreview}>{tpl.content}</div>
                              </button>
                            ))
                          )
                        ) : (
                          filteredTelegramTemplates.length === 0 ? (
                            <div className={styles.templatesEmpty}>No Telegram templates found</div>
                          ) : (
                            filteredTelegramTemplates.map((tpl) => (
                              <button
                                key={tpl.id}
                                className={styles.templateItem}
                                onClick={() => selectTelegramTemplate(tpl)}
                              >
                                <div className={styles.templateName}>
                                  {tpl.name}
                                  {tpl.parseMode && (
                                    <span className={styles.templateShortcut}>{tpl.parseMode}</span>
                                  )}
                                </div>
                                <div className={styles.templatePreview}>
                                  {tpl.content}
                                  {tpl.inlineKeyboard && (tpl.inlineKeyboard as InlineKeyboardButton[][]).length > 0 && (
                                    <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                                      [{(tpl.inlineKeyboard as InlineKeyboardButton[][]).reduce((s, r) => s + r.length, 0)} btn]
                                    </span>
                                  )}
                                </div>
                              </button>
                            ))
                          )
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <input
                  type="file"
                  ref={fileInputRef}
                  className={styles.fileInputHidden}
                  accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.zip,.rar,.txt"
                  onChange={(e) => {
                    const file = e.target.files?.[0] || null;
                    setAttachedFile(file);
                  }}
                />
                <Tooltip label="Attach file">
                  <button
                    className={styles.iconBtn}
                    onClick={() => fileInputRef.current?.click()}
                    type="button"
                  >
                    <Paperclip size={16} />
                  </button>
                </Tooltip>
                <div className={styles.replyInputWrap}>
                  {attachedFile && (
                    <div className={styles.attachedFileBar}>
                      <FileText size={14} />
                      <span className={styles.attachedFileName}>{attachedFile.name}</span>
                      <span className={styles.attachedFileSize}>{formatBytes(attachedFile.size)}</span>
                      <Tooltip label="Remove file">
                        <button
                          className={styles.attachedFileRemove}
                          onClick={() => {
                            setAttachedFile(null);
                            if (fileInputRef.current) fileInputRef.current.value = '';
                          }}
                          type="button"
                        >
                          <X size={12} />
                        </button>
                      </Tooltip>
                    </div>
                  )}
                  <textarea
                    ref={replyInputRef}
                    className={styles.replyInput}
                    placeholder={attachedFile ? 'Add a caption... (optional)' : 'Type a message… or / for templates (Enter to send, Shift+Enter for new line)'}
                    value={replyText}
                    onChange={(e) => {
                      const val = e.target.value;
                      // Slash trigger: lone "/" opens the template popover
                      if (val === '/') {
                        setTemplatesOpen(true);
                        setTemplateSearch('');
                        setReplyText('');
                        return;
                      }
                      setReplyText(val);
                      // Auto-resize
                      const ta = e.target;
                      ta.style.height = 'auto';
                      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
                    }}
                    onKeyDown={handleReplyKeyDown}
                    onPaste={handleReplyPaste}
                    rows={1}
                  />
                  {draftSavedIndicator && (
                    <span className={styles.draftSavedIndicator}>Draft saved</span>
                  )}
                </div>
                <Tooltip label="Send message">
                  <button
                    className={styles.sendBtn}
                    onClick={handleSend}
                    disabled={(!replyText.trim() && !attachedFile) || sending}
                    aria-label="Send message"
                  >
                    <Send size={16} />
                  </button>
                </Tooltip>
              </div>
            </div>
          </div>
        ) : (
          <div className={`${styles.emptyPanel} ${styles.threadPanelHidden}`}>
            <User size={48} className={styles.emptyIcon} />
            <span className={styles.emptyTitle}>Select a conversation</span>
            <span className={styles.emptyText}>
              Choose a conversation from the list to view messages
            </span>
          </div>
        )}
      </div>
    </div>

    {showCreateCard && activeConversation && (
      <CreateCardModal
        onClose={() => setShowCreateCard(false)}
        onSubmit={handleCreateCard}
        showCollectionPicker
        allowCreateAnother={false}
        defaultName={
          activeConversation.subject
            ? activeConversation.subject
            : `Conversation with ${getContactName(activeConversation.contact)}`
        }
        defaultDescription={
          activeConversation.lastMessagePreview
            ? `> ${activeConversation.lastMessagePreview}`
            : undefined
        }
      />
    )}
    </>
  );
}
