import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  FileText,
  Search,
  X,
  CheckCircle2,
  Circle,
  CircleCheck,
  Plus,
  ChevronDown,
  ChevronRight,
  Flag,
  Tag,
  Layers,
  AlertTriangle,
  RotateCcw,
  FolderOpen,
  Calendar,
  ListChecks,
  Square,
  CheckSquare,
  Minus,
  Trash2,
} from 'lucide-react';
import { PriorityBadge } from '../components/PriorityBadge';
import type { Priority } from '../components/PriorityBadge';
import { DueDatePicker } from '../components/DueDatePicker';
import { PageHeader } from '../layout';
import { api, ApiError } from '../lib/api';
import { toast } from '../stores/toast';
import { useAuth } from '../stores/useAuth';
import { useConfirm } from '../hooks/useConfirm';
import { QuickDateButtons } from '../components/QuickDateButtons';
import { AgentAvatar } from '../components/AgentAvatar';
import { CardQuickView } from './boards/CardQuickView';
import { stripMarkdown } from '../lib/file-utils';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { highlightMatch } from '../components/SearchHighlight';
import styles from './MyCardsPage.module.css';

interface CardAssignee {
  id: string;
  firstName: string;
  lastName: string;
  type?: 'user' | 'agent';
  avatarIcon?: string | null;
  avatarBgColor?: string | null;
  avatarLogoColor?: string | null;
}

interface CardTag {
  id: string;
  name: string;
  color: string;
}

interface CardItem {
  id: string;
  name: string;
  description: string | null;
  collectionId: string;
  assignee: CardAssignee | null;
  tags?: CardTag[];
  customFields?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface CardsResponse {
  total: number;
  entries: CardItem[];
}

type DueDateStatus = 'overdue' | 'soon' | 'upcoming' | 'none';

interface DueDateInfo {
  label: string;
  status: DueDateStatus;
}

function getDueDateInfo(card: CardItem): DueDateInfo | null {
  const dueDate = card.customFields?.dueDate as string | undefined;
  if (!dueDate) return null;
  const due = new Date(dueDate);
  const now = new Date();
  const diffMs = due.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / 86400000);
  if (diffDays < 0) {
    const overdueDays = Math.abs(diffDays);
    return { label: overdueDays === 1 ? 'Overdue 1d' : `Overdue ${overdueDays}d`, status: 'overdue' };
  }
  if (diffDays === 0) return { label: 'Due today', status: 'soon' };
  if (diffDays === 1) return { label: 'Due tomorrow', status: 'soon' };
  if (diffDays <= 7) return { label: `Due in ${diffDays}d`, status: 'soon' };
  return { label: due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), status: 'upcoming' };
}

interface CardGroup {
  key: string;
  label: string;
  color?: string;
  cards: CardItem[];
}

type GroupByOption = 'dueDate' | 'priority' | 'none';

const GROUP_BY_LABELS: Record<GroupByOption, string> = {
  dueDate: 'Due date',
  priority: 'Priority',
  none: 'None',
};

function groupByDueDate(cards: CardItem[]): CardGroup[] {
  const overdue: CardItem[] = [];
  const soon: CardItem[] = [];
  const upcoming: CardItem[] = [];
  const none: CardItem[] = [];

  for (const card of cards) {
    const info = getDueDateInfo(card);
    if (!info) {
      none.push(card);
    } else if (info.status === 'overdue') {
      overdue.push(card);
    } else if (info.status === 'soon') {
      soon.push(card);
    } else {
      upcoming.push(card);
    }
  }

  // Sort within each group: priority first (high > medium > low > none), then due date asc
  const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const byDueAsc = (a: CardItem, b: CardItem) => {
    const ad = a.customFields?.dueDate as string | undefined;
    const bd = b.customFields?.dueDate as string | undefined;
    if (!ad && !bd) return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    if (!ad) return 1;
    if (!bd) return -1;
    return new Date(ad).getTime() - new Date(bd).getTime();
  };
  const byPriorityThenDue = (a: CardItem, b: CardItem) => {
    const pa = PRIORITY_ORDER[(a.customFields?.priority as string) ?? ''] ?? 3;
    const pb = PRIORITY_ORDER[(b.customFields?.priority as string) ?? ''] ?? 3;
    if (pa !== pb) return pa - pb;
    return byDueAsc(a, b);
  };

  overdue.sort(byPriorityThenDue);
  soon.sort(byPriorityThenDue);
  upcoming.sort(byPriorityThenDue);
  none.sort((a, b) => {
    const pa = PRIORITY_ORDER[(a.customFields?.priority as string) ?? ''] ?? 3;
    const pb = PRIORITY_ORDER[(b.customFields?.priority as string) ?? ''] ?? 3;
    if (pa !== pb) return pa - pb;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  const groups: CardGroup[] = [];
  if (overdue.length > 0) groups.push({ key: 'overdue', label: 'Overdue', cards: overdue });
  if (soon.length > 0) groups.push({ key: 'soon', label: 'Due soon', cards: soon });
  if (upcoming.length > 0) groups.push({ key: 'upcoming', label: 'Upcoming', cards: upcoming });
  if (none.length > 0) groups.push({ key: 'none', label: 'No due date', cards: none });

  return groups;
}

const PRIORITY_COLORS: Record<string, string> = {
  high: '#EF4444',
  medium: '#F59E0B',
  low: '#60A5FA',
};

function groupByPriority(cards: CardItem[]): CardGroup[] {
  const high: CardItem[] = [];
  const medium: CardItem[] = [];
  const low: CardItem[] = [];
  const noPriority: CardItem[] = [];

  for (const card of cards) {
    const p = card.customFields?.priority as string | undefined;
    if (p === 'high') high.push(card);
    else if (p === 'medium') medium.push(card);
    else if (p === 'low') low.push(card);
    else noPriority.push(card);
  }

  const byDueAsc = (a: CardItem, b: CardItem) => {
    const ad = a.customFields?.dueDate as string | undefined;
    const bd = b.customFields?.dueDate as string | undefined;
    if (!ad && !bd) return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    if (!ad) return 1;
    if (!bd) return -1;
    return new Date(ad).getTime() - new Date(bd).getTime();
  };

  high.sort(byDueAsc);
  medium.sort(byDueAsc);
  low.sort(byDueAsc);
  noPriority.sort(byDueAsc);

  const groups: CardGroup[] = [];
  if (high.length > 0) groups.push({ key: 'high', label: 'High priority', color: PRIORITY_COLORS.high, cards: high });
  if (medium.length > 0) groups.push({ key: 'medium', label: 'Medium priority', color: PRIORITY_COLORS.medium, cards: medium });
  if (low.length > 0) groups.push({ key: 'low', label: 'Low priority', color: PRIORITY_COLORS.low, cards: low });
  if (noPriority.length > 0) groups.push({ key: 'no-priority', label: 'No priority', cards: noPriority });

  return groups;
}

function groupCards(cards: CardItem[], groupBy: GroupByOption): CardGroup[] {
  if (groupBy === 'priority') return groupByPriority(cards);
  if (groupBy === 'dueDate') return groupByDueDate(cards);
  return [];
}

const PAGE_SIZE = 100;

export function MyCardsPage() {
  useDocumentTitle('My Cards');
  const { user } = useAuth();
  const navigate = useNavigate();
  const [cards, setCards] = useState<CardItem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalCount, setTotalCount] = useState(0); // total assigned cards regardless of completion status
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [search, setSearch] = useState('');
  const [hideCompleted, setHideCompleted] = useState<boolean>(
    () => localStorage.getItem('my-cards-page-hide-completed') !== 'false',
  );
  const [priorityFilter, setPriorityFilter] = useState<Priority | null>(
    () => (localStorage.getItem('my-cards-page-priority-filter') as Priority) || null,
  );
  const [dueDateFilter, setDueDateFilter] = useState<DueDateStatus | null>(
    () => (localStorage.getItem('my-cards-page-due-date-filter') as DueDateStatus) || null,
  );
  const [tagFilters, setTagFilters] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('my-cards-page-tag-filters');
      if (saved) return new Set(JSON.parse(saved) as string[]);
    } catch { /* ignore */ }
    return new Set();
  });
  const [groupBy, setGroupBy] = useState<GroupByOption>(
    () => (localStorage.getItem('my-cards-page-group-by') as GroupByOption) || 'dueDate',
  );
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(`my-cards-page-collapsed-groups-${groupBy}`);
      if (saved) return new Set(JSON.parse(saved) as string[]);
    } catch { /* ignore */ }
    return new Set();
  });
  const [quickViewCardId, setQuickViewCardId] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const cardRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [collectionNames, setCollectionNames] = useState<Map<string, string>>(new Map());
  const [collections, setCollections] = useState<{ id: string; name: string; isGeneral?: boolean }[]>([]);
  const [inlineAddName, setInlineAddName] = useState('');
  const [inlineAddSubmitting, setInlineAddSubmitting] = useState(false);
  const inlineAddRef = useRef<HTMLInputElement>(null);

  // Bulk selection
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [bulkActionsOpen, setBulkActionsOpen] = useState<'priority' | 'dueDate' | null>(null);
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const bulkBarRef = useRef<HTMLDivElement>(null);

  // Fetch collection names for context display on card rows
  useEffect(() => {
    api<{ entries: { id: string; name: string; isGeneral?: boolean }[]; total: number }>('/collections?limit=200')
      .then((data) => {
        setCollectionNames(new Map(data.entries.map((c) => [c.id, c.name])));
        setCollections(data.entries);
      })
      .catch(() => {}); // supplementary info — silently ignore failures
  }, []);

  // Persist tag filters to localStorage
  useEffect(() => {
    localStorage.setItem('my-cards-page-tag-filters', JSON.stringify([...tagFilters]));
  }, [tagFilters]);

  const fetchCards = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setFetchError(false);
    try {
      const qp = new URLSearchParams();
      qp.set('assigneeId', user.id);
      qp.set('limit', String(PAGE_SIZE));
      if (search.trim()) qp.set('search', search.trim());

      if (hideCompleted) {
        // Filter at the API level so active cards are never squeezed out by completed ones
        qp.set('completed', 'false');
        // Parallel: fetch active cards + total count (for progress bar)
        const totalQp = new URLSearchParams();
        totalQp.set('assigneeId', user.id);
        totalQp.set('countOnly', 'true');
        if (search.trim()) totalQp.set('search', search.trim());
        const [data, totalData] = await Promise.all([
          api<CardsResponse>(`/cards?${qp.toString()}`),
          api<{ total: number }>(`/cards?${totalQp.toString()}`),
        ]);
        setCards(data.entries);
        setTotal(data.total);
        setTotalCount(totalData.total);
      } else {
        const data = await api<CardsResponse>(`/cards?${qp.toString()}`);
        setCards(data.entries);
        setTotal(data.total);
        setTotalCount(data.total);
      }
    } catch (err) {
      setFetchError(true);
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to load cards');
    } finally {
      setLoading(false);
    }
  }, [user, search, hideCompleted]);

  useEffect(() => {
    const id = setTimeout(() => { void fetchCards(); }, search ? 300 : 0);
    return () => clearTimeout(id);
  }, [fetchCards, search]);

  const handleToggleComplete = useCallback(async (cardId: string, currentCompleted: boolean) => {
    const newCompleted = !currentCompleted;
    setCards((prev) =>
      prev.map((c) => c.id === cardId ? { ...c, customFields: { ...c.customFields, completed: newCompleted } } : c),
    );
    try {
      const card = cards.find((c) => c.id === cardId);
      const newCustomFields = { ...card?.customFields, completed: newCompleted };
      await api(`/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
      const name = card?.name ?? 'Card';
      const shortName = name.length > 30 ? name.slice(0, 30) + '...' : name;
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
      setCards((prev) =>
        prev.map((c) => c.id === cardId ? { ...c, customFields: { ...c.customFields, completed: currentCompleted } } : c),
      );
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to update card');
    }
  }, [cards]);

  const handlePriorityChange = useCallback(async (cardId: string, priority: Priority | null) => {
    const card = cards.find((c) => c.id === cardId);
    if (!card) return;
    const prevCustomFields = card.customFields ?? {};
    const newCustomFields = { ...prevCustomFields };
    if (priority) newCustomFields.priority = priority;
    else delete newCustomFields.priority;
    setCards((prev) =>
      prev.map((c) => c.id === cardId ? { ...c, customFields: newCustomFields } : c),
    );
    try {
      await api(`/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
    } catch (err) {
      setCards((prev) =>
        prev.map((c) => c.id === cardId ? { ...c, customFields: prevCustomFields } : c),
      );
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to update priority');
    }
  }, [cards]);

  const handleDueDateChange = useCallback(async (cardId: string, dueDate: string | null) => {
    const card = cards.find((c) => c.id === cardId);
    if (!card) return;
    const prevCustomFields = card.customFields ?? {};
    const newCustomFields = { ...prevCustomFields };
    if (dueDate) newCustomFields.dueDate = dueDate;
    else delete newCustomFields.dueDate;
    setCards((prev) =>
      prev.map((c) => c.id === cardId ? { ...c, customFields: newCustomFields } : c),
    );
    try {
      await api(`/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
    } catch (err) {
      setCards((prev) =>
        prev.map((c) => c.id === cardId ? { ...c, customFields: prevCustomFields } : c),
      );
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to update due date');
    }
  }, [cards]);

  const handleCardUpdated = useCallback((
    cardId: string,
    updates: { name?: string; description?: string | null; assigneeId?: string | null; customFields?: Record<string, unknown> },
  ) => {
    setCards((prev) => prev.map((c) => c.id === cardId ? { ...c, ...updates } : c));
  }, []);

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem(`my-cards-page-collapsed-groups-${groupBy}`, JSON.stringify([...next]));
      return next;
    });
  }, [groupBy]);

  const handleCompleteAllInGroup = useCallback(async (groupCards: CardItem[]) => {
    const incomplete = groupCards.filter((c) => c.customFields?.completed !== true);
    if (incomplete.length === 0) return;
    const ids = new Set(incomplete.map((c) => c.id));
    setCards((prev) =>
      prev.map((c) => ids.has(c.id) ? { ...c, customFields: { ...c.customFields, completed: true } } : c),
    );
    const results = await Promise.allSettled(
      incomplete.map((c) =>
        api(`/cards/${c.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ customFields: { ...c.customFields, completed: true } }),
        }),
      ),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      toast.error(`${failed} card${failed !== 1 ? 's' : ''} failed to update`);
    } else {
      toast.success(`${incomplete.length} card${incomplete.length !== 1 ? 's' : ''} completed`);
    }
  }, []);

  const openQuickView = useCallback((e: React.MouseEvent, cardId: string) => {
    if (e.metaKey || e.ctrlKey) return; // allow ctrl/cmd+click to open in new tab
    e.preventDefault();
    setQuickViewCardId(cardId);
  }, []);

  const handleInlineAdd = useCallback(async () => {
    const trimmed = inlineAddName.trim();
    if (!trimmed || inlineAddSubmitting || !user) return;
    // Prefer the general collection, fall back to the first available
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
      // Optimistically add the card to the list
      setCards((prev) => [card, ...prev]);
      setTotal((t) => t + 1);
      setTotalCount((t) => t + 1);
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

  // Close bulk dropdown on outside click
  useEffect(() => {
    if (!bulkActionsOpen) return;
    function handleClick(e: MouseEvent) {
      if (bulkBarRef.current && !bulkBarRef.current.contains(e.target as Node)) {
        setBulkActionsOpen(null);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [bulkActionsOpen]);

  // Clear selection when card list changes
  useEffect(() => {
    setSelectedCardIds(new Set());
  }, [search, hideCompleted, priorityFilter, dueDateFilter, tagFilters]);

  const toggleSelectCard = useCallback((cardId: string) => {
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }, []);

  const handleBulkComplete = useCallback(async () => {
    if (selectedCardIds.size === 0 || bulkProcessing) return;
    setBulkProcessing(true);
    const ids = [...selectedCardIds];
    const selectedCards = cards.filter((c) => ids.includes(c.id));
    // Optimistic update
    setCards((prev) =>
      prev.map((c) => ids.includes(c.id) ? { ...c, customFields: { ...c.customFields, completed: true } } : c),
    );
    const results = await Promise.allSettled(
      selectedCards.map((c) =>
        api(`/cards/${c.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ customFields: { ...c.customFields, completed: true } }),
        }),
      ),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      toast.error(`${failed} card${failed !== 1 ? 's' : ''} failed to update`);
    } else {
      toast.success(`${ids.length} card${ids.length !== 1 ? 's' : ''} completed`);
    }
    setSelectedCardIds(new Set());
    setBulkProcessing(false);
  }, [selectedCardIds, cards, bulkProcessing]);

  const handleBulkPriority = useCallback(async (priority: Priority | null) => {
    if (selectedCardIds.size === 0 || bulkProcessing) return;
    setBulkProcessing(true);
    setBulkActionsOpen(null);
    const ids = [...selectedCardIds];
    const selectedCards = cards.filter((c) => ids.includes(c.id));
    // Optimistic update
    setCards((prev) =>
      prev.map((c) => {
        if (!ids.includes(c.id)) return c;
        const newCf = { ...c.customFields };
        if (priority) newCf.priority = priority;
        else delete newCf.priority;
        return { ...c, customFields: newCf };
      }),
    );
    const results = await Promise.allSettled(
      selectedCards.map((c) => {
        const newCf = { ...c.customFields };
        if (priority) newCf.priority = priority;
        else delete newCf.priority;
        return api(`/cards/${c.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ customFields: newCf }),
        });
      }),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) toast.error(`${failed} card${failed !== 1 ? 's' : ''} failed to update`);
    else toast.success(`Priority updated for ${ids.length} card${ids.length !== 1 ? 's' : ''}`);
    setSelectedCardIds(new Set());
    setBulkProcessing(false);
  }, [selectedCardIds, cards, bulkProcessing]);

  const handleBulkDueDate = useCallback(async (dueDate: string) => {
    if (selectedCardIds.size === 0 || bulkProcessing) return;
    setBulkProcessing(true);
    setBulkActionsOpen(null);
    const ids = [...selectedCardIds];
    const selectedCards = cards.filter((c) => ids.includes(c.id));
    setCards((prev) =>
      prev.map((c) => {
        if (!ids.includes(c.id)) return c;
        return { ...c, customFields: { ...c.customFields, dueDate } };
      }),
    );
    const results = await Promise.allSettled(
      selectedCards.map((c) =>
        api(`/cards/${c.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ customFields: { ...c.customFields, dueDate } }),
        }),
      ),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) toast.error(`${failed} card${failed !== 1 ? 's' : ''} failed to update`);
    else toast.success(`Due date set for ${ids.length} card${ids.length !== 1 ? 's' : ''}`);
    setSelectedCardIds(new Set());
    setBulkProcessing(false);
  }, [selectedCardIds, cards, bulkProcessing]);

  const handleBulkDelete = useCallback(async () => {
    if (selectedCardIds.size === 0 || bulkProcessing) return;
    const count = selectedCardIds.size;
    const ok = await confirm({
      title: `Delete ${count} card${count !== 1 ? 's' : ''}`,
      message: `Are you sure you want to delete ${count} selected card${count !== 1 ? 's' : ''}? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!ok) return;
    setBulkProcessing(true);
    const ids = [...selectedCardIds];
    const results = await Promise.allSettled(
      ids.map((id) => api(`/cards/${id}`, { method: 'DELETE' })),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    const deleted = ids.length - failed;
    if (deleted > 0) {
      setCards((prev) => prev.filter((c) => !ids.includes(c.id) || results[ids.indexOf(c.id)]?.status === 'rejected'));
      setTotal((t) => Math.max(0, t - deleted));
      setTotalCount((t) => Math.max(0, t - deleted));
    }
    if (failed > 0) toast.error(`${failed} card${failed !== 1 ? 's' : ''} failed to delete`);
    else toast.success(`${deleted} card${deleted !== 1 ? 's' : ''} deleted`);
    setSelectedCardIds(new Set());
    setBulkProcessing(false);
  }, [selectedCardIds, bulkProcessing, confirm]);

  // When hiding completed, completedCount comes from total vs active API counts.
  // When showing all, we count directly from the fetched data.
  const completedCount = useMemo(() => {
    if (hideCompleted) return Math.max(0, totalCount - total);
    return cards.filter((c) => c.customFields?.completed === true).length;
  }, [hideCompleted, totalCount, total, cards]);
  const totalForProgress = hideCompleted ? totalCount : cards.length;
  const progress = totalForProgress > 0 ? Math.round((completedCount / totalForProgress) * 100) : 0;

  const activeCards = useMemo(() => {
    let filtered = hideCompleted ? cards.filter((c) => c.customFields?.completed !== true) : cards;
    if (priorityFilter) filtered = filtered.filter((c) => c.customFields?.priority === priorityFilter);
    if (dueDateFilter) filtered = filtered.filter((c) => {
      const info = getDueDateInfo(c);
      if (dueDateFilter === 'none') return !info;
      return info?.status === dueDateFilter;
    });
    if (tagFilters.size > 0) filtered = filtered.filter((c) => c.tags?.some((t) => tagFilters.has(t.id)));
    return filtered;
  }, [cards, hideCompleted, priorityFilter, dueDateFilter, tagFilters]);

  const cardGroups = useMemo(() => groupCards(activeCards, groupBy), [activeCards, groupBy]);

  const allVisibleCards = useMemo(
    () => groupBy === 'none'
      ? activeCards
      : cardGroups.filter((g) => !collapsedGroups.has(g.key)).flatMap((g) => g.cards),
    [groupBy, activeCards, cardGroups, collapsedGroups],
  );
  const quickViewCardIds = useMemo(() => allVisibleCards.map((c) => c.id), [allVisibleCards]);

  // Keyboard navigation: J/K to move, Enter to open quick view, X to toggle complete, Space to select
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if (quickViewCardId) return; // don't navigate when quick view is open

      // Ctrl/Cmd+A to select all visible cards
      if (e.key === 'a' && (e.metaKey || e.ctrlKey) && allVisibleCards.length > 0) {
        e.preventDefault();
        if (selectedCardIds.size === allVisibleCards.length) {
          setSelectedCardIds(new Set());
        } else {
          setSelectedCardIds(new Set(allVisibleCards.map((c) => c.id)));
        }
        return;
      }

      // Escape: clear selection first, then clear focus
      if (e.key === 'Escape') {
        e.preventDefault();
        if (selectedCardIds.size > 0) {
          setSelectedCardIds(new Set());
          setBulkActionsOpen(null);
        } else if (focusedIndex >= 0) {
          setFocusedIndex(-1);
        }
        return;
      }

      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        setFocusedIndex((prev) => {
          const max = allVisibleCards.length - 1;
          if (max < 0) return -1;
          if (e.key === 'j') return prev < max ? prev + 1 : max;
          return prev > 0 ? prev - 1 : 0;
        });
      } else if (e.key === ' ' && focusedIndex >= 0 && focusedIndex < allVisibleCards.length) {
        // Space to toggle selection of focused card
        e.preventDefault();
        toggleSelectCard(allVisibleCards[focusedIndex].id);
      } else if (e.key === 'Enter' && focusedIndex >= 0 && focusedIndex < allVisibleCards.length) {
        e.preventDefault();
        setQuickViewCardId(allVisibleCards[focusedIndex].id);
      } else if (e.key === 'x' && focusedIndex >= 0 && focusedIndex < allVisibleCards.length) {
        e.preventDefault();
        const card = allVisibleCards[focusedIndex];
        void handleToggleComplete(card.id, card.customFields?.completed === true);
      } else if (e.key === 'o' && focusedIndex >= 0 && focusedIndex < allVisibleCards.length) {
        e.preventDefault();
        navigate(`/cards/${allVisibleCards[focusedIndex].id}`);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [allVisibleCards, focusedIndex, quickViewCardId, handleToggleComplete, navigate, selectedCardIds, toggleSelectCard]);

  // Scroll focused card into view
  useEffect(() => {
    if (focusedIndex >= 0 && focusedIndex < allVisibleCards.length) {
      const el = cardRowRefs.current.get(allVisibleCards[focusedIndex].id);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focusedIndex, allVisibleCards]);

  // Reset focus when card list changes
  useEffect(() => {
    setFocusedIndex(-1);
  }, [search, hideCompleted, priorityFilter, dueDateFilter, tagFilters, groupBy]);

  const hasSelection = selectedCardIds.size > 0;

  function renderCardRow(card: CardItem, index: number) {
    const isCompleted = card.customFields?.completed === true;
    const isFocused = focusedIndex === index;
    const isSelected = selectedCardIds.has(card.id);
    return (
      <div
        key={card.id}
        className={`${styles.cardRow}${isFocused ? ` ${styles.cardRowFocused}` : ''}${isSelected ? ` ${styles.cardRowSelected}` : ''}`}
        ref={(el) => { if (el) cardRowRefs.current.set(card.id, el); else cardRowRefs.current.delete(card.id); }}
      >
        <button
          className={`${styles.selectBtn}${hasSelection ? ` ${styles.selectBtnVisible}` : ''}`}
          onClick={() => toggleSelectCard(card.id)}
          title={isSelected ? 'Deselect' : 'Select'}
          aria-label={isSelected ? 'Deselect' : 'Select'}
          tabIndex={-1}
        >
          {isSelected ? <CheckSquare size={16} /> : <Square size={16} />}
        </button>
        <button
          className={`${styles.completeBtn}${isCompleted ? ` ${styles.completeBtnDone}` : ''}${hasSelection ? ` ${styles.completeBtnShift}` : ''}`}
          onClick={() => void handleToggleComplete(card.id, isCompleted)}
          title={isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
          aria-label={isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
          tabIndex={-1}
        >
          {isCompleted ? <CircleCheck size={16} /> : <Circle size={16} />}
        </button>
        <Link
          to={`/cards/${card.id}`}
          className={`${styles.cardItem}${quickViewCardId === card.id ? ` ${styles.cardItemActive}` : ''}`}
          onClick={(e) => openQuickView(e, card.id)}
          tabIndex={-1}
        >
          <div className={styles.cardInfo}>
            <div className={`${styles.cardName}${isCompleted ? ` ${styles.cardNameCompleted}` : ''}`}>
              {highlightMatch(card.name, search)}
            </div>
            {card.description && (
              <div className={styles.cardDesc}>{highlightMatch(stripMarkdown(card.description), search)}</div>
            )}
            {collectionNames.get(card.collectionId) && (
              <div className={styles.cardCollection}>
                <FolderOpen size={11} />
                <span>{collectionNames.get(card.collectionId)}</span>
              </div>
            )}
          </div>
          <div className={styles.cardMeta}>
            {(() => {
              const cl = card.customFields?.checklist as { id: string; text: string; done: boolean }[] | undefined;
              if (!cl || cl.length === 0) return null;
              const done = cl.filter((i) => i.done).length;
              const allDone = done === cl.length;
              return (
                <span
                  className={`${styles.cardChecklist}${allDone ? ` ${styles.cardChecklistComplete}` : ''}`}
                  title={`Checklist: ${done}/${cl.length} done`}
                >
                  <ListChecks size={11} />
                  {done}/{cl.length}
                </span>
              );
            })()}
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
            <div onClick={(e) => e.stopPropagation()}>
              <PriorityBadge
                priority={(card.customFields?.priority as Priority) ?? null}
                size="sm"
                editable
                onChange={(p) => void handlePriorityChange(card.id, p)}
              />
            </div>
            {card.tags && card.tags.length > 0 && (
              <div className={styles.cardTagsGroup}>
                {card.tags.slice(0, 2).map((tag) => (
                  <span
                    key={tag.id}
                    className={styles.cardTagPill}
                    style={{ '--tag-color': tag.color } as React.CSSProperties}
                    title={tag.name}
                  >
                    {tag.name}
                  </span>
                ))}
                {card.tags.length > 2 && (
                  <span className={styles.cardTagMore} title={card.tags.slice(2).map((t) => t.name).join(', ')}>
                    +{card.tags.length - 2}
                  </span>
                )}
              </div>
            )}
            {card.assignee && card.assignee.type === 'agent' && (
              <div className={styles.agentAvatar}>
                <AgentAvatar
                  icon={card.assignee.avatarIcon || 'spark'}
                  bgColor={card.assignee.avatarBgColor || '#1a1a2e'}
                  logoColor={card.assignee.avatarLogoColor || '#e94560'}
                  size={18}
                />
              </div>
            )}
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
            <div onClick={(e) => e.stopPropagation()}>
              <DueDatePicker
                value={(card.customFields?.dueDate as string) ?? null}
                onChange={(d) => void handleDueDateChange(card.id, d)}
              />
            </div>
          </div>
        </Link>
      </div>
    );
  }

  const hasPriorities = useMemo(
    () => cards.some((c) => c.customFields?.priority),
    [cards],
  );

  const hasDueDates = useMemo(
    () => cards.some((c) => c.customFields?.dueDate),
    [cards],
  );

  const allTags = useMemo(() => {
    const map = new Map<string, CardTag>();
    for (const card of cards) {
      for (const tag of card.tags ?? []) {
        if (!map.has(tag.id)) map.set(tag.id, tag);
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [cards]);

  return (
    <div className={styles.page}>
      <PageHeader
        title="My Cards"
        description={`${totalCount} card${totalCount !== 1 ? 's' : ''} assigned to you`}
        actions={
          <button
            className={styles.createBtn}
            onClick={() => window.dispatchEvent(new CustomEvent('open-quick-create'))}
            title="Create a new card"
          >
            <Plus size={14} />
            New card
          </button>
        }
      />

      <div className={styles.toolbar}>
        <div className={styles.searchWrapper}>
          <Search size={14} className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            placeholder="Search your cards..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className={styles.searchClear} onClick={() => setSearch('')}>
              <X size={12} />
            </button>
          )}
        </div>
        {hasPriorities && (
          <div className={styles.priorityFilters}>
            <Flag size={12} className={styles.priorityFiltersIcon} />
            {(['high', 'medium', 'low'] as Priority[]).map((p) => (
              <button
                key={p}
                className={`${styles.priorityFilterBtn} ${styles[`priorityFilterBtn_${p}`]}${priorityFilter === p ? ` ${styles.priorityFilterBtnActive}` : ''}`}
                onClick={() => {
                  const next = priorityFilter === p ? null : p;
                  setPriorityFilter(next);
                  localStorage.setItem('my-cards-page-priority-filter', next ?? '');
                }}
                title={`Filter by ${p} priority`}
              >
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>
        )}
        {hasDueDates && (
          <div className={styles.dueDateFilters}>
            <Calendar size={12} className={styles.dueDateFiltersIcon} />
            {([
              ['overdue', 'Overdue'],
              ['soon', 'Due soon'],
              ['upcoming', 'Later'],
              ['none', 'No date'],
            ] as [DueDateStatus, string][]).map(([key, label]) => (
              <button
                key={key}
                className={`${styles.dueDateFilterBtn} ${styles[`dueDateFilterBtn_${key}`]}${dueDateFilter === key ? ` ${styles.dueDateFilterBtnActive}` : ''}`}
                onClick={() => {
                  const next = dueDateFilter === key ? null : key;
                  setDueDateFilter(next);
                  localStorage.setItem('my-cards-page-due-date-filter', next ?? '');
                }}
                title={`Filter by: ${label}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {completedCount > 0 && (
          <button
            className={`${styles.hideCompletedBtn}${!hideCompleted ? ` ${styles.hideCompletedBtnActive}` : ''}`}
            onClick={() => {
              const next = !hideCompleted;
              setHideCompleted(next);
              localStorage.setItem('my-cards-page-hide-completed', String(next));
            }}
          >
            <CheckCircle2 size={13} />
            {hideCompleted ? `Show ${completedCount} completed` : 'Hide completed'}
          </button>
        )}
        <div className={styles.groupByWrapper}>
          <Layers size={12} className={styles.groupByIcon} />
          <select
            className={styles.groupBySelect}
            value={groupBy}
            onChange={(e) => {
              const val = e.target.value as GroupByOption;
              setGroupBy(val);
              try {
                const saved = localStorage.getItem(`my-cards-page-collapsed-groups-${val}`);
                setCollapsedGroups(saved ? new Set(JSON.parse(saved) as string[]) : new Set());
              } catch {
                setCollapsedGroups(new Set());
              }
              localStorage.setItem('my-cards-page-group-by', val);
            }}
            title="Group cards by"
          >
            {(Object.keys(GROUP_BY_LABELS) as GroupByOption[]).map((opt) => (
              <option key={opt} value={opt}>
                {GROUP_BY_LABELS[opt]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {allTags.length > 0 && (
        <div className={styles.tagFiltersRow}>
          <Tag size={12} className={styles.tagFiltersIcon} />
          {allTags.map((tag) => {
            const isActive = tagFilters.has(tag.id);
            return (
              <button
                key={tag.id}
                className={`${styles.tagPill}${isActive ? ` ${styles.tagPillActive}` : ''}`}
                style={{ '--tag-color': tag.color } as React.CSSProperties}
                onClick={() =>
                  setTagFilters((prev) => {
                    const next = new Set(prev);
                    if (next.has(tag.id)) next.delete(tag.id);
                    else next.add(tag.id);
                    return next;
                  })
                }
                title={isActive ? `Remove filter: ${tag.name}` : `Filter by: ${tag.name}`}
              >
                {tag.name}
              </button>
            );
          })}
          {tagFilters.size > 0 && (
            <button
              className={styles.tagFiltersClear}
              onClick={() => setTagFilters(new Set())}
              title="Clear tag filters"
            >
              <X size={11} />
            </button>
          )}
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
          <button
            className={styles.inlineAddSubmit}
            onClick={() => void handleInlineAdd()}
            disabled={inlineAddSubmitting}
          >
            {inlineAddSubmitting ? 'Adding...' : 'Add'}
          </button>
        )}
      </div>

      {totalForProgress > 0 && (
        <div className={styles.progressRow}>
          <div className={styles.progressTrack}>
            <div
              className={`${styles.progressBar}${progress === 100 ? ` ${styles.progressBarComplete}` : ''}`}
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className={styles.progressLabel}>{completedCount}/{totalForProgress} done</span>
        </div>
      )}

      {loading ? (
        <div className={styles.loadingState}>
          {[0, 1, 2, 3].map((i) => <div key={i} className={styles.skeletonRow} />)}
        </div>
      ) : fetchError ? (
        <div className={styles.emptyState}>
          <AlertTriangle size={32} className={styles.emptyIcon} />
          <div className={styles.emptyTitle}>Failed to load cards</div>
          <div className={styles.emptyDesc}>Something went wrong while fetching your cards.</div>
          <button className={styles.retryBtn} onClick={() => void fetchCards()}>
            <RotateCcw size={14} />
            Try again
          </button>
        </div>
      ) : allVisibleCards.length === 0 ? (
        <div className={styles.emptyState}>
          {tagFilters.size > 0 && !search && !priorityFilter && !dueDateFilter ? (
            <>
              <Tag size={32} className={styles.emptyIcon} />
              <div className={styles.emptyTitle}>No cards with selected tags</div>
              <button className={styles.emptyClear} onClick={() => setTagFilters(new Set())}>Clear tag filters</button>
            </>
          ) : dueDateFilter && !search ? (
            <>
              <Calendar size={32} className={styles.emptyIcon} />
              <div className={styles.emptyTitle}>No {dueDateFilter === 'none' ? 'cards without a due date' : dueDateFilter === 'overdue' ? 'overdue cards' : dueDateFilter === 'soon' ? 'cards due soon' : 'upcoming cards'}</div>
              <button className={styles.emptyClear} onClick={() => { setDueDateFilter(null); localStorage.setItem('my-cards-page-due-date-filter', ''); }}>Clear filter</button>
            </>
          ) : priorityFilter && !search ? (
            <>
              <Flag size={32} className={styles.emptyIcon} />
              <div className={styles.emptyTitle}>No {priorityFilter} priority cards</div>
              <button className={styles.emptyClear} onClick={() => setPriorityFilter(null)}>Clear filter</button>
            </>
          ) : search ? (
            <>
              <Search size={32} className={styles.emptyIcon} />
              <div className={styles.emptyTitle}>No cards match "{search}"</div>
              <button className={styles.emptyClear} onClick={() => setSearch('')}>Clear search</button>
            </>
          ) : totalCount > 0 && hideCompleted ? (
            <>
              <CircleCheck size={32} className={styles.emptyIcon} />
              <div className={styles.emptyTitle}>All {totalCount} cards completed!</div>
              <button
                className={styles.emptyClear}
                onClick={() => { setHideCompleted(false); localStorage.setItem('my-cards-page-hide-completed', 'false'); }}
              >
                Show completed
              </button>
            </>
          ) : (
            <>
              <FileText size={32} className={styles.emptyIcon} />
              <div className={styles.emptyTitle}>No cards assigned to you</div>
              <div className={styles.emptyDesc}>Cards assigned to you will appear here.</div>
            </>
          )}
        </div>
      ) : groupBy !== 'none' && cardGroups.length > 0 && !search ? (
        // Grouped view
        <div className={styles.cardsList}>
          {(() => {
            let globalIdx = 0;
            return cardGroups.map((group) => {
              const isCollapsed = collapsedGroups.has(group.key);
              const groupStartIdx = globalIdx;
              if (!isCollapsed) globalIdx += group.cards.length;
              const headerClass = [
                styles.groupHeader,
                group.key === 'overdue' ? styles.groupHeader_overdue : '',
                group.key === 'soon' ? styles.groupHeader_soon : '',
              ].filter(Boolean).join(' ');
              const incompleteInGroup = group.cards.filter((c) => c.customFields?.completed !== true).length;
              return (
                <div key={group.key} className={styles.group}>
                  <div className={styles.groupHeaderRow}>
                    <button
                      className={headerClass}
                      onClick={() => toggleGroup(group.key)}
                      aria-expanded={!isCollapsed}
                    >
                      <span className={styles.groupChevron}>
                        {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                      </span>
                      {group.color && (
                        <span className={styles.groupDot} style={{ background: group.color }} />
                      )}
                      <span className={styles.groupLabel}>{group.label}</span>
                      <span className={styles.groupCount}>{group.cards.length}</span>
                    </button>
                    {incompleteInGroup > 0 && (
                      <button
                        className={styles.groupCompleteAllBtn}
                        onClick={(e) => { e.stopPropagation(); void handleCompleteAllInGroup(group.cards); }}
                        title={`Mark all ${incompleteInGroup} as complete`}
                      >
                        <CheckCircle2 size={12} />
                        Complete all
                      </button>
                    )}
                  </div>
                  {!isCollapsed && (
                    <div className={styles.groupCards}>
                      {group.cards.map((card, i) => renderCardRow(card, groupStartIdx + i))}
                    </div>
                  )}
                </div>
              );
            });
          })()}
          {total > PAGE_SIZE && (
            <div className={styles.moreNote}>
              Showing {PAGE_SIZE} of {total} cards. Use search to find specific cards.
            </div>
          )}
        </div>
      ) : (
        // Flat list — shown during search, when groupBy is 'none', or no groups exist
        <div className={styles.cardsList}>
          {allVisibleCards.map((card, i) => renderCardRow(card, i))}
          {total > PAGE_SIZE && (
            <div className={styles.moreNote}>
              Showing {PAGE_SIZE} of {total} cards. Use search to find specific cards.
            </div>
          )}
        </div>
      )}

      {quickViewCardId && (
        <CardQuickView
          cardId={quickViewCardId}
          onClose={() => setQuickViewCardId(null)}
          onCardUpdated={handleCardUpdated}
          cardIds={quickViewCardIds}
          onNavigate={setQuickViewCardId}
        />
      )}

      {/* Bulk action bar */}
      {selectedCardIds.size > 0 && (
        <div className={styles.bulkBar} ref={bulkBarRef}>
          <div className={styles.bulkBarInner}>
            <button
              className={styles.bulkSelectAll}
              onClick={() => {
                if (selectedCardIds.size === allVisibleCards.length) {
                  setSelectedCardIds(new Set());
                } else {
                  setSelectedCardIds(new Set(allVisibleCards.map((c) => c.id)));
                }
              }}
              title={selectedCardIds.size === allVisibleCards.length ? 'Deselect all' : 'Select all'}
            >
              {selectedCardIds.size === allVisibleCards.length
                ? <CheckSquare size={14} />
                : selectedCardIds.size > 0
                  ? <Minus size={14} />
                  : <Square size={14} />}
            </button>
            <span className={styles.bulkCount}>
              {selectedCardIds.size} selected
            </span>

            <div className={styles.bulkDivider} />

            {/* Priority */}
            <div className={styles.bulkActionWrap}>
              <button
                className={styles.bulkActionBtn}
                onClick={() => setBulkActionsOpen(bulkActionsOpen === 'priority' ? null : 'priority')}
                disabled={bulkProcessing}
                title="Set priority"
              >
                <Flag size={13} />
                Priority
              </button>
              {bulkActionsOpen === 'priority' && (
                <div className={styles.bulkDropdown}>
                  {([['high', 'High', '#EF4444'], ['medium', 'Medium', '#F59E0B'], ['low', 'Low', '#60A5FA']] as [Priority, string, string][]).map(([value, label, color]) => (
                    <button
                      key={value}
                      className={styles.bulkDropdownItem}
                      onClick={() => void handleBulkPriority(value)}
                    >
                      <span className={styles.bulkPriorityDot} style={{ background: color }} />
                      {label}
                    </button>
                  ))}
                  <button
                    className={styles.bulkDropdownItem}
                    onClick={() => void handleBulkPriority(null)}
                  >
                    <X size={11} />
                    None
                  </button>
                </div>
              )}
            </div>

            {/* Due date */}
            <div className={styles.bulkActionWrap}>
              <button
                className={styles.bulkActionBtn}
                onClick={() => setBulkActionsOpen(bulkActionsOpen === 'dueDate' ? null : 'dueDate')}
                disabled={bulkProcessing}
                title="Set due date"
              >
                <Calendar size={13} />
                Due date
              </button>
              {bulkActionsOpen === 'dueDate' && (
                <div className={styles.bulkDropdown}>
                  <QuickDateButtons
                    currentValue=""
                    onSelect={(d) => void handleBulkDueDate(d)}
                    size="md"
                  />
                </div>
              )}
            </div>

            {/* Complete */}
            <button
              className={styles.bulkActionBtn}
              onClick={() => void handleBulkComplete()}
              disabled={bulkProcessing}
              title="Mark selected as complete"
            >
              <CheckCircle2 size={13} />
              Complete
            </button>

            {/* Delete */}
            <button
              className={`${styles.bulkActionBtn} ${styles.bulkActionBtnDanger}`}
              onClick={() => void handleBulkDelete()}
              disabled={bulkProcessing}
              title="Delete selected cards"
            >
              <Trash2 size={13} />
              Delete
            </button>

            <div className={styles.bulkDivider} />

            <button
              className={styles.bulkClearBtn}
              onClick={() => { setSelectedCardIds(new Set()); setBulkActionsOpen(null); }}
              title="Clear selection"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {confirmDialog}
    </div>
  );
}
