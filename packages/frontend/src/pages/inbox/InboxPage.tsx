import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
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
} from 'lucide-react';
import { api, apiUpload, ApiError } from '../../lib/api';
import { getFirstImageFromClipboardData, prepareImageForUpload } from '../../lib/image-upload';
import { useAuth } from '../../stores/useAuth';
import { Tooltip } from '../../ui';
import styles from './InboxPage.module.css';

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
 */
function renderFormattedContent(content: string): string {
  // Sanitize: escape everything except allowed Telegram HTML tags
  let safe = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Restore allowed tags
  safe = safe
    .replace(/&lt;b&gt;/g, '<b>')
    .replace(/&lt;\/b&gt;/g, '</b>')
    .replace(/&lt;strong&gt;/g, '<b>')
    .replace(/&lt;\/strong&gt;/g, '</b>')
    .replace(/&lt;i&gt;/g, '<i>')
    .replace(/&lt;\/i&gt;/g, '</i>')
    .replace(/&lt;em&gt;/g, '<i>')
    .replace(/&lt;\/em&gt;/g, '</i>')
    .replace(/&lt;code&gt;/g, '<code>')
    .replace(/&lt;\/code&gt;/g, '</code>')
    .replace(/&lt;pre&gt;/g, '<pre>')
    .replace(/&lt;\/pre&gt;/g, '</pre>')
    .replace(/&lt;s&gt;/g, '<s>')
    .replace(/&lt;\/s&gt;/g, '</s>')
    .replace(/&lt;u&gt;/g, '<u>')
    .replace(/&lt;\/u&gt;/g, '</u>');

  // Restore <a href="..."> tags
  safe = safe.replace(
    /&lt;a href=&quot;([^&]*)&quot;&gt;/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">',
  );
  safe = safe.replace(/&lt;\/a&gt;/g, '</a>');

  return safe;
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

function formatFileSize(bytes: number | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number | undefined): string {
  if (!seconds) return '0:00';
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

/* ── Component ── */

export function InboxPage() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // Conversation list state
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convsLoading, setConvsLoading] = useState(true);
  const [convsError, setConvsError] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('open');
  const [channelFilter, setChannelFilter] = useState<string>('');

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
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedDraftRef = useRef<{ conversationId: string; content: string } | null>(null);

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
      if (searchInput) params.set('search', searchInput);
      if (channelFilter) params.set('channelType', channelFilter);

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
  }, [statusFilter, searchInput, channelFilter]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

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
      if (selectedId) {
        fetchMessages(selectedId, { silent: true });
      }
    }, INBOX_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [fetchConversations, fetchMessages, selectedId]);

  /* ── Scroll to bottom on new messages or streaming ── */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /* ── Auto-save draft (debounced) ── */
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
    setKeyboardOpen(false);
    setKeyboardRows([]);

    // Load draft for the selected conversation
    api<PaginatedResponse<{ id: string; conversationId: string; content: string }>>(
      `/message-drafts?conversationId=${id}&limit=1`,
    )
      .then((data) => {
        const draft = data.entries[0];
        setReplyText(draft ? draft.content : '');
        lastSavedDraftRef.current = draft
          ? { conversationId: id, content: draft.content }
          : null;
      })
      .catch(() => {
        setReplyText('');
        lastSavedDraftRef.current = null;
      });
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
      setMsgsError(err instanceof ApiError ? err.message : 'Failed to send message');
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
  async function updateConversationStatus(status: 'open' | 'closed' | 'archived') {
    if (!selectedId) return;
    try {
      const updated = await api<Conversation>(`/conversations/${selectedId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setActiveConversation((prev) => (prev ? { ...prev, ...updated } : prev));
      setConversations((prev) => prev.map((c) => (c.id === selectedId ? { ...c, status } : c)));
    } catch {
      // silent
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

  /* ── Search conversations ── */
  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    fetchConversations();
  }

  /* ── Render ── */

  const dateGroups = groupMessagesByDate(messages);

  return (
    <div className={styles.wrapper}>
      <div className={styles.container}>
        {/* ── Left: Conversation list ── */}
        <div className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <span className={styles.sidebarTitle}>Inbox</span>
          </div>

          <div className={styles.filterRow}>
            <form onSubmit={handleSearchSubmit} className={styles.searchWrap}>
              <Search size={14} className={styles.searchIcon} />
              <input
                type="text"
                placeholder="Search..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className={styles.searchInput}
              />
            </form>
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value)}
              className={styles.statusFilter}
            >
              <option value="">All channels</option>
              <option value="email">Email</option>
              <option value="web_chat">Web Chat</option>
              <option value="telegram">Telegram</option>
              <option value="internal">Internal</option>
              <option value="other">Other</option>
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className={styles.statusFilter}
            >
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="archived">Archived</option>
              <option value="">All</option>
            </select>
          </div>

          <div className={styles.conversationList}>
            {convsLoading ? (
              <div className={styles.loadingState}>Loading...</div>
            ) : convsError ? (
              <div className={styles.errorState}>{convsError}</div>
            ) : conversations.length === 0 ? (
              <div className={styles.emptyPanel}>
                <MessageSquare size={40} className={styles.emptyIcon} />
                <span className={styles.emptyText}>No conversations</span>
              </div>
            ) : (
              conversations.map((conv) => {
                const isActive = conv.id === selectedId;
                const cls = [
                  styles.conversationItem,
                  isActive && styles.conversationItemActive,
                  conv.isUnread && styles.conversationItemUnread,
                ]
                  .filter(Boolean)
                  .join(' ');

                return (
                  <div
                    key={conv.id}
                    className={cls}
                    onClick={() => selectConversation(conv.id)}
                  >
                    <span className={styles.convAvatar}>
                      {getContactInitials(conv.contact)}
                    </span>
                    <div className={styles.convContent}>
                      <div className={styles.convHeader}>
                        <span className={styles.convName}>
                          {getContactName(conv.contact)}
                        </span>
                        <span className={styles.convTime}>
                          {formatRelativeTime(conv.lastMessageAt || conv.createdAt)}
                        </span>
                      </div>
                      {conv.subject && (
                        <div className={styles.convSubject}>{conv.subject}</div>
                      )}
                      <div className={styles.convFooter}>
                        <span className={styles.convPreview}>
                          {conv.subject || CHANNEL_LABELS[conv.channelType] || conv.channelType}
                        </span>
                        <span className={styles.channelBadge}>
                          {CHANNEL_LABELS[conv.channelType] || conv.channelType}
                        </span>
                        {conv.isUnread && <span className={styles.unreadDot} />}
                        {draftConversationIds.has(conv.id) && <span className={styles.draftBadge}>Draft</span>}
                      </div>
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
              <div className={styles.threadContactInfo}>
                <span className={styles.threadAvatar}>
                  {getContactInitials(activeConversation.contact)}
                </span>
                <div>
                  <div className={styles.threadContactName}>
                    {getContactName(activeConversation.contact)}
                  </div>
                  {activeConversation.contact?.email && (
                    <div className={styles.threadContactEmail}>
                      {activeConversation.contact.email}
                    </div>
                  )}
                </div>
              </div>
              <div className={styles.threadActions}>
                {activeConversation.status === 'open' ? (
                  <>
                    <Tooltip label="Close conversation">
                      <button
                        className={styles.iconBtn}
                        onClick={() => updateConversationStatus('closed')}
                      >
                        <CheckCircle2 size={16} />
                      </button>
                    </Tooltip>
                    <Tooltip label="Archive conversation">
                      <button
                        className={styles.iconBtn}
                        onClick={() => updateConversationStatus('archived')}
                      >
                        <Archive size={16} />
                      </button>
                    </Tooltip>
                  </>
                ) : (
                  <Tooltip label="Reopen conversation">
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
                <div className={styles.loadingState}>Loading messages...</div>
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
                                        <span className={styles.mediaDocSize}>{formatFileSize(att.fileSize)}</span>
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
                            <span>{formatMessageTime(msg.createdAt)}</span>
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
                      <span className={styles.attachedFileSize}>{formatFileSize(attachedFile.size)}</span>
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
                    placeholder={attachedFile ? 'Add a caption... (optional)' : 'Type a message... (Enter to send, Shift+Enter for new line)'}
                    value={replyText}
                    onChange={(e) => {
                      setReplyText(e.target.value);
                      // Auto-resize
                      const ta = e.target;
                      ta.style.height = 'auto';
                      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
                    }}
                    onKeyDown={handleReplyKeyDown}
                    onPaste={handleReplyPaste}
                    rows={1}
                  />
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
          <div className={styles.emptyPanel}>
            <User size={48} className={styles.emptyIcon} />
            <span className={styles.emptyTitle}>Select a conversation</span>
            <span className={styles.emptyText}>
              Choose a conversation from the list to view messages
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
