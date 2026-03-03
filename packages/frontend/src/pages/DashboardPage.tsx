import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  FolderOpen,
  Kanban,
  FileText,
  Bot,
  ArrowRight,
  Activity,
  MessageSquare,
  Clock,
  Zap,
  CheckCircle2,
  XCircle,
  Plus,
  CalendarDays,
  AlertCircle,
  Search,
  X,
  Circle,
  CircleCheck,
  Inbox,
  Mail,
  MailOpen,
  StickyNote,
  ChevronDown,
  ArrowRightCircle,
  ExternalLink,
  Copy,
  Flag,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  WifiOff,
} from 'lucide-react';
import { PageHeader } from '../layout';
import { AgentAvatar } from '../components/AgentAvatar';
import { useAuth } from '../stores/useAuth';
import { useWorkspace } from '../stores/WorkspaceContext';
import { api, ApiError } from '../lib/api';
import { toast } from '../stores/toast';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { TimeAgo } from '../components/TimeAgo';
import { getRecentVisits, removeRecentVisit, type RecentVisit } from '../lib/recent-visits';
import { stripMarkdown } from '../lib/file-utils';
import { CardQuickView } from './boards/CardQuickView';
import { PriorityBadge } from '../components/PriorityBadge';
import type { Priority } from '../components/PriorityBadge';
import { QuickDateButtons } from '../components/QuickDateButtons';
import { DueDatePicker } from '../components/DueDatePicker';
import { CreateCardModal } from '../ui/CreateCardModal';
import type { CreateCardData } from '../ui/CreateCardModal';
import styles from './DashboardPage.module.css';

interface CardAssignee {
  id: string;
  firstName: string;
  lastName: string;
  type?: 'user' | 'agent';
  avatarIcon?: string | null;
  avatarBgColor?: string | null;
  avatarLogoColor?: string | null;
}

interface CardItem {
  id: string;
  name: string;
  description: string | null;
  collectionId: string;
  assignee: CardAssignee | null;
  customFields?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface ConversationContact {
  id: string;
  firstName: string;
  lastName: string | null;
}

interface ConversationPreview {
  id: string;
  contactId: string;
  channelType: string;
  status: 'open' | 'closed' | 'archived';
  subject: string | null;
  isUnread: boolean;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageDirection: 'inbound' | 'outbound' | null;
  createdAt: string;
  contact: ConversationContact | null;
}

interface AgentRun {
  id: string;
  agentId: string;
  agentName: string;
  triggerType: 'chat' | 'cron' | 'card';
  status: 'running' | 'completed' | 'error';
  conversationId: string | null;
  cardId: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

const STAT_CARDS = [
  { key: 'collections', label: 'Collections', to: '/collections', icon: FolderOpen, bg: 'rgba(59,130,246,0.1)', color: 'var(--color-info)' },
  { key: 'boards', label: 'Boards', to: '/boards', icon: Kanban, bg: 'rgba(139,92,246,0.1)', color: '#8B5CF6' },
  { key: 'cards', label: 'Cards', to: '/collections', icon: FileText, bg: 'rgba(245,158,11,0.1)', color: 'var(--color-warning)' },
  { key: 'agents', label: 'Agents', to: '/agents', icon: Bot, bg: 'rgba(16,185,129,0.1)', color: '#10B981' },
] as const;

const TRIGGER_CONFIG = {
  chat: { label: 'Chat', icon: MessageSquare },
  cron: { label: 'Cron', icon: Clock },
  card: { label: 'Card', icon: Zap },
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function getDueDateInfo(card: CardItem): { label: string; status: 'overdue' | 'soon' | 'normal' } | null {
  const dueDate = card.customFields?.dueDate as string | undefined;
  if (!dueDate) return null;
  const due = new Date(dueDate);
  const now = new Date();
  const diffMs = due.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / 86400000);
  if (diffDays < 0) {
    const overdueDays = Math.abs(diffDays);
    const label = overdueDays === 1 ? 'Overdue 1d' : `Overdue ${overdueDays}d`;
    return { label, status: 'overdue' };
  }
  if (diffDays === 0) return { label: 'Due today', status: 'soon' };
  if (diffDays === 1) return { label: 'Due tomorrow', status: 'soon' };
  if (diffDays <= 7) return { label: `Due in ${diffDays}d`, status: 'soon' };
  return { label: due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), status: 'normal' };
}

function sortCardsByDueDate(cards: CardItem[]): CardItem[] {
  return [...cards].sort((a, b) => {
    const aDate = a.customFields?.dueDate as string | undefined;
    const bDate = b.customFields?.dueDate as string | undefined;
    if (!aDate && !bDate) return 0;
    if (!aDate) return 1;
    if (!bDate) return -1;
    return new Date(aDate).getTime() - new Date(bDate).getTime();
  });
}

type CardGroupKey = 'overdue' | 'today' | 'this-week' | 'upcoming' | 'no-date';

interface MyCardGroup {
  key: CardGroupKey;
  label: string;
  color: string;
  cards: CardItem[];
}

function groupMyCards(cards: CardItem[]): MyCardGroup[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(todayStart.getTime() + 86400000);
  const weekEnd = new Date(todayStart.getTime() + 7 * 86400000);

  const buckets: Record<CardGroupKey, CardItem[]> = {
    'overdue': [],
    'today': [],
    'this-week': [],
    'upcoming': [],
    'no-date': [],
  };

  for (const card of cards) {
    const dueDate = card.customFields?.dueDate as string | undefined;
    if (!dueDate) {
      buckets['no-date'].push(card);
      continue;
    }
    const due = new Date(dueDate);
    if (due.getTime() < todayStart.getTime()) {
      buckets['overdue'].push(card);
    } else if (due.getTime() < todayEnd.getTime()) {
      buckets['today'].push(card);
    } else if (due.getTime() < weekEnd.getTime()) {
      buckets['this-week'].push(card);
    } else {
      buckets['upcoming'].push(card);
    }
  }

  const groups: MyCardGroup[] = [
    { key: 'overdue', label: 'Overdue', color: 'var(--color-error)', cards: sortCardsByDueDate(buckets['overdue']) },
    { key: 'today', label: 'Due Today', color: 'var(--color-warning)', cards: sortCardsByDueDate(buckets['today']) },
    { key: 'this-week', label: 'This Week', color: 'var(--color-info)', cards: sortCardsByDueDate(buckets['this-week']) },
    { key: 'upcoming', label: 'Upcoming', color: 'var(--color-text-secondary)', cards: sortCardsByDueDate(buckets['upcoming']) },
    { key: 'no-date', label: 'No Due Date', color: 'var(--color-text-tertiary)', cards: buckets['no-date'] },
  ];

  return groups.filter((g) => g.cards.length > 0);
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function getWeekDays(weekOffset: number): Date[] {
  const now = new Date();
  const current = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Start from Monday
  const dayOfWeek = current.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(current);
  monday.setDate(current.getDate() + mondayOffset + weekOffset * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function getCardDueDateColor(card: CardItem): string {
  const p = card.customFields?.priority as string | undefined;
  if (p === 'high') return '#EF4444';
  if (p === 'medium') return '#F59E0B';
  if (p === 'low') return '#60A5FA';
  return 'var(--color-text-tertiary)';
}

function formatRefreshTimestamp(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 10) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function getContactDisplayName(contact: ConversationContact | null): string {
  if (!contact) return 'Unknown';
  return [contact.firstName, contact.lastName].filter(Boolean).join(' ');
}

function getContactInitials(contact: ConversationContact | null): string {
  if (!contact) return '?';
  const first = contact.firstName?.[0] || '';
  const last = contact.lastName?.[0] || '';
  return (first + last).toUpperCase() || '?';
}

const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  internal: 'Internal',
  email: 'Email',
  web_chat: 'Web Chat',
  other: 'Other',
};

const RECENT_VISIT_ICONS: Record<RecentVisit['type'], React.ComponentType<{ size?: number }>> = {
  card: FileText,
  board: Kanban,
  collection: FolderOpen,
};

const RECENT_VISIT_TYPE_LABEL: Record<RecentVisit['type'], string> = {
  card: 'Card',
  board: 'Board',
  collection: 'Collection',
};

function formatVisitTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 604800_000) return `${Math.floor(diff / 86400_000)}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function DashboardPage() {
  useDocumentTitle('Dashboard');
  const navigate = useNavigate();
  const { user } = useAuth();
  const { activeWorkspaceId, activeWorkspace } = useWorkspace();
  const [stats, setStats] = useState({ collections: 0, boards: 0, cards: 0, agents: 0 });
  const [recentCards, setRecentCards] = useState<CardItem[]>([]);
  const [myCards, setMyCards] = useState<CardItem[]>([]);
  const [recentRuns, setRecentRuns] = useState<AgentRun[]>([]);
  const [recentConversations, setRecentConversations] = useState<ConversationPreview[]>([]);
  const [unreadConversationCount, setUnreadConversationCount] = useState(0);
  const [recentVisits, setRecentVisits] = useState<RecentVisit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null);
  const [quickViewCardId, setQuickViewCardId] = useState<string | null>(null);
  const [hideCompleted, setHideCompleted] = useState<boolean>(
    () => localStorage.getItem('dashboard-my-cards-hide-completed') === 'true',
  );
  const [collections, setCollections] = useState<{ id: string; name: string; isGeneral?: boolean }[]>([]);
  const [inlineAddName, setInlineAddName] = useState('');
  const [inlineAddSubmitting, setInlineAddSubmitting] = useState(false);
  const inlineAddRef = useRef<HTMLInputElement>(null);

  // Week strip
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [weekAddDueDate, setWeekAddDueDate] = useState<string | null>(null);

  // Scratchpad
  const SCRATCHPAD_KEY = 'dashboard-scratchpad';
  const SCRATCHPAD_COLLAPSED_KEY = 'dashboard-scratchpad-collapsed';
  const [scratchpad, setScratchpad] = useState(() => localStorage.getItem(SCRATCHPAD_KEY) ?? '');
  const [scratchpadCollapsed, setScratchpadCollapsed] = useState(
    () => localStorage.getItem(SCRATCHPAD_COLLAPSED_KEY) === 'true',
  );
  const [convertingScratchpad, setConvertingScratchpad] = useState(false);
  const scratchpadRef = useRef<HTMLTextAreaElement>(null);

  // Card context menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; cardId: string } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const fetchDashboard = useCallback(async (isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setLoadError(false);
    const wsParam = activeWorkspaceId ? `&workspaceId=${activeWorkspaceId}` : '';
    try {
      const [collectionsRes, boardsRes, cardsRes, agentsRes, runsRes, myCardsRes, conversationsRes, unreadRes, collectionsListRes] =
        await Promise.all([
          api<{ total: number }>(`/collections?limit=0${wsParam}`),
          api<{ total: number }>(`/boards?limit=0${wsParam}`),
          api<{ entries: CardItem[]; total: number }>(`/cards?limit=6${wsParam}`),
          api<{ total: number }>('/agents?limit=1'),
          api<{ entries: AgentRun[] }>('/agent-runs?limit=6').catch(() => ({ entries: [] })),
          user
            ? api<{ entries: CardItem[] }>(`/cards?assigneeId=${user.id}&limit=8${wsParam}`).catch(() => ({ entries: [] }))
            : Promise.resolve({ entries: [] as CardItem[] }),
          api<{ entries: ConversationPreview[] }>('/conversations?limit=5&sort=lastMessageAt:desc').catch(() => ({ entries: [] })),
          api<{ total: number }>('/conversations?isUnread=true&countOnly=true').catch(() => ({ total: 0 })),
          api<{ entries: { id: string; name: string; isGeneral?: boolean }[] }>(`/collections?limit=50${wsParam}`).catch(() => ({ entries: [] })),
        ]);

      setStats({
        collections: collectionsRes.total,
        boards: boardsRes.total,
        cards: cardsRes.total,
        agents: agentsRes.total,
      });
      setRecentCards(cardsRes.entries);
      setMyCards(myCardsRes.entries);
      setRecentRuns(runsRes.entries);
      setRecentConversations(conversationsRes.entries);
      setUnreadConversationCount(unreadRes.total);
      setCollections(collectionsListRes.entries);
      setLastRefreshed(Date.now());
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user, activeWorkspaceId]);

  const refreshRuns = useCallback(async () => {
    try {
      const runsRes = await api<{ entries: AgentRun[] }>('/agent-runs?limit=6').catch(() => ({ entries: [] }));
      setRecentRuns(runsRes.entries);
    } catch {
      // best-effort
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
    setRecentVisits(getRecentVisits());
  }, [fetchDashboard]);

  // Auto-refresh agent activity every 30s so running agents appear live
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) void refreshRuns();
    }, 30_000);
    return () => clearInterval(id);
  }, [refreshRuns]);

  const handleCardUpdated = useCallback((cardId: string, updates: { name?: string; description?: string | null; assigneeId?: string | null; customFields?: Record<string, unknown> }) => {
    const patch = (cards: CardItem[]) =>
      cards.map((c) => (c.id === cardId ? { ...c, ...updates } : c));
    setRecentCards(patch);
    setMyCards(patch);
  }, []);

  const openQuickView = useCallback((e: React.MouseEvent, cardId: string) => {
    // Allow ctrl/cmd+click to open in new tab normally
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    setQuickViewCardId(cardId);
  }, []);

  const handleToggleComplete = useCallback(async (cardId: string, currentCompleted: boolean) => {
    const newCompleted = !currentCompleted;
    const patchCards = (cards: CardItem[]) =>
      cards.map((c) => c.id === cardId ? { ...c, customFields: { ...c.customFields, completed: newCompleted } } : c);
    const revertCards = (cards: CardItem[]) =>
      cards.map((c) => c.id === cardId ? { ...c, customFields: { ...c.customFields, completed: currentCompleted } } : c);

    setMyCards(patchCards);
    setRecentCards(patchCards);
    try {
      const card = [...myCards, ...recentCards].find((c) => c.id === cardId);
      const newCustomFields = { ...card?.customFields, completed: newCompleted };
      await api(`/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
      const cardName = card?.name ?? 'Card';
      const shortName = cardName.length > 30 ? cardName.slice(0, 30) + '...' : cardName;
      toast.success(
        newCompleted ? `"${shortName}" completed` : `"${shortName}" reopened`,
        {
          action: {
            label: 'Undo',
            onClick: () => void handleToggleComplete(cardId, newCompleted),
          },
        },
      );
    } catch (err) {
      setMyCards(revertCards);
      setRecentCards(revertCards);
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to update card');
    }
  }, [myCards, recentCards]);

  const handleInlineAdd = useCallback(async () => {
    const trimmed = inlineAddName.trim();
    if (!trimmed || inlineAddSubmitting || !user) return;
    const col = collections.find((c) => c.isGeneral) ?? collections[0];
    if (!col) {
      toast.error('No collection available. Create a collection first.');
      return;
    }
    setInlineAddSubmitting(true);
    try {
      const card = await api<CardItem>('/cards', {
        method: 'POST',
        body: JSON.stringify({
          collectionId: col.id,
          name: trimmed,
          description: null,
          assigneeId: user.id,
        }),
      });
      setInlineAddName('');
      setMyCards((prev) => [card, ...prev]);
      inlineAddRef.current?.focus();
      toast.success('Card created', {
        action: { label: 'Open', onClick: () => navigate(`/cards/${card.id}`) },
      });
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to create card');
    } finally {
      setInlineAddSubmitting(false);
    }
  }, [inlineAddName, inlineAddSubmitting, user, collections, navigate]);

  const handleWeekAddCard = useCallback(async (data: CreateCardData) => {
    if (!data.collectionId || !user) return;
    const customFields: Record<string, unknown> = {};
    if (data.dueDate) customFields.dueDate = data.dueDate;
    if (data.priority) customFields.priority = data.priority;
    const card = await api<CardItem>('/cards', {
      method: 'POST',
      body: JSON.stringify({
        collectionId: data.collectionId,
        name: data.name,
        description: data.description,
        assigneeId: data.assigneeId ?? user.id,
        ...(Object.keys(customFields).length > 0 ? { customFields } : {}),
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
    setMyCards((prev) => [card, ...prev]);
    setWeekAddDueDate(null);
    toast.success('Card created', {
      action: { label: 'Open', onClick: () => navigate(`/cards/${card.id}`) },
    });
  }, [user, navigate]);

  const handleScratchpadChange = useCallback((value: string) => {
    setScratchpad(value);
    localStorage.setItem(SCRATCHPAD_KEY, value);
  }, []);

  const toggleScratchpadCollapsed = useCallback(() => {
    setScratchpadCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(SCRATCHPAD_COLLAPSED_KEY, String(next));
      return next;
    });
  }, []);

  const handleConvertScratchpadToCard = useCallback(async () => {
    const text = scratchpad.trim();
    if (!text || convertingScratchpad || !user) return;
    const col = collections.find((c) => c.isGeneral) ?? collections[0];
    if (!col) {
      toast.error('No collection available. Create a collection first.');
      return;
    }
    // Use first line as card name, rest as description
    const lines = text.split('\n');
    const name = lines[0].slice(0, 200);
    const description = lines.slice(1).join('\n').trim() || null;
    setConvertingScratchpad(true);
    try {
      const card = await api<CardItem>('/cards', {
        method: 'POST',
        body: JSON.stringify({
          collectionId: col.id,
          name,
          description,
          assigneeId: user.id,
        }),
      });
      handleScratchpadChange('');
      setMyCards((prev) => [card, ...prev]);
      toast.success('Note converted to card', {
        action: { label: 'Open', onClick: () => navigate(`/cards/${card.id}`) },
      });
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to create card');
    } finally {
      setConvertingScratchpad(false);
    }
  }, [scratchpad, convertingScratchpad, user, collections, navigate, handleScratchpadChange]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [contextMenu]);

  const handleSetPriority = useCallback(async (cardId: string, priority: Priority | null) => {
    const card = [...myCards, ...recentCards].find((c) => c.id === cardId);
    const newCustomFields = { ...card?.customFields, priority: priority ?? undefined };
    if (!priority) delete newCustomFields.priority;
    const patchCards = (cards: CardItem[]) =>
      cards.map((c) => c.id === cardId ? { ...c, customFields: newCustomFields } : c);
    setMyCards(patchCards);
    setRecentCards(patchCards);
    try {
      await api(`/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
      const label = priority ? `Priority set to ${priority}` : 'Priority cleared';
      toast.success(label);
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to update priority');
    }
  }, [myCards, recentCards]);

  const handleSetDueDate = useCallback(async (cardId: string, dueDate: string | null) => {
    const card = [...myCards, ...recentCards].find((c) => c.id === cardId);
    const newCustomFields = { ...card?.customFields, dueDate: dueDate ?? undefined };
    if (!dueDate) delete newCustomFields.dueDate;
    const patchCards = (cards: CardItem[]) =>
      cards.map((c) => c.id === cardId ? { ...c, customFields: newCustomFields } : c);
    setMyCards(patchCards);
    setRecentCards(patchCards);
    try {
      await api(`/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
      toast.success(dueDate ? 'Due date updated' : 'Due date cleared');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to update due date');
    }
  }, [myCards, recentCards]);

  const handleCardContextMenu = useCallback((e: React.MouseEvent, cardId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, cardId });
  }, []);

  const myCardsCompleted = useMemo(() => myCards.filter((c) => c.customFields?.completed === true).length, [myCards]);
  const myCardsTotal = myCards.length;
  const myCardsProgress = myCardsTotal > 0 ? Math.round((myCardsCompleted / myCardsTotal) * 100) : 0;
  const visibleMyCards = useMemo(() => {
    const sorted = sortCardsByDueDate(myCards);
    return hideCompleted ? sorted.filter((c) => c.customFields?.completed !== true) : sorted;
  }, [myCards, hideCompleted]);

  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    try {
      const stored = localStorage.getItem('dashboard-my-cards-collapsed-groups');
      return stored ? JSON.parse(stored) : {};
    } catch { return {}; }
  });

  const toggleGroupCollapsed = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem('dashboard-my-cards-collapsed-groups', JSON.stringify(next));
      return next;
    });
  }, []);

  const myCardGroups = useMemo(() => groupMyCards(visibleMyCards), [visibleMyCards]);

  // Combined card IDs for quick-view navigation (my cards first, then recent, deduplicated)
  const dashboardCardIds = useMemo(() => {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const c of sortCardsByDueDate(myCards)) {
      if (!seen.has(c.id)) { seen.add(c.id); ids.push(c.id); }
    }
    for (const c of recentCards) {
      if (!seen.has(c.id)) { seen.add(c.id); ids.push(c.id); }
    }
    return ids;
  }, [myCards, recentCards]);

  const handleRefresh = useCallback(() => {
    void fetchDashboard(true);
    setRecentVisits(getRecentVisits());
  }, [fetchDashboard]);

  // Re-render the "Updated X ago" timestamp periodically
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!lastRefreshed) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [lastRefreshed]);

  const greeting = user ? `Welcome back, ${user.firstName}` : 'Dashboard';

  const overdueCards = useMemo(() => myCards.filter((c) => {
    if (c.customFields?.completed === true) return false;
    const dueDate = c.customFields?.dueDate as string | undefined;
    if (!dueDate) return false;
    return new Date(dueDate).getTime() < Date.now();
  }), [myCards]);

  const dueTodayCards = useMemo(() => myCards.filter((c) => {
    if (c.customFields?.completed === true) return false;
    const dueDate = c.customFields?.dueDate as string | undefined;
    if (!dueDate) return false;
    const due = new Date(dueDate);
    const now = new Date();
    return due.getFullYear() === now.getFullYear() && due.getMonth() === now.getMonth() && due.getDate() === now.getDate();
  }), [myCards]);

  const attentionCount = overdueCards.length + dueTodayCards.length;

  const weekDays = useMemo(() => getWeekDays(weekOffset), [weekOffset]);
  const today = useMemo(() => new Date(), []);

  // All cards with due dates for the week view (my cards)
  const weekCardsByDay = useMemo(() => {
    const map = new Map<string, CardItem[]>();
    for (const day of weekDays) {
      const key = day.toISOString().slice(0, 10);
      map.set(key, []);
    }
    for (const card of myCards) {
      const dueDate = card.customFields?.dueDate as string | undefined;
      if (!dueDate) continue;
      const key = dueDate.slice(0, 10);
      if (map.has(key)) {
        map.get(key)!.push(card);
      }
    }
    return map;
  }, [myCards, weekDays]);

  const selectedDayCards = useMemo(() => {
    if (!selectedDay) return [];
    const key = selectedDay.toISOString().slice(0, 10);
    return weekCardsByDay.get(key) ?? [];
  }, [selectedDay, weekCardsByDay]);

  const weekLabel = useMemo(() => {
    const first = weekDays[0];
    const last = weekDays[6];
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    if (first.getMonth() === last.getMonth()) {
      return `${first.toLocaleDateString('en-US', { month: 'short' })} ${first.getDate()}–${last.getDate()}`;
    }
    return `${first.toLocaleDateString('en-US', opts)} – ${last.toLocaleDateString('en-US', opts)}`;
  }, [weekDays]);

  return (
    <div className={styles.wrapper}>
      <PageHeader
        title={greeting}
        description={activeWorkspace ? `Overview of ${activeWorkspace.name}` : 'Overview of your workspace'}
        actions={
          <div className={styles.headerActions}>
            {lastRefreshed && !loading && (
              <span className={styles.lastRefreshed}>
                Updated {formatRefreshTimestamp(lastRefreshed)}
              </span>
            )}
            <button
              className={`${styles.refreshBtn}${refreshing ? ` ${styles.refreshBtnSpinning}` : ''}`}
              onClick={handleRefresh}
              disabled={refreshing || loading}
              title="Refresh dashboard"
              aria-label="Refresh dashboard"
            >
              <RefreshCw size={15} />
            </button>
          </div>
        }
      />

      {loading ? (
        <div className={styles.loadingState}>
          <div className={styles.skeletonGrid}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={styles.skeletonCard} />
            ))}
          </div>
          <div className={styles.skeletonPanels}>
            <div className={styles.skeletonPanel} />
            <div className={styles.skeletonPanel} />
          </div>
        </div>
      ) : loadError ? (
        <div className={styles.errorState}>
          <div className={styles.errorIcon}>
            <WifiOff size={40} strokeWidth={1.3} />
          </div>
          <h3 className={styles.errorTitle}>Unable to load dashboard</h3>
          <p className={styles.errorDescription}>
            Could not connect to the server. Check your connection and try again.
          </p>
          <button className={styles.errorRetryBtn} onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? styles.refreshBtnSpinning : ''} />
            {refreshing ? 'Retrying...' : 'Try again'}
          </button>
        </div>
      ) : (
        <>
          <button
            className={styles.searchBar}
            onClick={() => window.dispatchEvent(new CustomEvent('open-command-palette'))}
          >
            <Search size={16} />
            <span className={styles.searchBarText}>Search cards, collections, boards...</span>
            <kbd className={styles.searchBarKbd}>{navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'} K</kbd>
          </button>

          {attentionCount > 0 && (
            <Link to="/my-cards" className={styles.attentionBanner}>
              <div className={styles.attentionLeft}>
                <AlertCircle size={16} />
                <span>
                  {overdueCards.length > 0 && (
                    <strong>{overdueCards.length} overdue</strong>
                  )}
                  {overdueCards.length > 0 && dueTodayCards.length > 0 && ' and '}
                  {dueTodayCards.length > 0 && (
                    <strong>{dueTodayCards.length} due today</strong>
                  )}
                </span>
              </div>
              <span className={styles.attentionAction}>
                View cards <ArrowRight size={14} />
              </span>
            </Link>
          )}

          <div className={styles.statsGrid}>
            {STAT_CARDS.map((sc) => (
              <Link
                key={sc.key}
                to={sc.to}
                className={styles.statCard}
              >
                <div
                  className={styles.statIcon}
                  style={{ background: sc.bg, color: sc.color }}
                >
                  <sc.icon size={20} />
                </div>
                <div className={styles.statContent}>
                  <div className={styles.statValue}>{stats[sc.key]}</div>
                  <div className={styles.statLabel}>{sc.label}</div>
                </div>
              </Link>
            ))}
          </div>

          {recentVisits.length > 0 && (
            <div className={styles.jumpBackIn}>
              <div className={styles.jumpBackInHeader}>
                <span className={styles.jumpBackInTitle}>Jump back in</span>
              </div>
              <div className={styles.jumpBackInList}>
                {recentVisits.slice(0, 6).map((visit) => {
                  const Icon = RECENT_VISIT_ICONS[visit.type];
                  const typeLabel = RECENT_VISIT_TYPE_LABEL[visit.type];
                  return (
                    <div key={`${visit.type}-${visit.id}`} className={styles.jumpBackInItemWrapper}>
                      <Link to={visit.path} className={styles.jumpBackInItem}>
                        <div className={styles.jumpBackInIcon}>
                          <Icon size={14} />
                        </div>
                        <div className={styles.jumpBackInContent}>
                          <span className={styles.jumpBackInName}>{visit.name}</span>
                          <span className={styles.jumpBackInType}>{typeLabel} &middot; {formatVisitTime(visit.visitedAt)}</span>
                        </div>
                      </Link>
                      <button
                        className={styles.jumpBackInRemove}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeRecentVisit(visit.type, visit.id);
                          setRecentVisits((prev) => prev.filter((v) => !(v.type === visit.type && v.id === visit.id)));
                        }}
                        title="Remove"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Weekly Calendar Strip */}
          {myCards.length > 0 && (
            <div className={styles.weekStrip}>
              <div className={styles.weekStripHeader}>
                <span className={styles.weekStripTitle}>{weekLabel}</span>
                <div className={styles.weekNav}>
                  {weekOffset !== 0 && (
                    <button
                      className={styles.weekTodayBtn}
                      onClick={() => { setWeekOffset(0); setSelectedDay(null); }}
                    >
                      Today
                    </button>
                  )}
                  <button
                    className={styles.weekNavBtn}
                    onClick={() => { setWeekOffset((o) => o - 1); setSelectedDay(null); }}
                    aria-label="Previous week"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    className={styles.weekNavBtn}
                    onClick={() => { setWeekOffset((o) => o + 1); setSelectedDay(null); }}
                    aria-label="Next week"
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
              <div className={styles.weekDays}>
                {weekDays.map((day) => {
                  const key = day.toISOString().slice(0, 10);
                  const cards = weekCardsByDay.get(key) ?? [];
                  const isToday = isSameDay(day, today);
                  const isSelected = selectedDay ? isSameDay(day, selectedDay) : false;
                  return (
                    <button
                      key={key}
                      className={`${styles.weekDay}${isToday ? ` ${styles.weekDayToday}` : ''}${isSelected ? ` ${styles.weekDaySelected}` : ''}`}
                      onClick={() => setSelectedDay(isSelected ? null : day)}
                    >
                      <span className={styles.weekDayLabel}>{DAY_LABELS[day.getDay()]}</span>
                      <span className={styles.weekDayNumber}>{day.getDate()}</span>
                      <div className={styles.weekDayDots}>
                        {cards.slice(0, 3).map((card) => (
                          <span
                            key={card.id}
                            className={styles.weekDayDot}
                            style={{ background: getCardDueDateColor(card) }}
                          />
                        ))}
                        {cards.length > 3 && (
                          <span className={styles.weekDayDotMore}>+{cards.length - 3}</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
              {selectedDay && (
                <div className={styles.weekDayCards}>
                  <div className={styles.weekDayCardsTitle}>
                    <span>
                      {selectedDay.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
                      {isSameDay(selectedDay, today) && ' (Today)'}
                      {' '}&middot; {selectedDayCards.length} card{selectedDayCards.length !== 1 ? 's' : ''}
                    </span>
                    <button
                      className={styles.weekDayAddBtn}
                      onClick={() => setWeekAddDueDate(selectedDay.toISOString().slice(0, 10))}
                      title={`Add card due on ${selectedDay.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
                    >
                      <Plus size={13} />
                      Add card
                    </button>
                  </div>
                  {selectedDayCards.length === 0 ? (
                    <div className={styles.weekDayEmpty}>No cards due this day</div>
                  ) : (
                    selectedDayCards.map((card) => {
                      const isCompleted = card.customFields?.completed === true;
                      return (
                        <Link
                          key={card.id}
                          to={`/cards/${card.id}`}
                          className={styles.weekDayCardItem}
                          onClick={(e) => openQuickView(e, card.id)}
                        >
                          <span
                            className={styles.weekDayCardDot}
                            style={{ background: getCardDueDateColor(card) }}
                          />
                          <span className={`${styles.weekDayCardName}${isCompleted ? ` ${styles.weekDayCardNameCompleted}` : ''}`}>
                            {card.name}
                          </span>
                          <PriorityBadge priority={(card.customFields?.priority as Priority) ?? null} size="sm" />
                        </Link>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          )}

          <div className={styles.myCardsSection}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>My Cards</h2>
              <div className={styles.myCardsHeaderRight}>
                <Link to="/my-cards" className={styles.viewAllLink}>
                  View all <ArrowRight size={14} />
                </Link>
                {myCardsCompleted > 0 && (
                  <button
                    className={`${styles.hideCompletedBtn}${hideCompleted ? '' : ` ${styles.hideCompletedBtnActive}`}`}
                    onClick={() => {
                      const next = !hideCompleted;
                      setHideCompleted(next);
                      localStorage.setItem('dashboard-my-cards-hide-completed', String(next));
                    }}
                    title={hideCompleted ? `Show ${myCardsCompleted} completed` : 'Hide completed'}
                  >
                    <CheckCircle2 size={13} />
                    {hideCompleted ? `${myCardsCompleted} done` : 'Hide done'}
                  </button>
                )}
                {myCardsTotal > 0 && (
                  <span className={styles.myCardsCount}>
                    {myCardsCompleted}/{myCardsTotal} done
                  </span>
                )}
                <button
                  className={styles.myCardsAddBtn}
                  onClick={() => window.dispatchEvent(new CustomEvent('open-quick-create'))}
                  title="Create a new card"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
            {myCardsTotal > 0 && (
              <div className={styles.progressBarWrapper}>
                <div
                  className={`${styles.progressBar}${myCardsProgress === 100 ? ` ${styles.progressBarComplete}` : ''}`}
                  style={{ width: `${myCardsProgress}%` }}
                />
              </div>
            )}
            <div className={styles.inlineAddRow}>
              <Plus size={14} className={styles.inlineAddIcon} />
              <input
                ref={inlineAddRef}
                className={styles.inlineAddInput}
                placeholder="Add a card... (press Enter)"
                value={inlineAddName}
                onChange={(e) => setInlineAddName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleInlineAdd();
                  }
                  if (e.key === 'Escape') {
                    setInlineAddName('');
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                disabled={inlineAddSubmitting}
              />
              {inlineAddName.trim() && (
                <button className={styles.inlineAddSubmit} onClick={() => void handleInlineAdd()} disabled={inlineAddSubmitting}>
                  {inlineAddSubmitting ? 'Adding...' : 'Add'}
                </button>
              )}
            </div>
            {visibleMyCards.length === 0 ? (
              <div className={styles.myCardsEmpty}>
                {myCards.length > 0 ? (
                  <>
                    <CircleCheck size={18} className={styles.myCardsEmptyIcon} />
                    <span>All cards completed</span>
                  </>
                ) : (
                  <>
                    <FileText size={18} className={styles.myCardsEmptyIcon} />
                    <span>No cards assigned to you yet</span>
                  </>
                )}
              </div>
            ) : (
              <div className={styles.myCardsGrouped}>
                {myCardGroups.map((group) => {
                  const isCollapsed = collapsedGroups[group.key] === true;
                  return (
                    <div key={group.key} className={styles.myCardsGroup}>
                      <button
                        className={styles.groupHeader}
                        onClick={() => toggleGroupCollapsed(group.key)}
                        aria-expanded={!isCollapsed}
                      >
                        <ChevronDown
                          size={13}
                          className={`${styles.groupChevron}${isCollapsed ? ` ${styles.groupChevronCollapsed}` : ''}`}
                        />
                        <span className={styles.groupDot} style={{ background: group.color }} />
                        <span className={styles.groupLabel}>{group.label}</span>
                        <span className={styles.groupCount}>{group.cards.length}</span>
                      </button>
                      {!isCollapsed && (
                        <div className={styles.myCardsList}>
                          {group.cards.map((card) => {
                            const isCompleted = card.customFields?.completed === true;
                            return (
                              <div key={card.id} className={styles.myCardRow} onContextMenu={(e) => handleCardContextMenu(e, card.id)}>
                                <button
                                  className={`${styles.completeBtn}${isCompleted ? ` ${styles.completeBtnDone}` : ''}`}
                                  onClick={() => void handleToggleComplete(card.id, isCompleted)}
                                  title={isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
                                  aria-label={isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
                                >
                                  {isCompleted ? <CircleCheck size={15} /> : <Circle size={15} />}
                                </button>
                                <Link
                                  to={`/cards/${card.id}`}
                                  className={`${styles.myCardItem}${quickViewCardId === card.id ? ` ${styles.myCardItemActive}` : ''}`}
                                  onClick={(e) => openQuickView(e, card.id)}
                                >
                                  <div className={styles.myCardInfo}>
                                    <div className={`${styles.myCardName}${isCompleted ? ` ${styles.myCardNameCompleted}` : ''}`}>{card.name}</div>
                                    {card.description && (
                                      <div className={styles.myCardDesc}>{stripMarkdown(card.description)}</div>
                                    )}
                                  </div>
                                </Link>
                                <div className={styles.myCardMeta} onClick={(e) => e.stopPropagation()}>
                                  <PriorityBadge
                                    priority={(card.customFields?.priority as Priority) ?? null}
                                    size="sm"
                                    editable
                                    onChange={(p) => void handleSetPriority(card.id, p)}
                                  />
                                  <DueDatePicker
                                    value={(card.customFields?.dueDate as string) ?? null}
                                    onChange={(d) => void handleSetDueDate(card.id, d)}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Inbox Preview */}
          <div className={styles.inboxPreview}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>
                <Inbox size={16} className={styles.inboxIcon} />
                Inbox
                {unreadConversationCount > 0 && (
                  <span className={styles.unreadBadge}>{unreadConversationCount}</span>
                )}
              </h2>
              <Link to="/inbox" className={styles.viewAllLink}>
                View all <ArrowRight size={14} />
              </Link>
            </div>
            {recentConversations.length === 0 ? (
              <div className={styles.emptyState}>
                <div className={styles.emptyIcon}>
                  <MessageSquare size={32} />
                </div>
                <div className={styles.emptyTitle}>No conversations yet</div>
                <div className={styles.emptyDescription}>
                  Conversations from your connected channels will appear here.
                </div>
                <Link to="/connectors" className={styles.emptyAction}>
                  <Plus size={14} /> Set up a channel
                </Link>
              </div>
            ) : (
              <div className={styles.inboxList}>
                {recentConversations.map((conv) => (
                  <Link
                    key={conv.id}
                    to={`/inbox?id=${conv.id}`}
                    className={`${styles.inboxItem}${conv.isUnread ? ` ${styles.inboxItemUnread}` : ''}`}
                  >
                    <div className={styles.inboxAvatar}>
                      {getContactInitials(conv.contact)}
                    </div>
                    <div className={styles.inboxContent}>
                      <div className={styles.inboxTopRow}>
                        <span className={styles.inboxContactName}>
                          {getContactDisplayName(conv.contact)}
                        </span>
                        <span className={styles.inboxChannel}>
                          {CHANNEL_LABELS[conv.channelType] || conv.channelType}
                        </span>
                      </div>
                      {conv.subject && (
                        <div className={styles.inboxSubject}>{conv.subject}</div>
                      )}
                      {conv.lastMessagePreview && (
                        <div className={styles.inboxPreviewText}>
                          {conv.lastMessageDirection === 'outbound' && (
                            <span className={styles.inboxYouPrefix}>You: </span>
                          )}
                          {conv.lastMessagePreview}
                        </div>
                      )}
                    </div>
                    <div className={styles.inboxMeta}>
                      {conv.isUnread ? (
                        <Mail size={14} className={styles.inboxUnreadIcon} />
                      ) : (
                        <MailOpen size={14} className={styles.inboxReadIcon} />
                      )}
                      <TimeAgo date={conv.lastMessageAt ?? conv.createdAt} className={styles.inboxTime} />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Quick Scratchpad */}
          <div className={styles.scratchpadSection}>
            <button className={styles.scratchpadHeader} onClick={toggleScratchpadCollapsed} aria-expanded={!scratchpadCollapsed}>
              <StickyNote size={14} className={styles.scratchpadIcon} />
              <span className={styles.scratchpadTitle}>Quick Notes</span>
              {scratchpad.trim() && <span className={styles.scratchpadDot} />}
              <ChevronDown
                size={13}
                className={`${styles.scratchpadChevron}${scratchpadCollapsed ? ` ${styles.scratchpadChevronCollapsed}` : ''}`}
              />
            </button>
            {!scratchpadCollapsed && (
              <div className={styles.scratchpadBody}>
                <textarea
                  ref={scratchpadRef}
                  className={styles.scratchpadTextarea}
                  value={scratchpad}
                  onChange={(e) => handleScratchpadChange(e.target.value)}
                  placeholder="Jot down quick thoughts, ideas, or reminders..."
                  rows={4}
                />
                <div className={styles.scratchpadFooter}>
                  <span className={styles.scratchpadHint}>
                    {scratchpad.trim() ? `${scratchpad.trim().split('\n').length} line${scratchpad.trim().split('\n').length !== 1 ? 's' : ''}` : 'Auto-saved locally'}
                  </span>
                  <div className={styles.scratchpadActions}>
                    {scratchpad.trim() && (
                      <>
                        <button
                          className={styles.scratchpadClearBtn}
                          onClick={() => handleScratchpadChange('')}
                          title="Clear notes"
                        >
                          <X size={12} /> Clear
                        </button>
                        <button
                          className={styles.scratchpadConvertBtn}
                          onClick={() => void handleConvertScratchpadToCard()}
                          disabled={convertingScratchpad}
                          title="Convert to card (first line = name, rest = description)"
                        >
                          <ArrowRightCircle size={12} />
                          {convertingScratchpad ? 'Converting...' : 'Convert to Card'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className={styles.grid}>
            {/* Recent Cards panel */}
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <h2 className={styles.cardTitle}>Recent Cards</h2>
                <Link to="/collections" className={styles.viewAllLink}>
                  View all <ArrowRight size={14} />
                </Link>
              </div>
              {recentCards.length === 0 ? (
                <div className={styles.emptyState}>
                  <div className={styles.emptyIcon}>
                    <FileText size={32} />
                  </div>
                  <div className={styles.emptyTitle}>No cards yet</div>
                  <div className={styles.emptyDescription}>
                    Cards help you organize tasks and track work across your boards.
                  </div>
                  <Link to="/collections" className={styles.emptyAction}>
                    <Plus size={14} /> Go to collections
                  </Link>
                </div>
              ) : (
                <div className={styles.taskList}>
                  {recentCards.map((card) => {
                    const dueDateInfo = getDueDateInfo(card);
                    const isCompleted = card.customFields?.completed === true;
                    return (
                      <div key={card.id} className={styles.taskRow} onContextMenu={(e) => handleCardContextMenu(e, card.id)}>
                        <button
                          className={`${styles.completeBtn}${isCompleted ? ` ${styles.completeBtnDone}` : ''}`}
                          onClick={() => void handleToggleComplete(card.id, isCompleted)}
                          title={isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
                          aria-label={isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
                        >
                          {isCompleted ? <CircleCheck size={15} /> : <Circle size={15} />}
                        </button>
                        <Link
                          to={`/cards/${card.id}`}
                          className={`${styles.taskItem}${quickViewCardId === card.id ? ` ${styles.taskItemActive}` : ''}`}
                          onClick={(e) => openQuickView(e, card.id)}
                        >
                          <div className={styles.taskInfo}>
                            <div className={`${styles.taskTitle}${isCompleted ? ` ${styles.taskTitleCompleted}` : ''}`}>{card.name}</div>
                            {card.description && (
                              <div className={styles.taskDue}>{stripMarkdown(card.description)}</div>
                            )}
                          </div>
                          <div className={styles.taskRight}>
                            {card.assignee && (
                              card.assignee.type === 'agent' ? (
                                <div className={styles.taskAssignee} title={card.assignee.firstName}>
                                  <AgentAvatar
                                    icon={card.assignee.avatarIcon || 'spark'}
                                    bgColor={card.assignee.avatarBgColor || '#1a1a2e'}
                                    logoColor={card.assignee.avatarLogoColor || '#e94560'}
                                    size={20}
                                  />
                                </div>
                              ) : (
                                <div className={styles.taskAssignee} title={`${card.assignee.firstName} ${card.assignee.lastName}`}>
                                  <span className={styles.taskAvatar}>
                                    {card.assignee.firstName[0]}{card.assignee.lastName[0]}
                                  </span>
                                </div>
                              )
                            )}
                            <PriorityBadge priority={(card.customFields?.priority as Priority) ?? null} size="sm" />
                            {dueDateInfo ? (
                              <span className={`${styles.dueDateChip} ${dueDateInfo.status === 'overdue' ? styles.dueDateChipOverdue : dueDateInfo.status === 'soon' ? styles.dueDateChipSoon : styles.dueDateChipNormal}`}>
                                {dueDateInfo.status === 'overdue' ? <AlertCircle size={10} /> : <CalendarDays size={10} />}
                                {dueDateInfo.label}
                              </span>
                            ) : (
                              <TimeAgo date={card.updatedAt ?? card.createdAt} className={styles.taskStatus} />
                            )}
                          </div>
                        </Link>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Recent Agent Activity panel */}
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <h2 className={styles.cardTitle}>Agent Activity</h2>
                <Link to="/monitor" className={styles.viewAllLink}>
                  View all <ArrowRight size={14} />
                </Link>
              </div>
              {recentRuns.length === 0 ? (
                <div className={styles.emptyState}>
                  <div className={styles.emptyIcon}>
                    <Activity size={32} />
                  </div>
                  <div className={styles.emptyTitle}>No agent runs yet</div>
                  <div className={styles.emptyDescription}>
                    Agent activity will show up here once your agents start running tasks.
                  </div>
                  <Link to="/agents" className={styles.emptyAction}>
                    <Plus size={14} /> Set up agents
                  </Link>
                </div>
              ) : (
                <div className={styles.taskList}>
                  {recentRuns.map((run) => {
                    const TriggerIcon = TRIGGER_CONFIG[run.triggerType].icon;
                    return (
                      <Link
                        key={run.id}
                        to="/monitor"
                        className={styles.taskItem}
                      >
                        <div className={styles.runStatusIcon}>
                          {run.status === 'running' && (
                            <span className={styles.runningDot} />
                          )}
                          {run.status === 'completed' && (
                            <CheckCircle2 size={16} className={styles.statusCompleted} />
                          )}
                          {run.status === 'error' && (
                            <XCircle size={16} className={styles.statusError} />
                          )}
                        </div>
                        <div className={styles.taskInfo}>
                          <div className={styles.taskTitle}>{run.agentName}</div>
                          <div className={styles.runMeta}>
                            <TriggerIcon size={11} />
                            <span>{TRIGGER_CONFIG[run.triggerType].label}</span>
                            {run.durationMs != null && (
                              <>
                                <span className={styles.runMetaSep} />
                                <span>{formatDuration(run.durationMs)}</span>
                              </>
                            )}
                          </div>
                        </div>
                        <TimeAgo date={run.startedAt} className={styles.taskStatus} />
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {quickViewCardId && (
        <CardQuickView
          cardId={quickViewCardId}
          onClose={() => setQuickViewCardId(null)}
          onCardUpdated={handleCardUpdated}
          cardIds={dashboardCardIds}
          onNavigate={setQuickViewCardId}
        />
      )}

      {weekAddDueDate && (
        <CreateCardModal
          onClose={() => setWeekAddDueDate(null)}
          onSubmit={handleWeekAddCard}
          showCollectionPicker
          defaultDueDate={weekAddDueDate}
        />
      )}

      {contextMenu && (() => {
        const card = [...myCards, ...recentCards].find((c) => c.id === contextMenu.cardId);
        const isCompleted = card?.customFields?.completed === true;
        const currentPriority = card?.customFields?.priority as Priority | undefined;
        const currentDueDate = card?.customFields?.dueDate as string | undefined;
        return (
          <div
            ref={contextMenuRef}
            className={styles.cardContextMenu}
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            <button
              className={styles.ctxMenuItem}
              onClick={() => { navigate(`/cards/${contextMenu.cardId}`); setContextMenu(null); }}
            >
              <ArrowRight size={13} />
              Open card
            </button>
            <button
              className={styles.ctxMenuItem}
              onClick={() => { window.open(`/cards/${contextMenu.cardId}`, '_blank'); setContextMenu(null); }}
            >
              <ExternalLink size={13} />
              Open in new tab
            </button>
            <button
              className={styles.ctxMenuItem}
              onClick={() => {
                const url = `${window.location.origin}/cards/${contextMenu.cardId}`;
                navigator.clipboard.writeText(url).then(() => toast.success('Link copied')).catch(() => toast.error('Failed to copy'));
                setContextMenu(null);
              }}
            >
              <Copy size={13} />
              Copy link
            </button>
            <button
              className={styles.ctxMenuItem}
              onClick={() => { void handleToggleComplete(contextMenu.cardId, isCompleted); setContextMenu(null); }}
            >
              {isCompleted ? <><Circle size={13} /> Mark incomplete</> : <><CircleCheck size={13} /> Mark complete</>}
            </button>
            <div className={styles.ctxMenuDivider} />
            <div className={styles.ctxMenuLabel}>
              <Flag size={12} />
              Priority
            </div>
            <div className={styles.ctxMenuPriorityRow}>
              {([
                { value: null, label: 'None', color: 'var(--color-text-tertiary)' },
                { value: 'high' as Priority, label: 'High', color: '#EF4444' },
                { value: 'medium' as Priority, label: 'Med', color: '#F59E0B' },
                { value: 'low' as Priority, label: 'Low', color: '#60A5FA' },
              ]).map(({ value, label, color }) => {
                const isActive = (value === null && !currentPriority) || currentPriority === value;
                return (
                  <button
                    key={label}
                    className={`${styles.ctxPriorityChip}${isActive ? ` ${styles.ctxPriorityChipActive}` : ''}`}
                    style={{ '--chip-color': color } as React.CSSProperties}
                    onClick={() => { void handleSetPriority(contextMenu.cardId, value); setContextMenu(null); }}
                  >
                    <span className={styles.ctxPriorityDot} />
                    {label}
                  </button>
                );
              })}
            </div>
            <div className={styles.ctxMenuDivider} />
            <div className={styles.ctxMenuLabel}>
              <CalendarDays size={12} />
              Due date
            </div>
            <div className={styles.ctxMenuDueDateRow}>
              <input
                type="date"
                className={styles.ctxMenuDueDateInput}
                value={currentDueDate ?? ''}
                onChange={(e) => { void handleSetDueDate(contextMenu.cardId, e.target.value || null); }}
                onClick={(e) => e.stopPropagation()}
              />
              {currentDueDate && (
                <button
                  className={styles.ctxMenuDueDateClear}
                  onClick={() => { void handleSetDueDate(contextMenu.cardId, null); setContextMenu(null); }}
                  title="Clear due date"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <div className={styles.ctxMenuQuickDates}>
              <QuickDateButtons
                currentValue={currentDueDate}
                onSelect={(value) => { void handleSetDueDate(contextMenu.cardId, value); setContextMenu(null); }}
              />
            </div>
          </div>
        );
      })()}
    </div>
  );
}
