import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Plus, FileText, Trash2, User, X, CalendarDays, Tag, CornerDownLeft, Star, Link2, ExternalLink, Users, AlertCircle, CheckSquare, Square, MinusSquare, UserCheck, ChevronDown, LayoutList, Table2, ChevronUp, Pencil, Circle, CircleCheck, FolderInput, Layers, ChevronRight, Flag, Check, ListChecks, Bookmark, BookmarkPlus, Download, Copy, Bot, Play, Settings2 } from 'lucide-react';
import { PageHeader } from '../../layout';
import { Button, EntitySwitcher, CreateCardModal, Modal } from '../../ui';
import { AgentAvatar } from '../../components/AgentAvatar';
import { PriorityBadge } from '../../components/PriorityBadge';
import type { Priority } from '../../components/PriorityBadge';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../stores/toast';
import { useConfirm } from '../../hooks/useConfirm';
import { clearPreferredCollectionId, setPreferredCollectionId } from '../../lib/navigation-preferences';
import { addRecentVisit } from '../../lib/recent-visits';
import { useWorkspace } from '../../stores/WorkspaceContext';
import { useFavorites } from '../../hooks/useFavorites';
import { useAuth } from '../../stores/useAuth';
import { TimeAgo } from '../../components/TimeAgo';
import { stripMarkdown } from '../../lib/file-utils';
import styles from './CollectionDetailPage.module.css';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useDebounce } from '../../hooks/useDebounce';
import { CardQuickView } from '../boards/CardQuickView';

interface CardTag {
  id: string;
  name: string;
  color: string;
}

interface Card {
  id: string;
  name: string;
  description: string | null;
  assigneeId: string | null;
  customFields?: Record<string, unknown>;
  assignee: {
    id: string; firstName: string; lastName: string; type?: 'user' | 'agent';
    avatarIcon?: string | null; avatarBgColor?: string | null; avatarLogoColor?: string | null;
  } | null;
  tags: CardTag[];
  createdAt: string;
  updatedAt: string;
}

interface AgentBatchConfig {
  agentId?: string | null;
  prompt?: string | null;
  maxParallel?: number;
  cardFilters?: {
    search?: string;
    assigneeId?: string;
    completed?: boolean;
    priority?: 'high' | 'medium' | 'low';
    tagId?: string;
  };
}

interface Collection {
  id: string;
  name: string;
  description: string | null;
  isGeneral?: boolean;
  agentBatchConfig?: AgentBatchConfig | null;
}

interface CardsResponse {
  total: number;
  entries: Card[];
}

type SortOption = 'updated-desc' | 'updated-asc' | 'name-asc' | 'name-desc' | 'created-desc' | 'created-asc' | 'due-asc' | 'due-desc';
type DueDateFilter = 'overdue' | 'due-today' | 'due-week' | 'no-due-date';
type PriorityFilter = 'high' | 'medium' | 'low' | 'none';
type GroupByOption = 'none' | 'assignee' | 'dueDate' | 'status';
const SORT_STORAGE_KEY = 'collection-cards-sort';
const VIEW_MODE_STORAGE_KEY = 'collection-cards-view';
const HIDE_COMPLETED_KEY = 'collection-cards-hide-completed';
const GROUP_BY_STORAGE_KEY = 'collection-cards-group-by';
type ViewMode = 'cards' | 'table';
const PAGE_SIZE = 50;

/* ── Saved Views ───────────────────────────────────── */

interface SavedView {
  id: string;
  name: string;
  sort: SortOption;
  groupBy: GroupByOption;
  viewMode: ViewMode;
  hideCompleted: boolean;
  tagIds: string[];
  assigneeIds: string[];
  dueDateFilters: DueDateFilter[];
  priorityFilters: PriorityFilter[];
}

const SAVED_VIEWS_KEY = 'collection-saved-views';

function loadSavedViews(): SavedView[] {
  try {
    const raw = localStorage.getItem(SAVED_VIEWS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function persistSavedViews(views: SavedView[]) {
  try { localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views)); } catch { /* ignore */ }
}

function isGeneralCollection(collection: Collection): boolean {
  if (collection.isGeneral === true) return true;
  return collection.name.trim().toLowerCase() === 'general';
}

/* ── Persisted filter state per collection ─────────────── */

interface SavedCollectionFilterState {
  tagIds: string[];
  assigneeIds: string[];
  dueDateFilters: string[];
  priorityFilters: string[];
}

function getCollectionFilterState(collectionId: string): SavedCollectionFilterState {
  try {
    const raw = localStorage.getItem(`collection-filters-${collectionId}`);
    if (raw) return JSON.parse(raw) as SavedCollectionFilterState;
  } catch { /* ignore */ }
  return { tagIds: [], assigneeIds: [], dueDateFilters: [], priorityFilters: [] };
}

function saveCollectionFilterState(collectionId: string, state: SavedCollectionFilterState) {
  try {
    if (!state.tagIds.length && !state.assigneeIds.length && !state.dueDateFilters.length && !state.priorityFilters.length) {
      localStorage.removeItem(`collection-filters-${collectionId}`);
    } else {
      localStorage.setItem(`collection-filters-${collectionId}`, JSON.stringify(state));
    }
  } catch { /* ignore */ }
}

type AssigneeFilterId = string | '__unassigned__';

interface WorkspaceUser {
  id: string;
  firstName: string;
  lastName: string;
}

interface WorkspaceAgent {
  id: string;
  name: string;
  avatarIcon?: string | null;
  avatarBgColor?: string | null;
  avatarLogoColor?: string | null;
}

const PRIORITY_OPTIONS: { value: Priority; label: string; color: string }[] = [
  { value: 'high', label: 'High', color: '#EF4444' },
  { value: 'medium', label: 'Medium', color: '#F59E0B' },
  { value: 'low', label: 'Low', color: '#60A5FA' },
];

/** Inline date picker - shows the current due date or a "Set date" trigger, opens native date input on click */
function InlineDatePicker({ value, onChange, isOverdue, isSoon }: {
  value: string | null;
  onChange: (value: string | null) => void;
  isOverdue?: boolean;
  isSoon?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    inputRef.current?.showPicker?.();
    inputRef.current?.focus();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    onChange(val || null);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(null);
  };

  const due = value ? new Date(value) : null;
  const label = due ? due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;

  return (
    <div className={styles.inlineDatePicker}>
      <button
        type="button"
        className={`${styles.inlineDateTrigger}${isOverdue ? ` ${styles.inlineDateOverdue}` : isSoon ? ` ${styles.inlineDateSoon}` : ''}${!value ? ` ${styles.inlineDateEmpty}` : ''}`}
        onClick={handleClick}
        title={value ? `Due: ${value}` : 'Set due date'}
      >
        <CalendarDays size={10} />
        {label ?? 'Set date'}
      </button>
      {value && (
        <button type="button" className={styles.inlineDateClear} onClick={handleClear} title="Clear due date">
          <X size={9} />
        </button>
      )}
      <input
        ref={inputRef}
        type="date"
        className={styles.inlineDateInput}
        value={value ?? ''}
        onChange={handleChange}
        tabIndex={-1}
      />
    </div>
  );
}

export function CollectionDetailPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { activeWorkspace } = useWorkspace();
  const { user } = useAuth();
  const { isFavorite, toggleFavorite } = useFavorites();
  const [searchParams, setSearchParams] = useSearchParams();
  const [collection, setCollection] = useState<Collection | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState(() => searchParams.get('q') ?? '');
  const [sort, setSort] = useState<SortOption>(
    () => (searchParams.get('sort') as SortOption) || (localStorage.getItem(SORT_STORAGE_KEY) as SortOption) || 'updated-desc',
  );
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => (localStorage.getItem(VIEW_MODE_STORAGE_KEY) as ViewMode) || 'cards',
  );
  const [tableSortKey, setTableSortKey] = useState<'name' | 'assignee' | 'priority' | 'due' | 'updated'>('updated');
  const [tableSortAsc, setTableSortAsc] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [deletingCollection, setDeletingCollection] = useState(false);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(() => {
    if (!id) return new Set();
    return new Set(getCollectionFilterState(id).tagIds);
  });
  const [selectedDueDateFilters, setSelectedDueDateFilters] = useState<Set<DueDateFilter>>(() => {
    if (!id) return new Set();
    const saved = getCollectionFilterState(id).dueDateFilters;
    return new Set(saved.filter((v) => ['overdue', 'due-today', 'due-week', 'no-due-date'].includes(v)) as DueDateFilter[]);
  });
  const [selectedPriorityFilters, setSelectedPriorityFilters] = useState<Set<PriorityFilter>>(() => {
    if (!id) return new Set();
    const saved = getCollectionFilterState(id).priorityFilters;
    return new Set(saved.filter((v) => ['high', 'medium', 'low', 'none'].includes(v)) as PriorityFilter[]);
  });
  const [quickAddName, setQuickAddName] = useState('');
  const [quickAddSaving, setQuickAddSaving] = useState(false);
  const [total, setTotal] = useState(0);
  const [totalCompleted, setTotalCompleted] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [quickViewCardId, setQuickViewCardId] = useState<string | null>(null);
  const [selectedAssigneeIds, setSelectedAssigneeIds] = useState<Set<AssigneeFilterId>>(() => {
    if (!id) return new Set();
    return new Set(getCollectionFilterState(id).assigneeIds);
  });
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [bulkCompleting, setBulkCompleting] = useState(false);
  const [bulkUpdatingPriority, setBulkUpdatingPriority] = useState(false);
  const [bulkUpdatingDueDate, setBulkUpdatingDueDate] = useState(false);
  const [bulkTagging, setBulkTagging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showPriorityDropdown, setShowPriorityDropdown] = useState(false);
  const [showDueDatePicker, setShowDueDatePicker] = useState(false);
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const [workspaceTags, setWorkspaceTags] = useState<CardTag[]>([]);
  const [workspaceTagsLoaded, setWorkspaceTagsLoaded] = useState(false);
  const [showBulkMoveDropdown, setShowBulkMoveDropdown] = useState(false);
  const [bulkMoving, setBulkMoving] = useState(false);
  const bulkMoveDropdownRef = useRef<HTMLDivElement>(null);
  const [hideCompleted, setHideCompleted] = useState<boolean>(
    () => localStorage.getItem(HIDE_COMPLETED_KEY) !== 'false',
  );
  const [showAssignDropdown, setShowAssignDropdown] = useState(false);
  const [workspaceUsers, setWorkspaceUsers] = useState<WorkspaceUser[]>([]);
  const [workspaceAgents, setWorkspaceAgents] = useState<WorkspaceAgent[]>([]);
  const [assigneesLoaded, setAssigneesLoaded] = useState(false);
  const assignDropdownRef = useRef<HTMLDivElement>(null);
  const priorityDropdownRef = useRef<HTMLDivElement>(null);
  const dueDatePickerRef = useRef<HTMLDivElement>(null);
  const tagDropdownRef = useRef<HTMLDivElement>(null);
  const [focusedCardIndex, setFocusedCardIndex] = useState<number>(-1);
  const lastSelectedIndexRef = useRef<number | null>(null);
  const cardListRef = useRef<HTMLDivElement>(null);
  const debouncedSearch = useDebounce(search, 300);
  useDocumentTitle(collection?.name ?? 'Collection');
  const filterLoadedRef = useRef(id ?? null);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [editingCardName, setEditingCardName] = useState('');
  const [moveCardId, setMoveCardId] = useState<string | null>(null);
  const [moveCollections, setMoveCollections] = useState<{ id: string; name: string }[]>([]);
  const [moveCollectionsLoading, setMoveCollectionsLoading] = useState(false);
  const moveDropdownRef = useRef<HTMLDivElement>(null);
  const pendingDeleteTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [editingColName, setEditingColName] = useState(false);
  const [draftColName, setDraftColName] = useState('');
  const [savingColName, setSavingColName] = useState(false);
  const colNameInputRef = useRef<HTMLInputElement>(null);
  const [groupBy, setGroupBy] = useState<GroupByOption>(
    () => (localStorage.getItem(GROUP_BY_STORAGE_KEY) as GroupByOption) || 'none',
  );
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  /* ── Agent Batch Run state ── */
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [batchAgentId, setBatchAgentId] = useState('');
  const [batchPrompt, setBatchPrompt] = useState('');
  const [batchMaxParallel, setBatchMaxParallel] = useState(3);
  const [batchFilterSearch, setBatchFilterSearch] = useState('');
  const [batchFilterCompleted, setBatchFilterCompleted] = useState<'all' | 'incomplete' | 'completed'>('all');
  const [batchFilterPriority, setBatchFilterPriority] = useState<'' | 'high' | 'medium' | 'low'>('');
  const [batchFilterTagId, setBatchFilterTagId] = useState('');
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchSaving, setBatchSaving] = useState(false);
  const [batchAgents, setBatchAgents] = useState<{ id: string; name: string; avatarIcon?: string | null; avatarBgColor?: string | null; avatarLogoColor?: string | null }[]>([]);
  const [batchAgentsLoaded, setBatchAgentsLoaded] = useState(false);
  const [showBatchAgentPicker, setShowBatchAgentPicker] = useState(false);
  const batchAgentPickerRef = useRef<HTMLDivElement>(null);

  /* ── Saved Views state ── */
  const [savedViews, setSavedViews] = useState<SavedView[]>(loadSavedViews);
  const [showSavedViewsDropdown, setShowSavedViewsDropdown] = useState(false);
  const [savingViewName, setSavingViewName] = useState('');
  const [showSaveViewInput, setShowSaveViewInput] = useState(false);
  const savedViewsDropdownRef = useRef<HTMLDivElement>(null);
  const saveViewInputRef = useRef<HTMLInputElement>(null);

  // Close saved views dropdown on outside click
  useEffect(() => {
    if (!showSavedViewsDropdown) return;
    const handler = (e: MouseEvent) => {
      if (savedViewsDropdownRef.current && !savedViewsDropdownRef.current.contains(e.target as Node)) {
        setShowSavedViewsDropdown(false);
        setShowSaveViewInput(false);
        setSavingViewName('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSavedViewsDropdown]);

  // Focus save view input when shown
  useEffect(() => {
    if (showSaveViewInput) setTimeout(() => saveViewInputRef.current?.focus(), 0);
  }, [showSaveViewInput]);

  function handleSaveView() {
    const name = savingViewName.trim();
    if (!name) return;
    const view: SavedView = {
      id: Date.now().toString(36),
      name,
      sort,
      groupBy,
      viewMode,
      hideCompleted,
      tagIds: [...selectedTagIds],
      assigneeIds: [...selectedAssigneeIds],
      dueDateFilters: [...selectedDueDateFilters],
      priorityFilters: [...selectedPriorityFilters],
    };
    const updated = [...savedViews, view];
    setSavedViews(updated);
    persistSavedViews(updated);
    setSavingViewName('');
    setShowSaveViewInput(false);
    toast.success(`View "${name}" saved`);
  }

  function handleApplyView(view: SavedView) {
    setSort(view.sort);
    localStorage.setItem(SORT_STORAGE_KEY, view.sort);
    setGroupBy(view.groupBy);
    localStorage.setItem(GROUP_BY_STORAGE_KEY, view.groupBy);
    setViewMode(view.viewMode);
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, view.viewMode);
    setHideCompleted(view.hideCompleted);
    localStorage.setItem(HIDE_COMPLETED_KEY, String(view.hideCompleted));
    setSelectedTagIds(new Set(view.tagIds));
    setSelectedAssigneeIds(new Set(view.assigneeIds));
    setSelectedDueDateFilters(new Set(view.dueDateFilters));
    setSelectedPriorityFilters(new Set(view.priorityFilters));
    setShowSavedViewsDropdown(false);
    toast.success(`View "${view.name}" applied`);
  }

  function handleDeleteView(viewId: string) {
    const updated = savedViews.filter((v) => v.id !== viewId);
    setSavedViews(updated);
    persistSavedViews(updated);
  }

  const recoverFromMissingCollection = useCallback(async () => {
    try {
      const res = await api<{ entries: { id: string }[] }>('/collections?limit=100');
      const fallbackCollectionId = res.entries[0]?.id;
      if (!fallbackCollectionId || fallbackCollectionId === id) {
        clearPreferredCollectionId();
        navigate('/collections?list=1', { replace: true });
        return;
      }
      setPreferredCollectionId(fallbackCollectionId);
      navigate(`/collections/${fallbackCollectionId}`, { replace: true });
    } catch {
      clearPreferredCollectionId();
      navigate('/collections?list=1', { replace: true });
    }
  }, [id, navigate]);

  const fetchData = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    setCollection(null);
    setCards([]);
    setTotal(0);
    setTotalCompleted(null);
    try {
      const qp = new URLSearchParams();
      if (debouncedSearch) qp.set('search', encodeURIComponent(debouncedSearch));
      qp.set('limit', String(PAGE_SIZE));
      qp.set('offset', '0');
      const [collectionData, cardsData] = await Promise.all([
        api<Collection>(`/collections/${id}`),
        api<CardsResponse>(`/collections/${id}/cards?${qp.toString()}`),
      ]);
      setCollection(collectionData);
      setCards(cardsData.entries);
      setTotal(cardsData.total);
      addRecentVisit({ type: 'collection', id: collectionData.id, name: collectionData.name, path: `/collections/${collectionData.id}` });
      // Fetch accurate completion count for progress bar (non-blocking)
      api<{ total: number }>(`/cards?collectionId=${id}&completed=true&countOnly=true`)
        .then(r => setTotalCompleted(r.total))
        .catch(() => {});
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 404) {
          setError('Collection not found');
          void recoverFromMissingCollection();
          return;
        }
        setError(err.message);
      } else {
        setError('Failed to load collection');
      }
    } finally {
      setLoading(false);
    }
  }, [id, debouncedSearch, recoverFromMissingCollection]);

  const handleLoadMore = useCallback(async () => {
    if (!id || loadingMore) return;
    setLoadingMore(true);
    try {
      const qp = new URLSearchParams();
      if (debouncedSearch) qp.set('search', encodeURIComponent(debouncedSearch));
      qp.set('limit', String(PAGE_SIZE));
      qp.set('offset', String(cards.length));
      const data = await api<CardsResponse>(`/collections/${id}/cards?${qp.toString()}`);
      setCards((prev) => [...prev, ...data.entries]);
      setTotal(data.total);
    } catch {
      toast.error('Failed to load more cards');
    } finally {
      setLoadingMore(false);
    }
  }, [id, debouncedSearch, cards.length, loadingMore]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!collection || !activeWorkspace) return;
    if (!activeWorkspace.collectionIds.includes(collection.id)) {
      void recoverFromMissingCollection();
    }
  }, [collection, activeWorkspace, recoverFromMissingCollection]);

  useEffect(() => {
    if (!collection?.id) return;
    setPreferredCollectionId(collection.id);
  }, [collection?.id]);

  // Restore filter state when navigating to a different collection
  useEffect(() => {
    if (!id || filterLoadedRef.current === id) return;
    filterLoadedRef.current = id;
    const saved = getCollectionFilterState(id);
    setSelectedTagIds(new Set(saved.tagIds));
    setSelectedAssigneeIds(new Set(saved.assigneeIds));
    setSelectedDueDateFilters(new Set(saved.dueDateFilters.filter((v) => ['overdue', 'due-today', 'due-week', 'no-due-date'].includes(v)) as DueDateFilter[]));
    setSelectedPriorityFilters(new Set(saved.priorityFilters.filter((v) => ['high', 'medium', 'low', 'none'].includes(v)) as PriorityFilter[]));
  }, [id]);

  // Persist filter state when filters change
  useEffect(() => {
    if (!id) return;
    saveCollectionFilterState(id, {
      tagIds: [...selectedTagIds],
      assigneeIds: [...selectedAssigneeIds],
      dueDateFilters: [...selectedDueDateFilters],
      priorityFilters: [...selectedPriorityFilters],
    });
  }, [id, selectedTagIds, selectedAssigneeIds, selectedDueDateFilters, selectedPriorityFilters]);

  // Clean up pending delete timers on unmount
  useEffect(() => {
    const timers = pendingDeleteTimers;
    return () => {
      for (const t of timers.current.values()) clearTimeout(t);
      timers.current.clear();
    };
  }, []);

  const shouldOpenCreateCard = searchParams.get('newCard') === '1';

  useEffect(() => {
    if (!shouldOpenCreateCard) return;
    setShowCreate(true);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('newCard');
    setSearchParams(nextParams, { replace: true });
  }, [shouldOpenCreateCard, searchParams, setSearchParams]);

  async function handleCreateCard(data: { name: string; description: string | null; assigneeId: string | null; tagIds: string[]; linkedCardIds: string[]; dueDate?: string; priority?: string }) {
    if (!id) return;
    const cf: Record<string, unknown> = {};
    if (data.dueDate) cf.dueDate = data.dueDate;
    if (data.priority) cf.priority = data.priority;
    const card = await api<{ id: string }>('/cards', {
      method: 'POST',
      body: JSON.stringify({
        collectionId: id,
        name: data.name,
        description: data.description,
        assigneeId: data.assigneeId,
        ...(Object.keys(cf).length > 0 ? { customFields: cf } : {}),
      }),
    });

    // Attach tags and links in parallel
    await Promise.all([
      ...data.tagIds.map((tagId) =>
        api(`/cards/${card.id}/tags`, { method: 'POST', body: JSON.stringify({ tagId }) }),
      ),
      ...data.linkedCardIds.map((targetCardId) =>
        api(`/cards/${card.id}/links`, { method: 'POST', body: JSON.stringify({ targetCardId }) }),
      ),
    ]);

    fetchData();
  }

  function handleSortChange(value: SortOption) {
    setSort(value);
    localStorage.setItem(SORT_STORAGE_KEY, value);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('sort', value);
      return next;
    }, { replace: true });
  }

  function handleViewModeChange(mode: ViewMode) {
    setViewMode(mode);
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  }

  function handleTableSort(key: 'name' | 'assignee' | 'priority' | 'due' | 'updated') {
    if (tableSortKey === key) {
      setTableSortAsc((prev) => !prev);
    } else {
      setTableSortKey(key);
      setTableSortAsc(key === 'name');
    }
  }

  async function handleQuickAdd() {
    const name = quickAddName.trim();
    if (!name || !id || quickAddSaving) return;
    setQuickAddSaving(true);
    try {
      await api('/cards', {
        method: 'POST',
        body: JSON.stringify({ collectionId: id, name }),
      });
      setQuickAddName('');
      fetchData();
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error(err.message);
      } else {
        toast.error('Failed to create card');
      }
    } finally {
      setQuickAddSaving(false);
    }
  }

  function handleDeleteCard(cardId: string, cardName: string) {
    const prevCards = cards;
    const deletedCard = cards.find((c) => c.id === cardId);
    const wasCompleted = deletedCard?.customFields?.completed === true;

    // Optimistically remove the card
    setCards((prev) => prev.filter((c) => c.id !== cardId));
    setTotal((prev) => prev - 1);
    if (wasCompleted) setTotalCompleted(prev => prev !== null ? Math.max(0, prev - 1) : null);

    // Cancel any existing pending delete for this card
    const existing = pendingDeleteTimers.current.get(cardId);
    if (existing) clearTimeout(existing);

    let undone = false;

    toast.success(`"${cardName}" deleted`, {
      action: {
        label: 'Undo',
        onClick: () => {
          undone = true;
          const timer = pendingDeleteTimers.current.get(cardId);
          if (timer) clearTimeout(timer);
          pendingDeleteTimers.current.delete(cardId);
          setCards(prevCards);
          setTotal((prev) => prev + 1);
          if (wasCompleted) setTotalCompleted(prev => prev !== null ? prev + 1 : null);
        },
      },
    });

    // Actually delete after the toast expires (5s)
    const timer = setTimeout(async () => {
      pendingDeleteTimers.current.delete(cardId);
      if (undone) return;
      try {
        await api(`/cards/${cardId}`, { method: 'DELETE' });
      } catch (err) {
        // Restore card on failure
        setCards(prevCards);
        setTotal((prev) => prev + 1);
        if (err instanceof ApiError) toast.error(err.message);
        else toast.error('Failed to delete card');
      }
    }, 5000);

    pendingDeleteTimers.current.set(cardId, timer);
  }

  function handleCopyCardLink(cardId: string) {
    const url = `${window.location.origin}/cards/${cardId}`;
    navigator.clipboard.writeText(url).then(() => {
      toast.success('Link copied');
    }).catch(() => {
      toast.error('Failed to copy link');
    });
  }

  async function handleDuplicateCard(cardId: string) {
    const card = cards.find((c) => c.id === cardId);
    if (!card || !id) return;
    try {
      const newCard = await api<{ id: string }>('/cards', {
        method: 'POST',
        body: JSON.stringify({
          collectionId: id,
          name: `Copy of ${card.name}`,
          description: card.description ?? undefined,
          customFields: card.customFields ?? undefined,
          assigneeId: card.assignee?.id ?? undefined,
        }),
      });
      if (card.tags.length > 0) {
        await Promise.allSettled(
          card.tags.map((t) =>
            api(`/cards/${newCard.id}/tags`, { method: 'POST', body: JSON.stringify({ tagId: t.id }) }),
          ),
        );
      }
      toast.success('Card duplicated');
      fetchData();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to duplicate card');
    }
  }

  async function openMoveDropdown(cardId: string) {
    if (moveCardId === cardId) { setMoveCardId(null); return; }
    setMoveCardId(cardId);
    if (moveCollections.length === 0) {
      setMoveCollectionsLoading(true);
      try {
        const res = await api<{ entries: { id: string; name: string }[] }>('/collections?limit=100');
        setMoveCollections(res.entries.filter((c) => c.id !== id));
      } catch {
        toast.error('Failed to load collections');
        setMoveCardId(null);
      } finally {
        setMoveCollectionsLoading(false);
      }
    }
  }

  async function handleMoveCard(cardId: string, targetCollectionId: string, targetCollectionName: string) {
    const cardToMove = cards.find((c) => c.id === cardId);
    if (!cardToMove) return;
    setMoveCardId(null);

    // Optimistically remove the card
    setCards((prev) => prev.filter((c) => c.id !== cardId));
    setTotal((prev) => prev - 1);

    let undone = false;
    toast.success(`Moved to "${targetCollectionName}"`, {
      action: {
        label: 'Undo',
        onClick: async () => {
          undone = true;
          // Move back to original collection
          try {
            await api(`/cards/${cardId}`, {
              method: 'PATCH',
              body: JSON.stringify({ collectionId: id }),
            });
            setCards((prev) => [...prev, cardToMove]);
            setTotal((prev) => prev + 1);
          } catch {
            toast.error('Failed to undo move');
          }
        },
      },
    });

    try {
      await api(`/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ collectionId: targetCollectionId }),
      });
    } catch (err) {
      if (undone) return;
      // Restore card on failure
      setCards((prev) => [...prev, cardToMove]);
      setTotal((prev) => prev + 1);
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to move card');
    }
  }

  function handleStartRename(card: Card) {
    setEditingCardId(card.id);
    setEditingCardName(card.name);
  }

  function handleCancelRename() {
    setEditingCardId(null);
    setEditingCardName('');
  }

  async function handleSaveRename(cardId: string) {
    const name = editingCardName.trim();
    setEditingCardId(null);
    setEditingCardName('');
    if (!name) return;
    const original = cards.find((c) => c.id === cardId);
    if (original && name === original.name) return;
    setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, name } : c)));
    try {
      await api(`/cards/${cardId}`, { method: 'PATCH', body: JSON.stringify({ name }) });
    } catch (err) {
      if (original) setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, name: original.name } : c)));
      if (err instanceof ApiError) {
        toast.error(err.message);
      } else {
        toast.error('Failed to rename card');
      }
    }
  }

  async function handleToggleComplete(cardId: string, currentCompleted: boolean) {
    const newCompleted = !currentCompleted;
    const card = cards.find((c) => c.id === cardId);
    if (!card) return;
    const newCustomFields = { ...card.customFields, completed: newCompleted };
    setCards((prev) => prev.map((c) => c.id === cardId ? { ...c, customFields: newCustomFields } : c));
    setTotalCompleted(prev => prev !== null ? prev + (newCompleted ? 1 : -1) : null);
    try {
      await api(`/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
      const shortName = card.name.length > 30 ? card.name.slice(0, 30) + '...' : card.name;
      toast.success(
        newCompleted ? `"${shortName}" completed` : `"${shortName}" reopened`,
        {
          action: {
            label: 'Undo',
            onClick: () => { void handleToggleComplete(cardId, newCompleted); },
          },
        },
      );
    } catch (err) {
      setCards((prev) => prev.map((c) => c.id === cardId ? { ...c, customFields: card.customFields } : c));
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to update card');
    }
  }

  async function handleUpdateCardPriority(cardId: string, priority: Priority | null) {
    const card = cards.find((c) => c.id === cardId);
    if (!card) return;
    const newCustomFields = { ...card.customFields, priority: priority ?? undefined };
    if (priority === null) delete (newCustomFields as Record<string, unknown>).priority;
    setCards((prev) => prev.map((c) => c.id === cardId ? { ...c, customFields: newCustomFields } : c));
    try {
      await api(`/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
    } catch (err) {
      setCards((prev) => prev.map((c) => c.id === cardId ? { ...c, customFields: card.customFields } : c));
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to update priority');
    }
  }

  async function handleUpdateCardDueDate(cardId: string, dueDate: string | null) {
    const card = cards.find((c) => c.id === cardId);
    if (!card) return;
    const newCustomFields = { ...card.customFields, dueDate: dueDate ?? undefined };
    if (dueDate === null) delete (newCustomFields as Record<string, unknown>).dueDate;
    setCards((prev) => prev.map((c) => c.id === cardId ? { ...c, customFields: newCustomFields } : c));
    try {
      await api(`/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
    } catch (err) {
      setCards((prev) => prev.map((c) => c.id === cardId ? { ...c, customFields: card.customFields } : c));
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to update due date');
    }
  }

  function toggleHideCompleted() {
    setHideCompleted((v) => {
      localStorage.setItem(HIDE_COMPLETED_KEY, String(!v));
      return !v;
    });
  }

  // Bulk selection helpers
  const bulkMode = selectedCardIds.size > 0;

  function toggleCardSelection(cardId: string, index: number, shiftKey: boolean) {
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastSelectedIndexRef.current !== null) {
        const start = Math.min(lastSelectedIndexRef.current, index);
        const end = Math.max(lastSelectedIndexRef.current, index);
        for (let i = start; i <= end; i++) {
          next.add(sortedCards[i].id);
        }
      } else {
        if (next.has(cardId)) next.delete(cardId);
        else next.add(cardId);
      }
      lastSelectedIndexRef.current = index;
      return next;
    });
  }

  function selectAll() {
    if (selectedCardIds.size === sortedCards.length) {
      setSelectedCardIds(new Set());
    } else {
      setSelectedCardIds(new Set(sortedCards.map((c) => c.id)));
    }
  }

  function clearSelection() {
    setSelectedCardIds(new Set());
    lastSelectedIndexRef.current = null;
    setShowAssignDropdown(false);
    setShowPriorityDropdown(false);
    setShowDueDatePicker(false);
    setShowBulkMoveDropdown(false);
  }

  // Fetch workspace users & agents lazily when bulk mode first activates
  useEffect(() => {
    if (!bulkMode || assigneesLoaded) return;
    void Promise.all([
      api<{ entries: WorkspaceUser[] }>('/users'),
      api<{ entries: WorkspaceAgent[] }>('/agents?limit=100'),
    ]).then(([usersRes, agentsRes]) => {
      setWorkspaceUsers(usersRes.entries);
      setWorkspaceAgents(agentsRes.entries);
      setAssigneesLoaded(true);
    });
  }, [bulkMode, assigneesLoaded]);

  // Fetch all workspace tags lazily when bulk mode first activates
  useEffect(() => {
    if (!bulkMode || workspaceTagsLoaded) return;
    api<{ entries: CardTag[] }>('/tags?limit=200')
      .then((res) => {
        setWorkspaceTags(res.entries);
        setWorkspaceTagsLoaded(true);
      })
      .catch(() => setWorkspaceTagsLoaded(true));
  }, [bulkMode, workspaceTagsLoaded]);

  // Close assign dropdown on outside click
  useEffect(() => {
    if (!showAssignDropdown) return;
    function handleClick(e: MouseEvent) {
      if (assignDropdownRef.current && !assignDropdownRef.current.contains(e.target as Node)) {
        setShowAssignDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showAssignDropdown]);

  // Close batch agent picker on outside click
  useEffect(() => {
    if (!showBatchAgentPicker) return;
    function handleClick(e: MouseEvent) {
      if (batchAgentPickerRef.current && !batchAgentPickerRef.current.contains(e.target as Node)) {
        setShowBatchAgentPicker(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showBatchAgentPicker]);

  // Close move dropdown on outside click
  useEffect(() => {
    if (!moveCardId) return;
    function handleClick(e: MouseEvent) {
      if (moveDropdownRef.current && !moveDropdownRef.current.contains(e.target as Node)) {
        setMoveCardId(null);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [moveCardId]);

  // Close priority dropdown on outside click
  useEffect(() => {
    if (!showPriorityDropdown) return;
    function handleClick(e: MouseEvent) {
      if (priorityDropdownRef.current && !priorityDropdownRef.current.contains(e.target as Node)) {
        setShowPriorityDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showPriorityDropdown]);

  // Close due date picker on outside click
  useEffect(() => {
    if (!showDueDatePicker) return;
    function handleClick(e: MouseEvent) {
      if (dueDatePickerRef.current && !dueDatePickerRef.current.contains(e.target as Node)) {
        setShowDueDatePicker(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showDueDatePicker]);

  // Close tag dropdown on outside click
  useEffect(() => {
    if (!showTagDropdown) return;
    function handleClick(e: MouseEvent) {
      if (tagDropdownRef.current && !tagDropdownRef.current.contains(e.target as Node)) {
        setShowTagDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showTagDropdown]);

  // Close bulk move dropdown on outside click
  useEffect(() => {
    if (!showBulkMoveDropdown) return;
    function handleClick(e: MouseEvent) {
      if (bulkMoveDropdownRef.current && !bulkMoveDropdownRef.current.contains(e.target as Node)) {
        setShowBulkMoveDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showBulkMoveDropdown]);

  async function handleOpenBulkMoveDropdown() {
    setShowBulkMoveDropdown((v) => !v);
    if (moveCollections.length === 0 && !moveCollectionsLoading) {
      setMoveCollectionsLoading(true);
      try {
        const res = await api<{ entries: { id: string; name: string }[] }>('/collections?limit=100');
        setMoveCollections(res.entries.filter((c) => c.id !== id));
      } catch {
        toast.error('Failed to load collections');
        setShowBulkMoveDropdown(false);
      } finally {
        setMoveCollectionsLoading(false);
      }
    }
  }

  async function handleBulkMoveToCollection(targetCollectionId: string, targetCollectionName: string) {
    setShowBulkMoveDropdown(false);
    setBulkMoving(true);
    const ids = Array.from(selectedCardIds);
    const results = await Promise.allSettled(
      ids.map((cardId) =>
        api(`/cards/${cardId}`, {
          method: 'PATCH',
          body: JSON.stringify({ collectionId: targetCollectionId }),
        }),
      ),
    );
    const failedIndices = new Set(results.flatMap((r, i) => r.status === 'rejected' ? [i] : []));
    const movedIds = ids.filter((_, i) => !failedIndices.has(i));
    const failed = failedIndices.size;
    if (movedIds.length > 0) {
      setCards((prev) => prev.filter((c) => !movedIds.includes(c.id)));
      setTotal((prev) => prev - movedIds.length);
      toast.success(`Moved ${movedIds.length} card${movedIds.length !== 1 ? 's' : ''} to "${targetCollectionName}"`);
    }
    if (failed > 0) {
      toast.error(`Failed to move ${failed} card${failed !== 1 ? 's' : ''}`);
    }
    clearSelection();
    setBulkMoving(false);
  }

  async function handleBulkAssign(assigneeId: string | null) {
    setShowAssignDropdown(false);
    setBulkAssigning(true);
    const ids = Array.from(selectedCardIds);
    let updated = 0;
    const errors: string[] = [];
    await Promise.all(
      ids.map(async (cardId) => {
        try {
          await api(`/cards/${cardId}`, {
            method: 'PATCH',
            body: JSON.stringify({ assigneeId }),
          });
          updated++;
        } catch (err) {
          errors.push(err instanceof ApiError ? err.message : 'Unknown error');
        }
      }),
    );
    if (updated > 0) {
      const assigneeName = assigneeId
        ? (workspaceUsers.find((u) => u.id === assigneeId)
            ? `${workspaceUsers.find((u) => u.id === assigneeId)!.firstName} ${workspaceUsers.find((u) => u.id === assigneeId)!.lastName}`.trim()
            : workspaceAgents.find((a) => a.id === assigneeId)?.name ?? 'assignee')
        : null;
      toast.success(
        assigneeName
          ? `Assigned ${updated} card${updated !== 1 ? 's' : ''} to ${assigneeName}`
          : `Unassigned ${updated} card${updated !== 1 ? 's' : ''}`,
      );
      // Update local card state
      setCards((prev) =>
        prev.map((card) => {
          if (!selectedCardIds.has(card.id)) return card;
          if (!assigneeId) return { ...card, assigneeId: null, assignee: null };
          const matchUser = workspaceUsers.find((u) => u.id === assigneeId);
          const matchAgent = workspaceAgents.find((a) => a.id === assigneeId);
          if (matchUser) {
            return {
              ...card,
              assigneeId,
              assignee: {
                id: matchUser.id,
                firstName: matchUser.firstName,
                lastName: matchUser.lastName,
                type: 'user' as const,
              },
            };
          }
          if (matchAgent) {
            return {
              ...card,
              assigneeId,
              assignee: {
                id: matchAgent.id,
                firstName: matchAgent.name,
                lastName: '',
                type: 'agent' as const,
                avatarIcon: matchAgent.avatarIcon,
                avatarBgColor: matchAgent.avatarBgColor,
                avatarLogoColor: matchAgent.avatarLogoColor,
              },
            };
          }
          return card;
        }),
      );
    }
    if (errors.length > 0) {
      toast.error(`Failed to assign ${errors.length} card${errors.length !== 1 ? 's' : ''}`);
    }
    clearSelection();
    setBulkAssigning(false);
  }

  async function handleBulkComplete(completed: boolean) {
    setBulkCompleting(true);
    const ids = Array.from(selectedCardIds);
    // Compute delta before updating state (cards still has old completion values)
    const prevSelectedCompleted = ids.filter(cid => {
      const c = cards.find(cc => cc.id === cid);
      return c?.customFields?.completed === true;
    }).length;
    let updated = 0;
    const errors: string[] = [];
    await Promise.all(
      ids.map(async (cardId) => {
        const card = cards.find((c) => c.id === cardId);
        if (!card) return;
        const newCustomFields = { ...card.customFields, completed };
        try {
          await api(`/cards/${cardId}`, {
            method: 'PATCH',
            body: JSON.stringify({ customFields: newCustomFields }),
          });
          updated++;
        } catch (err) {
          errors.push(err instanceof ApiError ? err.message : 'Unknown error');
        }
      }),
    );
    if (updated > 0) {
      toast.success(
        completed
          ? `Marked ${updated} card${updated !== 1 ? 's' : ''} as done`
          : `Marked ${updated} card${updated !== 1 ? 's' : ''} as not done`,
      );
      setCards((prev) =>
        prev.map((card) => {
          if (!selectedCardIds.has(card.id)) return card;
          return { ...card, customFields: { ...card.customFields, completed } };
        }),
      );
      const delta = completed ? (updated - prevSelectedCompleted) : -prevSelectedCompleted;
      setTotalCompleted(prev => prev !== null ? Math.max(0, prev + delta) : null);
    }
    if (errors.length > 0) {
      toast.error(`Failed to update ${errors.length} card${errors.length !== 1 ? 's' : ''}`);
    }
    clearSelection();
    setBulkCompleting(false);
  }

  async function handleBulkPriority(priority: Priority | null) {
    setShowPriorityDropdown(false);
    setBulkUpdatingPriority(true);
    const ids = Array.from(selectedCardIds);
    let updated = 0;
    const errors: string[] = [];
    await Promise.all(
      ids.map(async (cardId) => {
        const card = cards.find((c) => c.id === cardId);
        if (!card) return;
        const newCustomFields = { ...card.customFields, priority: priority ?? undefined };
        if (priority === null) delete (newCustomFields as Record<string, unknown>).priority;
        try {
          await api(`/cards/${cardId}`, {
            method: 'PATCH',
            body: JSON.stringify({ customFields: newCustomFields }),
          });
          updated++;
        } catch (err) {
          errors.push(err instanceof ApiError ? err.message : 'Unknown error');
        }
      }),
    );
    if (updated > 0) {
      const label = priority ? priority.charAt(0).toUpperCase() + priority.slice(1) : 'None';
      toast.success(`Set priority to "${label}" for ${updated} card${updated !== 1 ? 's' : ''}`);
      setCards((prev) =>
        prev.map((card) => {
          if (!selectedCardIds.has(card.id)) return card;
          const newCf = { ...card.customFields, priority: priority ?? undefined };
          if (priority === null) delete (newCf as Record<string, unknown>).priority;
          return { ...card, customFields: newCf };
        }),
      );
    }
    if (errors.length > 0) {
      toast.error(`Failed to update ${errors.length} card${errors.length !== 1 ? 's' : ''}`);
    }
    clearSelection();
    setBulkUpdatingPriority(false);
  }

  async function handleBulkDueDate(dueDate: string | null) {
    setShowDueDatePicker(false);
    setBulkUpdatingDueDate(true);
    const ids = Array.from(selectedCardIds);
    let updated = 0;
    const errors: string[] = [];
    await Promise.all(
      ids.map(async (cardId) => {
        const card = cards.find((c) => c.id === cardId);
        if (!card) return;
        const newCustomFields = { ...card.customFields, dueDate: dueDate ?? undefined };
        if (dueDate === null) delete (newCustomFields as Record<string, unknown>).dueDate;
        try {
          await api(`/cards/${cardId}`, {
            method: 'PATCH',
            body: JSON.stringify({ customFields: newCustomFields }),
          });
          updated++;
        } catch (err) {
          errors.push(err instanceof ApiError ? err.message : 'Unknown error');
        }
      }),
    );
    if (updated > 0) {
      toast.success(
        dueDate
          ? `Set due date for ${updated} card${updated !== 1 ? 's' : ''}`
          : `Cleared due date for ${updated} card${updated !== 1 ? 's' : ''}`,
      );
      setCards((prev) =>
        prev.map((card) => {
          if (!selectedCardIds.has(card.id)) return card;
          const newCf = { ...card.customFields, dueDate: dueDate ?? undefined };
          if (dueDate === null) delete (newCf as Record<string, unknown>).dueDate;
          return { ...card, customFields: newCf };
        }),
      );
    }
    if (errors.length > 0) {
      toast.error(`Failed to update ${errors.length} card${errors.length !== 1 ? 's' : ''}`);
    }
    clearSelection();
    setBulkUpdatingDueDate(false);
  }

  async function handleBulkTagToggle(tag: CardTag) {
    setShowTagDropdown(false);
    setBulkTagging(true);
    const ids = Array.from(selectedCardIds);
    const selectedCards = cards.filter((c) => selectedCardIds.has(c.id));
    const allHaveTag = selectedCards.every((c) => c.tags.some((t) => t.id === tag.id));
    let updated = 0;
    const errors: string[] = [];

    if (allHaveTag) {
      await Promise.all(
        ids.map(async (cardId) => {
          const card = cards.find((c) => c.id === cardId);
          if (!card?.tags.some((t) => t.id === tag.id)) return;
          try {
            await api(`/cards/${cardId}/tags/${tag.id}`, { method: 'DELETE' });
            updated++;
          } catch (err) {
            errors.push(err instanceof ApiError ? err.message : 'Unknown error');
          }
        }),
      );
      if (updated > 0) {
        toast.success(`Removed "${tag.name}" from ${updated} card${updated !== 1 ? 's' : ''}`);
        setCards((prev) =>
          prev.map((card) => {
            if (!selectedCardIds.has(card.id)) return card;
            return { ...card, tags: card.tags.filter((t) => t.id !== tag.id) };
          }),
        );
      }
    } else {
      await Promise.all(
        ids.map(async (cardId) => {
          const card = cards.find((c) => c.id === cardId);
          if (!card || card.tags.some((t) => t.id === tag.id)) return;
          try {
            await api(`/cards/${cardId}/tags`, {
              method: 'POST',
              body: JSON.stringify({ tagId: tag.id }),
            });
            updated++;
          } catch (err) {
            errors.push(err instanceof ApiError ? err.message : 'Unknown error');
          }
        }),
      );
      if (updated > 0) {
        toast.success(`Added "${tag.name}" to ${updated} card${updated !== 1 ? 's' : ''}`);
        setCards((prev) =>
          prev.map((card) => {
            if (!selectedCardIds.has(card.id) || card.tags.some((t) => t.id === tag.id)) return card;
            return { ...card, tags: [...card.tags, tag] };
          }),
        );
      }
    }

    if (errors.length > 0) {
      toast.error(`Failed to update ${errors.length} card${errors.length !== 1 ? 's' : ''}`);
    }
    setBulkTagging(false);
  }

  function handleBulkDelete() {
    const count = selectedCardIds.size;
    if (count === 0) return;

    const prevCards = cards;
    const deletedIds = new Set(selectedCardIds);
    const deletedCompletedCount = [...deletedIds].filter(cid => {
      const c = cards.find(cc => cc.id === cid);
      return c?.customFields?.completed === true;
    }).length;

    // Optimistically remove all selected cards
    setCards((prev) => prev.filter((c) => !deletedIds.has(c.id)));
    setTotal((prev) => prev - count);
    if (deletedCompletedCount > 0) setTotalCompleted(prev => prev !== null ? Math.max(0, prev - deletedCompletedCount) : null);
    clearSelection();

    let undone = false;

    toast.success(`${count} card${count !== 1 ? 's' : ''} deleted`, {
      action: {
        label: 'Undo',
        onClick: () => {
          undone = true;
          setCards(prevCards);
          setTotal((prev) => prev + count);
          if (deletedCompletedCount > 0) setTotalCompleted(prev => prev !== null ? prev + deletedCompletedCount : null);
        },
      },
    });

    // Actually delete after the toast expires (5s)
    setTimeout(async () => {
      if (undone) return;
      setBulkDeleting(true);
      const errors: string[] = [];
      await Promise.all(
        [...deletedIds].map(async (cardId) => {
          try {
            await api(`/cards/${cardId}`, { method: 'DELETE' });
          } catch (err) {
            errors.push(err instanceof ApiError ? err.message : 'Unknown error');
          }
        }),
      );
      setBulkDeleting(false);
      if (errors.length > 0) {
        // Restore cards that failed to delete
        setCards(prevCards);
        setTotal((prev) => prev + count);
        if (deletedCompletedCount > 0) setTotalCompleted(prev => prev !== null ? prev + deletedCompletedCount : null);
        toast.error(`Failed to delete ${errors.length} card${errors.length !== 1 ? 's' : ''}`);
      }
    }, 5000);
  }

  async function handleExportCSV() {
    if (!collection || !id || exporting) return;
    setExporting(true);
    try {
      // Fetch all matching cards (respects search, no pagination limit)
      const qp = new URLSearchParams();
      if (debouncedSearch) qp.set('search', encodeURIComponent(debouncedSearch));
      qp.set('limit', '10000');
      const data = await api<CardsResponse>(`/collections/${id}/cards?${qp.toString()}`);
      let allCards = data.entries;

      // Apply the same client-side filters used for display
      if (selectedTagIds.size > 0) {
        allCards = allCards.filter((card) => card.tags.some((t) => selectedTagIds.has(t.id)));
      }
      if (selectedAssigneeIds.size > 0) {
        allCards = allCards.filter((card) => {
          if (card.assignee) return selectedAssigneeIds.has(card.assignee.id);
          return selectedAssigneeIds.has('__unassigned__');
        });
      }
      if (selectedDueDateFilters.size > 0) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const weekFromNow = new Date(today);
        weekFromNow.setDate(weekFromNow.getDate() + 7);
        allCards = allCards.filter((card) => {
          const dueDateStr = card.customFields?.dueDate as string | undefined;
          return Array.from(selectedDueDateFilters).some((f) => {
            if (f === 'no-due-date') return !dueDateStr;
            if (!dueDateStr) return false;
            const due = new Date(dueDateStr);
            if (f === 'overdue') return due < today;
            if (f === 'due-today') return due.toDateString() === today.toDateString();
            if (f === 'due-week') return due >= today && due < weekFromNow;
            return false;
          });
        });
      }
      if (selectedPriorityFilters.size > 0) {
        allCards = allCards.filter((card) => {
          const p = (card.customFields?.priority as string | undefined) ?? null;
          return Array.from(selectedPriorityFilters).some((f) => {
            if (f === 'none') return !p;
            return p === f;
          });
        });
      }
      if (hideCompleted) {
        allCards = allCards.filter((card) => card.customFields?.completed !== true);
      }

      // Build CSV
      function escapeCell(value: string): string {
        if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      }

      const headers = ['Name', 'Status', 'Priority', 'Due Date', 'Tags', 'Assignee', 'Checklist', 'Description', 'Created', 'Updated'];
      const rows = allCards.map((card) => {
        const status = card.customFields?.completed === true ? 'Completed' : 'Open';
        const priority = (card.customFields?.priority as string) || '';
        const dueDate = (card.customFields?.dueDate as string) || '';
        const tags = card.tags.map((t) => t.name).join('; ');
        const assignee = card.assignee
          ? `${card.assignee.firstName} ${card.assignee.lastName}`.trim()
          : '';
        const checklist = card.customFields?.checklist as { done: boolean }[] | undefined;
        const checklistStr = checklist && checklist.length > 0
          ? `${checklist.filter((i) => i.done).length}/${checklist.length}`
          : '';
        const description = stripMarkdown(card.description || '').replace(/\n+/g, ' ').trim();
        const created = new Date(card.createdAt).toLocaleDateString();
        const updated = new Date(card.updatedAt).toLocaleDateString();
        return [card.name, status, priority, dueDate, tags, assignee, checklistStr, description, created, updated];
      });

      const csvContent = [headers, ...rows]
        .map((row) => row.map((cell) => escapeCell(String(cell ?? ''))).join(','))
        .join('\n');

      const blob = new Blob([`\uFEFF${csvContent}`], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${collection.name.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')}-cards.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      toast.success(`Exported ${allCards.length} card${allCards.length !== 1 ? 's' : ''}`);
    } catch {
      toast.error('Failed to export cards');
    } finally {
      setExporting(false);
    }
  }

  // Sync search query to URL params for shareability and navigation persistence
  useEffect(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (debouncedSearch) next.set('q', debouncedSearch);
      else next.delete('q');
      return next;
    }, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  // Clear selection when filters/search change
  useEffect(() => {
    clearSelection();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, sort, selectedTagIds, selectedAssigneeIds, selectedDueDateFilters, selectedPriorityFilters, hideCompleted]);

  // Escape to clear selection
  useEffect(() => {
    if (!bulkMode) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') clearSelection();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkMode]);

  // Collect all unique tags from loaded cards
  const allTags = useMemo(() => {
    const tagMap = new Map<string, CardTag>();
    for (const card of cards) {
      for (const tag of card.tags) {
        if (!tagMap.has(tag.id)) tagMap.set(tag.id, tag);
      }
    }
    return Array.from(tagMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [cards]);

  function toggleTagFilter(tagId: string) {
    setSelectedTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }

  // Collect unique assignees from loaded cards
  const allAssignees = useMemo(() => {
    const assigneeMap = new Map<string, Card['assignee'] & {}>();
    let hasUnassigned = false;
    for (const card of cards) {
      if (card.assignee) {
        if (!assigneeMap.has(card.assignee.id)) assigneeMap.set(card.assignee.id, card.assignee);
      } else {
        hasUnassigned = true;
      }
    }
    return {
      entries: Array.from(assigneeMap.values()).sort((a, b) => a.firstName.localeCompare(b.firstName)),
      hasUnassigned,
    };
  }, [cards]);

  function toggleAssigneeFilter(assigneeId: AssigneeFilterId) {
    setSelectedAssigneeIds((prev) => {
      const next = new Set(prev);
      if (next.has(assigneeId)) next.delete(assigneeId);
      else next.add(assigneeId);
      return next;
    });
  }

  function toggleDueDateFilter(filter: DueDateFilter) {
    setSelectedDueDateFilters((prev) => {
      const next = new Set(prev);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      return next;
    });
  }

  function togglePriorityFilter(filter: PriorityFilter) {
    setSelectedPriorityFilters((prev) => {
      const next = new Set(prev);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      return next;
    });
  }

  const hasActiveFilters = selectedTagIds.size > 0 || selectedAssigneeIds.size > 0 || selectedDueDateFilters.size > 0 || selectedPriorityFilters.size > 0;

  const completedCount = useMemo(() => cards.filter((c) => c.customFields?.completed === true).length, [cards]);

  const allSelectedComplete = useMemo(
    () => selectedCardIds.size > 0 && Array.from(selectedCardIds).every((id) => cards.find((c) => c.id === id)?.customFields?.completed === true),
    [selectedCardIds, cards],
  );

  const sortedCards = useMemo(() => {
    const sorted = [...cards];
    switch (sort) {
      case 'updated-desc':
        sorted.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        break;
      case 'updated-asc':
        sorted.sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
        break;
      case 'name-asc':
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'name-desc':
        sorted.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case 'created-desc':
        sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        break;
      case 'created-asc':
        sorted.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        break;
      case 'due-asc':
        sorted.sort((a, b) => {
          const aDate = a.customFields?.dueDate as string | undefined;
          const bDate = b.customFields?.dueDate as string | undefined;
          if (!aDate && !bDate) return 0;
          if (!aDate) return 1;
          if (!bDate) return -1;
          return new Date(aDate).getTime() - new Date(bDate).getTime();
        });
        break;
      case 'due-desc':
        sorted.sort((a, b) => {
          const aDate = a.customFields?.dueDate as string | undefined;
          const bDate = b.customFields?.dueDate as string | undefined;
          if (!aDate && !bDate) return 0;
          if (!aDate) return 1;
          if (!bDate) return -1;
          return new Date(bDate).getTime() - new Date(aDate).getTime();
        });
        break;
    }
    let filtered = sorted;
    if (selectedTagIds.size > 0) {
      filtered = filtered.filter((card) => card.tags.some((t) => selectedTagIds.has(t.id)));
    }
    if (selectedAssigneeIds.size > 0) {
      filtered = filtered.filter((card) => {
        if (card.assignee) return selectedAssigneeIds.has(card.assignee.id);
        return selectedAssigneeIds.has('__unassigned__');
      });
    }
    if (selectedDueDateFilters.size > 0) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const weekFromNow = new Date(today);
      weekFromNow.setDate(weekFromNow.getDate() + 7);
      filtered = filtered.filter((card) => {
        const dueDateStr = card.customFields?.dueDate as string | undefined;
        return Array.from(selectedDueDateFilters).some((f) => {
          if (f === 'no-due-date') return !dueDateStr;
          if (!dueDateStr) return false;
          const due = new Date(dueDateStr);
          if (f === 'overdue') return due < today;
          if (f === 'due-today') {
            return due.toDateString() === today.toDateString();
          }
          if (f === 'due-week') return due >= today && due < weekFromNow;
          return false;
        });
      });
    }
    if (selectedPriorityFilters.size > 0) {
      filtered = filtered.filter((card) => {
        const p = (card.customFields?.priority as string | undefined) ?? null;
        return Array.from(selectedPriorityFilters).some((f) => {
          if (f === 'none') return !p;
          return p === f;
        });
      });
    }
    if (hideCompleted) {
      filtered = filtered.filter((card) => card.customFields?.completed !== true);
    }
    return filtered;
  }, [cards, sort, selectedTagIds, selectedAssigneeIds, selectedDueDateFilters, selectedPriorityFilters, hideCompleted]);

  const tableSortedCards = useMemo(() => {
    if (viewMode !== 'table') return sortedCards;
    const arr = [...sortedCards];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (tableSortKey) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'assignee': {
          const aName = a.assignee ? `${a.assignee.firstName} ${a.assignee.lastName}` : '';
          const bName = b.assignee ? `${b.assignee.firstName} ${b.assignee.lastName}` : '';
          cmp = aName.localeCompare(bName);
          break;
        }
        case 'due': {
          const aDate = a.customFields?.dueDate as string | undefined;
          const bDate = b.customFields?.dueDate as string | undefined;
          if (!aDate && !bDate) cmp = 0;
          else if (!aDate) cmp = 1;
          else if (!bDate) cmp = -1;
          else cmp = new Date(aDate).getTime() - new Date(bDate).getTime();
          break;
        }
        case 'priority': {
          const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
          const aP = (a.customFields?.priority as string | undefined) ?? '';
          const bP = (b.customFields?.priority as string | undefined) ?? '';
          const aOrd = aP in order ? order[aP] : 3;
          const bOrd = bP in order ? order[bP] : 3;
          cmp = aOrd - bOrd;
          break;
        }
        case 'updated':
          cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
          break;
      }
      return tableSortAsc ? cmp : -cmp;
    });
    return arr;
  }, [viewMode, sortedCards, tableSortKey, tableSortAsc]);

  function handleGroupByChange(value: GroupByOption) {
    setGroupBy(value);
    setCollapsedGroups(new Set());
    localStorage.setItem(GROUP_BY_STORAGE_KEY, value);
  }

  function toggleGroupCollapsed(groupKey: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }

  const groupedCards = useMemo(() => {
    if (groupBy === 'none') return null;

    const groups: { key: string; label: string; cards: Card[]; color?: string }[] = [];
    const groupMap = new Map<string, Card[]>();

    const getOrCreate = (key: string) => {
      let arr = groupMap.get(key);
      if (!arr) { arr = []; groupMap.set(key, arr); }
      return arr;
    };

    const cardsToGroup = viewMode === 'table' ? tableSortedCards : sortedCards;

    if (groupBy === 'assignee') {
      for (const card of cardsToGroup) {
        const key = card.assignee?.id ?? '__unassigned__';
        getOrCreate(key).push(card);
      }
      // Build ordered groups: named assignees first, unassigned last
      const assigneeNames = new Map<string, { label: string; type?: string }>();
      for (const card of cardsToGroup) {
        if (card.assignee && !assigneeNames.has(card.assignee.id)) {
          const label = card.assignee.type === 'agent'
            ? card.assignee.firstName
            : `${card.assignee.firstName} ${card.assignee.lastName}`.trim();
          assigneeNames.set(card.assignee.id, { label, type: card.assignee.type });
        }
      }
      for (const [id, info] of assigneeNames) {
        groups.push({ key: id, label: info.label, cards: groupMap.get(id)! });
      }
      if (groupMap.has('__unassigned__')) {
        groups.push({ key: '__unassigned__', label: 'Unassigned', cards: groupMap.get('__unassigned__')! });
      }
    } else if (groupBy === 'dueDate') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const weekFromNow = new Date(today);
      weekFromNow.setDate(weekFromNow.getDate() + 7);

      const overdue: Card[] = [];
      const dueToday: Card[] = [];
      const dueThisWeek: Card[] = [];
      const upcoming: Card[] = [];
      const noDueDate: Card[] = [];

      for (const card of cardsToGroup) {
        const dueDateStr = card.customFields?.dueDate as string | undefined;
        if (!dueDateStr) { noDueDate.push(card); continue; }
        const due = new Date(dueDateStr);
        if (due < today) overdue.push(card);
        else if (due.toDateString() === today.toDateString()) dueToday.push(card);
        else if (due < weekFromNow) dueThisWeek.push(card);
        else upcoming.push(card);
      }

      if (overdue.length > 0) groups.push({ key: 'overdue', label: 'Overdue', cards: overdue, color: '#ef4444' });
      if (dueToday.length > 0) groups.push({ key: 'due-today', label: 'Due today', cards: dueToday, color: '#f59e0b' });
      if (dueThisWeek.length > 0) groups.push({ key: 'due-week', label: 'Due this week', cards: dueThisWeek, color: '#3b82f6' });
      if (upcoming.length > 0) groups.push({ key: 'upcoming', label: 'Upcoming', cards: upcoming });
      if (noDueDate.length > 0) groups.push({ key: 'no-due', label: 'No due date', cards: noDueDate });
    } else if (groupBy === 'status') {
      const incomplete: Card[] = [];
      const complete: Card[] = [];

      for (const card of cardsToGroup) {
        if (card.customFields?.completed === true) complete.push(card);
        else incomplete.push(card);
      }

      if (incomplete.length > 0) groups.push({ key: 'incomplete', label: 'In progress', cards: incomplete });
      if (complete.length > 0) groups.push({ key: 'complete', label: 'Completed', cards: complete, color: '#10b981' });
    }

    return groups;
  }, [groupBy, sortedCards, tableSortedCards, viewMode]);

  // Reset focused index when filters/sort change
  useEffect(() => {
    setFocusedCardIndex(-1);
  }, [debouncedSearch, sort, selectedTagIds, selectedAssigneeIds, selectedDueDateFilters, selectedPriorityFilters, hideCompleted]);

  // Keyboard navigation for card list
  useEffect(() => {
    if (loading || bulkMode || quickViewCardId || showCreate || editingCardId) return;

    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) return;

      const cardCount = sortedCards.length;
      if (cardCount === 0) return;

      switch (e.key) {
        case 'ArrowDown':
        case 'j': {
          e.preventDefault();
          setFocusedCardIndex((prev) => {
            const next = prev < cardCount - 1 ? prev + 1 : prev;
            const cardEl = cardListRef.current?.children[next] as HTMLElement | undefined;
            cardEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            return next;
          });
          break;
        }
        case 'ArrowUp':
        case 'k': {
          e.preventDefault();
          setFocusedCardIndex((prev) => {
            const next = prev > 0 ? prev - 1 : 0;
            const cardEl = cardListRef.current?.children[next] as HTMLElement | undefined;
            cardEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            return next;
          });
          break;
        }
        case 'Enter': {
          if (focusedCardIndex >= 0 && focusedCardIndex < cardCount) {
            e.preventDefault();
            setQuickViewCardId(sortedCards[focusedCardIndex].id);
          }
          break;
        }
        case 'o': {
          if (focusedCardIndex >= 0 && focusedCardIndex < cardCount) {
            e.preventDefault();
            navigate(`/cards/${sortedCards[focusedCardIndex].id}`, { state: { cardSiblings: sortedCards.map((c) => c.id), fromCollectionId: id } });
          }
          break;
        }
        case 'F2': {
          if (focusedCardIndex >= 0 && focusedCardIndex < cardCount) {
            e.preventDefault();
            handleStartRename(sortedCards[focusedCardIndex]);
          }
          break;
        }
        case 'x': {
          if (focusedCardIndex >= 0 && focusedCardIndex < cardCount) {
            e.preventDefault();
            const card = sortedCards[focusedCardIndex];
            const isCompleted = card.customFields?.completed === true;
            void handleToggleComplete(card.id, isCompleted);
          }
          break;
        }
        case 'Delete':
        case 'Backspace': {
          if (focusedCardIndex >= 0 && focusedCardIndex < cardCount) {
            e.preventDefault();
            const card = sortedCards[focusedCardIndex];
            void handleDeleteCard(card.id, card.name);
          }
          break;
        }
        case 'm': {
          if (focusedCardIndex >= 0 && focusedCardIndex < cardCount) {
            e.preventDefault();
            void openMoveDropdown(sortedCards[focusedCardIndex].id);
          }
          break;
        }
        case 'Escape': {
          if (moveCardId) {
            setMoveCardId(null);
          } else if (focusedCardIndex >= 0) {
            setFocusedCardIndex(-1);
          }
          break;
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [loading, bulkMode, quickViewCardId, showCreate, editingCardId, moveCardId, sortedCards, focusedCardIndex, navigate]);

  function startEditCollectionName() {
    if (!collection) return;
    setDraftColName(collection.name);
    setEditingColName(true);
    setTimeout(() => colNameInputRef.current?.focus(), 0);
  }

  async function saveCollectionName() {
    const name = draftColName.trim();
    setEditingColName(false);
    if (!name || !collection || name === collection.name) return;
    const prev = collection.name;
    setCollection({ ...collection, name });
    setSavingColName(true);
    try {
      await api(`/collections/${collection.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
    } catch (err) {
      setCollection({ ...collection, name: prev });
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to rename collection');
    } finally {
      setSavingColName(false);
    }
  }

  function openBatchModal() {
    if (!collection) return;
    const cfg = collection.agentBatchConfig;
    setBatchAgentId(cfg?.agentId ?? '');
    setBatchPrompt(cfg?.prompt ?? '');
    setBatchMaxParallel(cfg?.maxParallel ?? 3);
    setBatchFilterSearch(cfg?.cardFilters?.search ?? '');
    setBatchFilterCompleted(
      cfg?.cardFilters?.completed === true ? 'completed'
        : cfg?.cardFilters?.completed === false ? 'incomplete'
        : 'all',
    );
    setBatchFilterPriority(cfg?.cardFilters?.priority ?? '');
    setBatchFilterTagId(cfg?.cardFilters?.tagId ?? '');
    setShowBatchModal(true);
    if (!batchAgentsLoaded) {
      api<{ entries: { id: string; name: string }[] }>('/agents?limit=100')
        .then((res) => { setBatchAgents(res.entries); setBatchAgentsLoaded(true); })
        .catch(() => {/* leave batchAgentsLoaded false so next open retries */});
    }
  }

  async function handleSaveBatchConfig() {
    if (!id || !collection) return;
    setBatchSaving(true);
    try {
      const agentBatchConfig: AgentBatchConfig = {
        agentId: batchAgentId || null,
        prompt: batchPrompt || null,
        maxParallel: batchMaxParallel,
        cardFilters: {
          ...(batchFilterSearch ? { search: batchFilterSearch } : {}),
          ...(batchFilterCompleted !== 'all' ? { completed: batchFilterCompleted === 'completed' } : {}),
          ...(batchFilterPriority ? { priority: batchFilterPriority as 'high' | 'medium' | 'low' } : {}),
          ...(batchFilterTagId ? { tagId: batchFilterTagId } : {}),
        },
      };
      const updated = await api<Collection>(`/collections/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ agentBatchConfig }),
      });
      setCollection(updated);
      toast.success('Batch run configuration saved');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to save configuration');
    } finally {
      setBatchSaving(false);
    }
  }

  async function handleRunBatch() {
    if (!id || !batchAgentId || !batchPrompt.trim()) {
      toast.error('Select an agent and enter a prompt');
      return;
    }
    setBatchRunning(true);
    try {
      const cardFilters: AgentBatchConfig['cardFilters'] = {
        ...(batchFilterSearch ? { search: batchFilterSearch } : {}),
        ...(batchFilterCompleted !== 'all' ? { completed: batchFilterCompleted === 'completed' } : {}),
        ...(batchFilterPriority ? { priority: batchFilterPriority as 'high' | 'medium' | 'low' } : {}),
        ...(batchFilterTagId ? { tagId: batchFilterTagId } : {}),
      };
      const result = await api<{ total: number; queued: number; message: string }>(
        `/collections/${id}/agent-batch`,
        {
          method: 'POST',
          body: JSON.stringify({
            agentId: batchAgentId,
            prompt: batchPrompt,
            maxParallel: batchMaxParallel,
            cardFilters,
          }),
        },
      );
      toast.success(result.message);
      setShowBatchModal(false);
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to start batch run');
    } finally {
      setBatchRunning(false);
    }
  }

  async function handleDeleteCollection() {
    if (!collection || isGeneralCollection(collection)) return;

    const confirmed = await confirm({
      title: 'Delete collection',
      message: `Delete collection "${collection.name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;

    setDeletingCollection(true);
    try {
      await api(`/collections/${collection.id}`, { method: 'DELETE' });
      clearPreferredCollectionId();
      navigate('/collections?list=1', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error(err.message);
      } else {
        toast.error('Failed to delete collection');
      }
    } finally {
      setDeletingCollection(false);
    }
  }

  if (loading) {
    return (
      <div className={styles.loadingState}>
        <div className={styles.skeletonToolbar}>
          <div className={styles.skeletonInput} />
          <div className={styles.skeletonSelect} />
        </div>
        <div className={styles.skeletonList}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className={styles.skeletonCard} />
          ))}
        </div>
      </div>
    );
  }

  if (!collection) {
    return <div className={styles.emptyState}>{error || 'Collection not found'}</div>;
  }

  return (
    <div className={styles.page}>
      {confirmDialog}
      <EntitySwitcher
        currentId={id!}
        currentName={collection.name}
        fetchEntries={async () => {
          const res = await api<{ entries: { id: string; name: string }[] }>('/collections?limit=100');
          return res.entries;
        }}
        basePath="/collections"
        allLabel="All Collections"
      />

      <PageHeader
        title={
          editingColName ? (
            <input
              ref={colNameInputRef}
              className={styles.collectionNameInput}
              value={draftColName}
              onChange={(e) => setDraftColName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveCollectionName();
                if (e.key === 'Escape') setEditingColName(false);
              }}
              onBlur={() => void saveCollectionName()}
              disabled={savingColName}
            />
          ) : (
            <button
              className={styles.collectionNameBtn}
              onClick={startEditCollectionName}
              title="Click to rename"
            >
              {collection.name}
              <Pencil size={14} className={styles.collectionNameEditIcon} />
            </button>
          )
        }
        description={collection.description || 'Cards in this collection'}
        actions={
          <div className={styles.headerActions}>
            <button
              className={`${styles.favoriteBtn} ${isFavorite(collection.id) ? styles.favoriteBtnActive : ''}`}
              onClick={() => toggleFavorite({ id: collection.id, type: 'collection', name: collection.name })}
              title={isFavorite(collection.id) ? 'Remove from favorites' : 'Add to favorites'}
            >
              <Star size={16} />
            </button>
            {!isGeneralCollection(collection) && (
              <Button
                variant="secondary"
                onClick={() => { void handleDeleteCollection(); }}
                disabled={deletingCollection}
              >
                <Trash2 size={14} />
                {deletingCollection ? 'Deleting...' : 'Delete Collection'}
              </Button>
            )}
            <Button
              variant="secondary"
              size="md"
              onClick={() => { void handleExportCSV(); }}
              disabled={exporting || sortedCards.length === 0}
              title={sortedCards.length === 0 ? 'No cards to export' : `Export${sortedCards.length < total ? ' all matching' : ''} ${sortedCards.length} card${sortedCards.length !== 1 ? 's' : ''} as CSV`}
            >
              <Download size={14} />
              {exporting ? 'Exporting…' : 'Export CSV'}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={openBatchModal}
              title="Run an agent on cards in this collection"
            >
              <Bot size={14} />
              Batch Run
            </Button>
            <Button size="md" onClick={() => setShowCreate(true)}>
              <Plus size={16} />
              New Card
            </Button>
          </div>
        }
      />

      {bulkMode ? (
        <div className={styles.bulkBar}>
          <button className={styles.bulkSelectAll} onClick={selectAll} title={selectedCardIds.size === sortedCards.length ? 'Deselect all' : 'Select all'}>
            {selectedCardIds.size === sortedCards.length ? <CheckSquare size={16} /> : <MinusSquare size={16} />}
          </button>
          <span className={styles.bulkCount}>
            {selectedCardIds.size} selected
          </span>
          <div className={styles.bulkActions}>
            <div className={styles.bulkAssignWrap} ref={assignDropdownRef}>
              <button
                className={styles.bulkAssignBtn}
                onClick={() => setShowAssignDropdown((v) => !v)}
                disabled={bulkAssigning}
                title="Assign selected cards"
              >
                <UserCheck size={14} />
                {bulkAssigning ? 'Assigning...' : 'Assign to'}
                <ChevronDown size={12} />
              </button>
              {showAssignDropdown && (
                <div className={styles.bulkAssignDropdown}>
                  {!assigneesLoaded && (
                    <div className={styles.bulkAssignLoading}>Loading...</div>
                  )}
                  {assigneesLoaded && workspaceUsers.length === 0 && workspaceAgents.length === 0 && (
                    <div className={styles.bulkAssignLoading}>No assignees found</div>
                  )}
                  {assigneesLoaded && workspaceUsers.length > 0 && (
                    <>
                      <div className={styles.bulkAssignGroup}>People</div>
                      {workspaceUsers.map((u) => (
                        <button
                          key={u.id}
                          className={styles.bulkAssignOption}
                          onClick={() => { void handleBulkAssign(u.id); }}
                        >
                          <User size={13} />
                          {u.firstName} {u.lastName}
                        </button>
                      ))}
                    </>
                  )}
                  {assigneesLoaded && workspaceAgents.length > 0 && (
                    <>
                      <div className={styles.bulkAssignGroup}>Agents</div>
                      {workspaceAgents.map((a) => (
                        <button
                          key={a.id}
                          className={styles.bulkAssignOption}
                          onClick={() => { void handleBulkAssign(a.id); }}
                        >
                          <AgentAvatar icon={a.avatarIcon ?? ''} bgColor={a.avatarBgColor ?? ''} logoColor={a.avatarLogoColor ?? ''} size={13} />
                          {a.name}
                        </button>
                      ))}
                    </>
                  )}
                  {assigneesLoaded && (workspaceUsers.length > 0 || workspaceAgents.length > 0) && (
                    <>
                      <div className={styles.bulkAssignDivider} />
                      <button
                        className={styles.bulkAssignOption}
                        onClick={() => { void handleBulkAssign(null); }}
                      >
                        <X size={13} />
                        Unassign
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
            <button
              className={styles.bulkAssignBtn}
              onClick={() => { void handleBulkComplete(!allSelectedComplete); }}
              disabled={bulkCompleting}
              title={allSelectedComplete ? 'Mark selected cards as not done' : 'Mark selected cards as done'}
            >
              <CircleCheck size={14} />
              {bulkCompleting ? 'Updating...' : allSelectedComplete ? 'Mark not done' : 'Mark done'}
            </button>
            <div className={styles.bulkPriorityWrap} ref={priorityDropdownRef}>
              <button
                className={styles.bulkAssignBtn}
                onClick={() => setShowPriorityDropdown((v) => !v)}
                disabled={bulkUpdatingPriority}
                title="Set priority for selected cards"
              >
                <Flag size={14} />
                {bulkUpdatingPriority ? 'Setting...' : 'Priority'}
                <ChevronDown size={12} />
              </button>
              {showPriorityDropdown && (
                <div className={styles.bulkPriorityDropdown}>
                  {PRIORITY_OPTIONS.map((p) => (
                    <button
                      key={p.value}
                      className={styles.bulkPriorityOption}
                      onClick={() => { void handleBulkPriority(p.value); }}
                    >
                      <span className={styles.bulkPriorityDot} style={{ background: p.color }} />
                      {p.label}
                    </button>
                  ))}
                  <div className={styles.bulkAssignDivider} />
                  <button
                    className={styles.bulkPriorityOption}
                    onClick={() => { void handleBulkPriority(null); }}
                  >
                    <span className={styles.bulkPriorityDot} style={{ background: 'var(--color-text-muted, #9CA3AF)' }} />
                    None
                  </button>
                </div>
              )}
            </div>
            <div className={styles.bulkDueDateWrap} ref={dueDatePickerRef}>
              <button
                className={styles.bulkAssignBtn}
                onClick={() => setShowDueDatePicker((v) => !v)}
                disabled={bulkUpdatingDueDate}
                title="Set due date for selected cards"
              >
                <CalendarDays size={14} />
                {bulkUpdatingDueDate ? 'Setting...' : 'Due date'}
                <ChevronDown size={12} />
              </button>
              {showDueDatePicker && (
                <div className={styles.bulkDueDateDropdown}>
                  <input
                    type="date"
                    className={styles.bulkDueDateInput}
                    autoFocus
                    onChange={(e) => {
                      if (e.target.value) void handleBulkDueDate(e.target.value);
                    }}
                  />
                  <button
                    className={styles.bulkDueDateClear}
                    onClick={() => { void handleBulkDueDate(null); }}
                  >
                    Clear due date
                  </button>
                </div>
              )}
            </div>
            <div className={styles.bulkTagWrap} ref={tagDropdownRef}>
              <button
                className={styles.bulkAssignBtn}
                onClick={() => setShowTagDropdown((v) => !v)}
                disabled={bulkTagging}
                title="Add or remove tags for selected cards"
              >
                <Tag size={14} />
                {bulkTagging ? 'Updating...' : 'Tags'}
                <ChevronDown size={12} />
              </button>
              {showTagDropdown && (
                <div className={styles.bulkTagDropdown}>
                  {!workspaceTagsLoaded && (
                    <div className={styles.bulkAssignLoading}>Loading tags...</div>
                  )}
                  {workspaceTagsLoaded && workspaceTags.length === 0 && (
                    <div className={styles.bulkAssignLoading}>No tags found</div>
                  )}
                  {workspaceTagsLoaded && workspaceTags.length > 0 && (() => {
                    const selectedCards = cards.filter((c) => selectedCardIds.has(c.id));
                    return workspaceTags.map((tag) => {
                      const countWithTag = selectedCards.filter((c) => c.tags.some((t) => t.id === tag.id)).length;
                      const allHave = countWithTag === selectedCards.length;
                      const someHave = countWithTag > 0 && !allHave;
                      return (
                        <button
                          key={tag.id}
                          className={styles.bulkTagOption}
                          onClick={() => void handleBulkTagToggle(tag)}
                          title={allHave ? `Remove "${tag.name}" from all selected` : `Add "${tag.name}" to selected`}
                        >
                          <span className={`${styles.bulkTagCheck}${allHave ? ` ${styles.bulkTagCheckAll}` : someHave ? ` ${styles.bulkTagCheckSome}` : ''}`}>
                            {allHave ? <Check size={10} strokeWidth={3} /> : someHave ? <MinusSquare size={10} /> : null}
                          </span>
                          <span className={styles.bulkTagPill} style={{ background: tag.color }}>
                            {tag.name}
                          </span>
                        </button>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
            <div className={styles.bulkAssignWrap} ref={bulkMoveDropdownRef}>
              <button
                className={styles.bulkAssignBtn}
                onClick={() => { void handleOpenBulkMoveDropdown(); }}
                disabled={bulkMoving}
                title="Move selected cards to another collection"
              >
                <FolderInput size={14} />
                {bulkMoving ? 'Moving...' : 'Move to'}
                <ChevronDown size={12} />
              </button>
              {showBulkMoveDropdown && (
                <div className={styles.bulkAssignDropdown}>
                  {moveCollectionsLoading ? (
                    <div className={styles.bulkAssignLoading}>Loading collections...</div>
                  ) : moveCollections.length === 0 ? (
                    <div className={styles.bulkAssignLoading}>No other collections</div>
                  ) : (
                    moveCollections.map((col) => (
                      <button
                        key={col.id}
                        className={styles.bulkAssignOption}
                        onClick={() => { void handleBulkMoveToCollection(col.id, col.name); }}
                      >
                        <FolderInput size={13} />
                        {col.name}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <button
              className={styles.bulkDeleteBtn}
              onClick={() => { void handleBulkDelete(); }}
              disabled={bulkDeleting}
              title={`Delete ${selectedCardIds.size} card${selectedCardIds.size !== 1 ? 's' : ''}`}
            >
              <Trash2 size={14} />
              {bulkDeleting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
          <button className={styles.bulkClearBtn} onClick={clearSelection} title="Clear selection (Esc)">
            <X size={14} />
            Clear
          </button>
        </div>
      ) : (
        <div className={styles.toolbar}>
          <div className={styles.searchWrapper}>
            <input
              className={styles.searchInput}
              placeholder="Search cards..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search cards"
            />
            {search && (
              <button className={styles.searchClear} onClick={() => setSearch('')} title="Clear search">
                <X size={12} />
              </button>
            )}
          </div>
          <select
            className={styles.sortSelect}
            value={sort}
            onChange={(e) => handleSortChange(e.target.value as SortOption)}
          >
            <option value="updated-desc">Recently updated</option>
            <option value="updated-asc">Least recently updated</option>
            <option value="created-desc">Newest first</option>
            <option value="created-asc">Oldest first</option>
            <option value="name-asc">Name A–Z</option>
            <option value="name-desc">Name Z–A</option>
            <option value="due-asc">Due date (earliest first)</option>
            <option value="due-desc">Due date (latest first)</option>
          </select>
          <select
            className={styles.sortSelect}
            value={groupBy}
            onChange={(e) => handleGroupByChange(e.target.value as GroupByOption)}
            title="Group cards by"
          >
            <option value="none">No grouping</option>
            <option value="assignee">Group by assignee</option>
            <option value="dueDate">Group by due date</option>
            <option value="status">Group by status</option>
          </select>
          <span className={styles.cardCount}>
            {hasActiveFilters
              ? `${sortedCards.length} of ${cards.length} card${cards.length !== 1 ? 's' : ''}`
              : total > cards.length
                ? `${cards.length} of ${total} card${total !== 1 ? 's' : ''}`
                : `${total || cards.length} card${(total || cards.length) !== 1 ? 's' : ''}`}
          </span>
          {completedCount > 0 && (
            <button
              className={`${styles.completedToggle}${hideCompleted ? '' : ` ${styles.completedToggleVisible}`}`}
              onClick={toggleHideCompleted}
              title={hideCompleted ? `Show ${completedCount} completed card${completedCount !== 1 ? 's' : ''}` : 'Hide completed cards'}
            >
              <CircleCheck size={13} />
              {hideCompleted ? `${completedCount} done` : 'Hide done'}
            </button>
          )}
          <div className={styles.viewToggle}>
            <button
              className={`${styles.viewToggleBtn}${viewMode === 'cards' ? ` ${styles.viewToggleBtnActive}` : ''}`}
              onClick={() => handleViewModeChange('cards')}
              title="Card view"
              aria-label="Card view"
            >
              <LayoutList size={16} />
            </button>
            <button
              className={`${styles.viewToggleBtn}${viewMode === 'table' ? ` ${styles.viewToggleBtnActive}` : ''}`}
              onClick={() => handleViewModeChange('table')}
              title="Table view"
              aria-label="Table view"
            >
              <Table2 size={16} />
            </button>
          </div>
          <div className={styles.savedViewsWrapper} ref={savedViewsDropdownRef}>
            <button
              className={`${styles.savedViewsBtn}${showSavedViewsDropdown ? ` ${styles.savedViewsBtnActive}` : ''}`}
              onClick={() => setShowSavedViewsDropdown((p) => !p)}
              title="Saved views"
            >
              <Bookmark size={14} />
              <ChevronDown size={12} />
            </button>
            {showSavedViewsDropdown && (
              <div className={styles.savedViewsDropdown}>
                <div className={styles.savedViewsHeader}>Saved Views</div>
                {savedViews.length === 0 && !showSaveViewInput && (
                  <div className={styles.savedViewsEmpty}>No saved views yet</div>
                )}
                {savedViews.map((view) => (
                  <div key={view.id} className={styles.savedViewItem}>
                    <button
                      className={styles.savedViewApply}
                      onClick={() => handleApplyView(view)}
                      title={`Apply "${view.name}"`}
                    >
                      <Bookmark size={12} />
                      <span className={styles.savedViewName}>{view.name}</span>
                    </button>
                    <button
                      className={styles.savedViewDelete}
                      onClick={() => handleDeleteView(view.id)}
                      title={`Delete "${view.name}"`}
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
                {showSaveViewInput ? (
                  <div className={styles.savedViewInputRow}>
                    <input
                      ref={saveViewInputRef}
                      className={styles.savedViewInput}
                      placeholder="View name..."
                      value={savingViewName}
                      onChange={(e) => setSavingViewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); handleSaveView(); }
                        if (e.key === 'Escape') { setShowSaveViewInput(false); setSavingViewName(''); }
                      }}
                    />
                    <button
                      className={styles.savedViewSaveBtn}
                      onClick={handleSaveView}
                      disabled={!savingViewName.trim()}
                    >
                      <Check size={12} />
                    </button>
                  </div>
                ) : (
                  <button
                    className={styles.savedViewAddBtn}
                    onClick={() => setShowSaveViewInput(true)}
                  >
                    <BookmarkPlus size={13} />
                    Save current view
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {!loading && total > 0 && totalCompleted !== null && (
        <div className={styles.collectionProgress}>
          <div className={styles.collectionProgressTrack}>
            <div
              className={`${styles.collectionProgressFill}${totalCompleted >= total ? ` ${styles.collectionProgressFillComplete}` : ''}`}
              style={{ width: `${Math.min(100, Math.round((totalCompleted / total) * 100))}%` }}
            />
          </div>
          <span className={styles.collectionProgressLabel}>
            {totalCompleted}/{total} complete
          </span>
        </div>
      )}

      {(allTags.length > 0 || allAssignees.entries.length > 0 || cards.length > 0) && (
        <div className={styles.filtersRow}>
          {allTags.length > 0 && (
            <div className={styles.tagFilters}>
              <Tag size={13} className={styles.tagFiltersIcon} />
              {allTags.map((tag) => {
                const active = selectedTagIds.has(tag.id);
                return (
                  <button
                    key={tag.id}
                    className={`${styles.tagFilterChip}${active ? ` ${styles.tagFilterChipActive}` : ''}`}
                    style={active ? { background: tag.color, borderColor: tag.color } : { borderColor: tag.color, color: tag.color }}
                    onClick={() => toggleTagFilter(tag.id)}
                    title={active ? `Remove "${tag.name}" filter` : `Filter by "${tag.name}"`}
                  >
                    {tag.name}
                  </button>
                );
              })}
            </div>
          )}
          {allAssignees.entries.length > 0 && (
            <div className={styles.assigneeFilters}>
              <Users size={13} className={styles.tagFiltersIcon} />
              {user && allAssignees.entries.some((a) => a.id === user.id) && (
                <button
                  className={`${styles.assigneeFilterChip}${selectedAssigneeIds.has(user.id) ? ` ${styles.assigneeFilterChipActive}` : ''}`}
                  onClick={() => toggleAssigneeFilter(user.id)}
                  title={selectedAssigneeIds.has(user.id) ? 'Remove "My cards" filter' : 'Show only my cards'}
                >
                  My cards
                </button>
              )}
              {allAssignees.entries
                .filter((a) => !user || a.id !== user.id)
                .map((assignee) => {
                  const active = selectedAssigneeIds.has(assignee.id);
                  const label = assignee.type === 'agent' ? assignee.firstName : `${assignee.firstName} ${assignee.lastName}`;
                  return (
                    <button
                      key={assignee.id}
                      className={`${styles.assigneeFilterChip}${active ? ` ${styles.assigneeFilterChipActive}` : ''}${assignee.type === 'agent' ? ` ${styles.assigneeFilterChipAgent}` : ''}`}
                      onClick={() => toggleAssigneeFilter(assignee.id)}
                      title={active ? `Remove "${label}" filter` : `Filter by "${label}"`}
                    >
                      {assignee.type === 'agent' && (
                        <AgentAvatar icon={assignee.avatarIcon || 'spark'} bgColor={assignee.avatarBgColor || '#1a1a2e'} logoColor={assignee.avatarLogoColor || '#e94560'} size={14} />
                      )}
                      {label}
                    </button>
                  );
                })}
              {allAssignees.hasUnassigned && (
                <button
                  className={`${styles.assigneeFilterChip}${selectedAssigneeIds.has('__unassigned__') ? ` ${styles.assigneeFilterChipActive}` : ''}`}
                  onClick={() => toggleAssigneeFilter('__unassigned__')}
                  title={selectedAssigneeIds.has('__unassigned__') ? 'Remove "Unassigned" filter' : 'Show only unassigned cards'}
                >
                  Unassigned
                </button>
              )}
            </div>
          )}
          <div className={styles.dueDateFilters}>
            <CalendarDays size={13} className={styles.tagFiltersIcon} />
            {([
              { key: 'overdue' as DueDateFilter, label: 'Overdue', danger: true },
              { key: 'due-today' as DueDateFilter, label: 'Due today', danger: false },
              { key: 'due-week' as DueDateFilter, label: 'Due this week', danger: false },
              { key: 'no-due-date' as DueDateFilter, label: 'No due date', danger: false },
            ]).map(({ key, label, danger }) => {
              const active = selectedDueDateFilters.has(key);
              return (
                <button
                  key={key}
                  className={`${styles.dueDateFilterChip}${active ? ` ${styles.dueDateFilterChipActive}` : ''}${danger && active ? ` ${styles.dueDateFilterChipDanger}` : ''}`}
                  onClick={() => toggleDueDateFilter(key)}
                  title={active ? `Remove "${label}" filter` : `Filter by "${label}"`}
                >
                  {key === 'overdue' && <AlertCircle size={11} />}
                  {label}
                </button>
              );
            })}
          </div>
          <div className={styles.priorityFilters}>
            <Flag size={13} className={styles.tagFiltersIcon} />
            {([
              { key: 'high' as PriorityFilter, label: 'High', color: '#EF4444' },
              { key: 'medium' as PriorityFilter, label: 'Medium', color: '#F59E0B' },
              { key: 'low' as PriorityFilter, label: 'Low', color: '#60A5FA' },
              { key: 'none' as PriorityFilter, label: 'No priority', color: undefined },
            ]).map(({ key, label, color }) => {
              const active = selectedPriorityFilters.has(key);
              return (
                <button
                  key={key}
                  className={`${styles.priorityFilterChip}${active ? ` ${styles.priorityFilterChipActive}` : ''}`}
                  style={active && color ? { background: color, borderColor: color } : color ? { borderColor: color, color } : undefined}
                  onClick={() => togglePriorityFilter(key)}
                  title={active ? `Remove "${label}" filter` : `Filter by "${label}"`}
                >
                  {color && <span className={styles.priorityFilterDot} style={{ background: color }} />}
                  {label}
                </button>
              );
            })}
          </div>
          {hasActiveFilters && (
            <button
              className={styles.tagFilterClear}
              onClick={() => { setSelectedTagIds(new Set()); setSelectedAssigneeIds(new Set()); setSelectedDueDateFilters(new Set()); setSelectedPriorityFilters(new Set()); }}
            >
              <X size={11} /> Clear all
            </button>
          )}
        </div>
      )}

      <div className={styles.quickAdd}>
        <input
          className={styles.quickAddInput}
          placeholder="Quick add card — type a name and press Enter"
          value={quickAddName}
          onChange={(e) => setQuickAddName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void handleQuickAdd();
            }
          }}
          disabled={quickAddSaving}
          aria-label="Quick add card"
        />
        {quickAddName.trim() && (
          <span className={styles.quickAddHint}>
            <CornerDownLeft size={12} />
            Enter
          </span>
        )}
      </div>

      {sortedCards.length === 0 && (search || hasActiveFilters) ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>
            <FileText size={48} strokeWidth={1.2} />
          </div>
          <h3 className={styles.emptyTitle}>No cards found</h3>
          <p className={styles.emptyDescription}>
            {search && hasActiveFilters
              ? `No cards match "${search}" with the selected filters.`
              : search
                ? `No cards match "${search}". Try a different search term.`
                : 'No cards match the selected filters.'}
          </p>
          <div className={styles.emptyActions}>
            {hasActiveFilters && (
              <button
                className={styles.emptyActionBtn}
                onClick={() => { setSelectedTagIds(new Set()); setSelectedAssigneeIds(new Set()); setSelectedDueDateFilters(new Set()); setSelectedPriorityFilters(new Set()); }}
              >
                <X size={14} /> Clear filters
              </button>
            )}
            {search && (
              <button className={styles.emptyActionBtn} onClick={() => setSearch('')}>
                <X size={14} /> Clear search
              </button>
            )}
          </div>
        </div>
      ) : sortedCards.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>
            <FileText size={48} strokeWidth={1.2} />
          </div>
          <h3 className={styles.emptyTitle}>This collection is empty</h3>
          <p className={styles.emptyDescription}>
            Cards you create here will appear in this collection.
            Add your first card to start building out this collection.
          </p>
          <Button size="md" onClick={() => setShowCreate(true)}>
            <Plus size={16} />
            Add Card
          </Button>
        </div>
      ) : viewMode === 'table' && groupedCards ? (
        <div className={styles.groupedView}>
          {groupedCards.map((group) => (
            <div key={group.key} className={styles.groupSection}>
              <button
                className={styles.groupHeader}
                onClick={() => toggleGroupCollapsed(group.key)}
              >
                <ChevronRight
                  size={14}
                  className={`${styles.groupChevron}${collapsedGroups.has(group.key) ? '' : ` ${styles.groupChevronOpen}`}`}
                />
                {group.color && <span className={styles.groupDot} style={{ background: group.color }} />}
                <Layers size={13} className={styles.groupIcon} />
                <span className={styles.groupLabel}>{group.label}</span>
                <span className={styles.groupCount}>{group.cards.length}</span>
              </button>
              {!collapsedGroups.has(group.key) && (
                <div className={styles.tableWrapper}>
                  <table className={styles.table}>
                    <thead>
                      <tr className={styles.tableHeaderRow}>
                        <th className={styles.tableThCheck}>
                          <button className={styles.tableCheckBtn} onClick={() => {
                            const groupCardIds = group.cards.map((c) => c.id);
                            const allSelected = groupCardIds.every((cid) => selectedCardIds.has(cid));
                            setSelectedCardIds((prev) => {
                              const next = new Set(prev);
                              groupCardIds.forEach((cid) => allSelected ? next.delete(cid) : next.add(cid));
                              return next;
                            });
                          }}>
                            {group.cards.every((c) => selectedCardIds.has(c.id))
                              ? <CheckSquare size={15} />
                              : group.cards.some((c) => selectedCardIds.has(c.id))
                                ? <MinusSquare size={15} />
                                : <Square size={15} />}
                          </button>
                        </th>
                        <th className={styles.tableTh}>Name</th>
                        <th className={`${styles.tableTh} ${styles.tableThAssignee}`}>Assignee</th>
                        <th className={`${styles.tableTh} ${styles.tableThTags}`}>Tags</th>
                        <th className={`${styles.tableTh} ${styles.tableThPriority}`}>Priority</th>
                        <th className={`${styles.tableTh} ${styles.tableThDue}`}>Due</th>
                        <th className={`${styles.tableTh} ${styles.tableThUpdated}`}>Updated</th>
                        <th className={`${styles.tableTh} ${styles.tableThActions}`} />
                      </tr>
                    </thead>
                    <tbody>
                      {group.cards.map((card, index) => {
                        const isSelected = selectedCardIds.has(card.id);
                        const dueDate = card.customFields?.dueDate as string | undefined;
                        const today = new Date();
                        today.setHours(0, 0, 0, 0);
                        const due = dueDate ? new Date(dueDate) : null;
                        const isOverdue = due ? due < today : false;
                        const isSoon = due ? !isOverdue && (due.getTime() - today.getTime()) <= 3 * 24 * 60 * 60 * 1000 : false;
                        const isCompleted = card.customFields?.completed === true;
                        return (
                          <tr
                            key={card.id}
                            className={`${styles.tableRow}${isSelected ? ` ${styles.tableRowSelected}` : ''}${isCompleted ? ` ${styles.tableRowCompleted}` : ''}`}
                            onClick={() => setQuickViewCardId(card.id)}
                          >
                            <td className={styles.tableTdCheck}>
                              <button
                                className={styles.tableCheckBtn}
                                onClick={(e) => { e.stopPropagation(); toggleCardSelection(card.id, index, e.shiftKey); }}
                              >
                                {isSelected ? <CheckSquare size={15} /> : <Square size={15} />}
                              </button>
                            </td>
                            <td className={styles.tableTdName} onClick={(e) => e.stopPropagation()}>
                              <div className={styles.tableNameCell}>
                                <button
                                  className={`${styles.completeBtn}${isCompleted ? ` ${styles.completeBtnDone}` : ''}`}
                                  onClick={(e) => { e.stopPropagation(); void handleToggleComplete(card.id, isCompleted); }}
                                  title={isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
                                >
                                  {isCompleted ? <CircleCheck size={14} /> : <Circle size={14} />}
                                </button>
                                <div>
                                  <span className={`${styles.tableCardName}${isCompleted ? ` ${styles.tableCardNameCompleted}` : ''}`}>{card.name}</span>
                                  {card.description && <span className={styles.tableCardDesc}>{stripMarkdown(card.description)}</span>}
                                </div>
                              </div>
                            </td>
                            <td className={styles.tableTdAssignee}>
                              {card.assignee ? (
                                card.assignee.type === 'agent' ? (
                                  <div className={styles.tableAssigneeCell} title={card.assignee.firstName}>
                                    <AgentAvatar icon={card.assignee.avatarIcon || 'spark'} bgColor={card.assignee.avatarBgColor || '#1a1a2e'} logoColor={card.assignee.avatarLogoColor || '#e94560'} size={18} />
                                    <span className={styles.tableAssigneeName}>{card.assignee.firstName}</span>
                                  </div>
                                ) : (
                                  <div className={styles.tableAssigneeCell} title={`${card.assignee.firstName} ${card.assignee.lastName}`}>
                                    <div className={styles.tableAvatar}>{card.assignee.firstName[0]}{card.assignee.lastName[0]}</div>
                                    <span className={styles.tableAssigneeName}>{card.assignee.firstName}</span>
                                  </div>
                                )
                              ) : <span className={styles.tableUnassigned}>—</span>}
                            </td>
                            <td className={styles.tableTdTags}>
                              {card.tags?.length > 0 && (
                                <div className={styles.tableTags}>
                                  {card.tags.slice(0, 2).map((tag) => (
                                    <span key={tag.id} className={styles.tableTag} style={{ background: tag.color }}>{tag.name}</span>
                                  ))}
                                  {card.tags.length > 2 && <span className={styles.tableTagMore}>+{card.tags.length - 2}</span>}
                                </div>
                              )}
                            </td>
                            <td className={styles.tableTdPriority} onClick={(e) => e.stopPropagation()}>
                              <PriorityBadge
                                priority={(card.customFields?.priority as Priority) ?? null}
                                editable
                                onChange={(p) => { void handleUpdateCardPriority(card.id, p); }}
                                size="sm"
                              />
                            </td>
                            <td className={styles.tableTdDue} onClick={(e) => e.stopPropagation()}>
                              <InlineDatePicker
                                value={(card.customFields?.dueDate as string) ?? null}
                                onChange={(d) => { void handleUpdateCardDueDate(card.id, d); }}
                                isOverdue={isOverdue}
                                isSoon={isSoon}
                              />
                            </td>
                            <td className={styles.tableTdUpdated}><TimeAgo date={card.updatedAt ?? card.createdAt} /></td>
                            <td className={styles.tableTdActions}>
                              <div className={styles.tableActions}>
                                <Link to={`/cards/${card.id}`} state={{ cardSiblings: sortedCards.map((c) => c.id), fromCollectionId: id }} className={styles.tableActionBtn} title="Open full view" onClick={(e) => e.stopPropagation()}>
                                  <ExternalLink size={13} />
                                </Link>
                                <button className={styles.tableActionBtn} title="Duplicate card" onClick={(e) => { e.stopPropagation(); void handleDuplicateCard(card.id); }}>
                                  <Copy size={13} />
                                </button>
                                <button className={`${styles.tableActionBtn} ${styles.tableActionBtnDanger}`} title="Delete" onClick={(e) => { e.stopPropagation(); void handleDeleteCard(card.id, card.name); }}>
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
          {groupedCards.length === 0 && (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}><FileText size={48} strokeWidth={1.2} /></div>
              <h3 className={styles.emptyTitle}>No cards to group</h3>
            </div>
          )}
        </div>
      ) : viewMode === 'table' ? (
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr className={styles.tableHeaderRow}>
                <th className={styles.tableThCheck}>
                  <button
                    className={styles.tableCheckBtn}
                    onClick={selectAll}
                    title={selectedCardIds.size === tableSortedCards.length ? 'Deselect all' : 'Select all'}
                  >
                    {tableSortedCards.length > 0 && selectedCardIds.size === tableSortedCards.length
                      ? <CheckSquare size={15} />
                      : selectedCardIds.size > 0
                        ? <MinusSquare size={15} />
                        : <Square size={15} />}
                  </button>
                </th>
                <th className={styles.tableTh}>
                  <button className={styles.tableThBtn} onClick={() => handleTableSort('name')}>
                    Name
                    {tableSortKey === 'name' && (tableSortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                  </button>
                </th>
                <th className={`${styles.tableTh} ${styles.tableThAssignee}`}>
                  <button className={styles.tableThBtn} onClick={() => handleTableSort('assignee')}>
                    Assignee
                    {tableSortKey === 'assignee' && (tableSortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                  </button>
                </th>
                <th className={`${styles.tableTh} ${styles.tableThTags}`}>Tags</th>
                <th className={`${styles.tableTh} ${styles.tableThPriority}`}>
                  <button className={styles.tableThBtn} onClick={() => handleTableSort('priority')}>
                    Priority
                    {tableSortKey === 'priority' && (tableSortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                  </button>
                </th>
                <th className={`${styles.tableTh} ${styles.tableThDue}`}>
                  <button className={styles.tableThBtn} onClick={() => handleTableSort('due')}>
                    Due
                    {tableSortKey === 'due' && (tableSortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                  </button>
                </th>
                <th className={`${styles.tableTh} ${styles.tableThUpdated}`}>
                  <button className={styles.tableThBtn} onClick={() => handleTableSort('updated')}>
                    Updated
                    {tableSortKey === 'updated' && (tableSortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                  </button>
                </th>
                <th className={`${styles.tableTh} ${styles.tableThActions}`} />
              </tr>
            </thead>
            <tbody>
              {tableSortedCards.map((card, index) => {
                const isSelected = selectedCardIds.has(card.id);
                const isFocused = focusedCardIndex === index;
                const dueDate = card.customFields?.dueDate as string | undefined;
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const due = dueDate ? new Date(dueDate) : null;
                const isOverdue = due ? due < today : false;
                const isSoon = due ? !isOverdue && (due.getTime() - today.getTime()) <= 3 * 24 * 60 * 60 * 1000 : false;
                const isCompleted = card.customFields?.completed === true;
                return (
                  <tr
                    key={card.id}
                    className={`${styles.tableRow}${isSelected ? ` ${styles.tableRowSelected}` : ''}${isFocused ? ` ${styles.tableRowFocused}` : ''}${isCompleted ? ` ${styles.tableRowCompleted}` : ''}`}
                    onClick={() => setQuickViewCardId(card.id)}
                  >
                    <td className={styles.tableTdCheck}>
                      <button
                        className={styles.tableCheckBtn}
                        onClick={(e) => { e.stopPropagation(); toggleCardSelection(card.id, index, e.shiftKey); }}
                        title={isSelected ? 'Deselect' : 'Select'}
                      >
                        {isSelected ? <CheckSquare size={15} /> : <Square size={15} />}
                      </button>
                    </td>
                    <td className={styles.tableTdName} onClick={(e) => e.stopPropagation()}>
                      <div className={styles.tableNameCell}>
                        <button
                          className={`${styles.completeBtn}${isCompleted ? ` ${styles.completeBtnDone}` : ''}`}
                          onClick={(e) => { e.stopPropagation(); void handleToggleComplete(card.id, isCompleted); }}
                          title={isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
                          aria-label={isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
                        >
                          {isCompleted ? <CircleCheck size={14} /> : <Circle size={14} />}
                        </button>
                        <div>
                          {editingCardId === card.id ? (
                            <input
                              className={styles.tableCardNameInput}
                              value={editingCardName}
                              onChange={(e) => setEditingCardName(e.target.value)}
                              onBlur={() => { void handleSaveRename(card.id); }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); void handleSaveRename(card.id); }
                                if (e.key === 'Escape') { e.preventDefault(); handleCancelRename(); }
                                e.stopPropagation();
                              }}
                              // eslint-disable-next-line jsx-a11y/no-autofocus
                              autoFocus
                              aria-label="Rename card"
                            />
                          ) : (
                            <span className={`${styles.tableCardName}${isCompleted ? ` ${styles.tableCardNameCompleted}` : ''}`}>{card.name}</span>
                          )}
                          {card.description && (
                            <span className={styles.tableCardDesc}>{stripMarkdown(card.description)}</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className={styles.tableTdAssignee}>
                      {card.assignee ? (
                        card.assignee.type === 'agent' ? (
                          <div className={styles.tableAssigneeCell} title={card.assignee.firstName}>
                            <AgentAvatar icon={card.assignee.avatarIcon || 'spark'} bgColor={card.assignee.avatarBgColor || '#1a1a2e'} logoColor={card.assignee.avatarLogoColor || '#e94560'} size={18} />
                            <span className={styles.tableAssigneeName}>{card.assignee.firstName}</span>
                          </div>
                        ) : (
                          <div className={styles.tableAssigneeCell} title={`${card.assignee.firstName} ${card.assignee.lastName}`}>
                            <div className={styles.tableAvatar}>
                              {card.assignee.firstName[0]}{card.assignee.lastName[0]}
                            </div>
                            <span className={styles.tableAssigneeName}>{card.assignee.firstName}</span>
                          </div>
                        )
                      ) : (
                        <span className={styles.tableUnassigned}>—</span>
                      )}
                    </td>
                    <td className={styles.tableTdTags}>
                      {card.tags?.length > 0 && (
                        <div className={styles.tableTags}>
                          {card.tags.slice(0, 2).map((tag) => (
                            <span key={tag.id} className={styles.tableTag} style={{ background: tag.color }}>
                              {tag.name}
                            </span>
                          ))}
                          {card.tags.length > 2 && (
                            <span className={styles.tableTagMore}>+{card.tags.length - 2}</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className={styles.tableTdPriority} onClick={(e) => e.stopPropagation()}>
                      <PriorityBadge
                        priority={(card.customFields?.priority as Priority) ?? null}
                        editable
                        onChange={(p) => { void handleUpdateCardPriority(card.id, p); }}
                        size="sm"
                      />
                    </td>
                    <td className={styles.tableTdDue} onClick={(e) => e.stopPropagation()}>
                      <InlineDatePicker
                        value={dueDate ?? null}
                        onChange={(d) => { void handleUpdateCardDueDate(card.id, d); }}
                        isOverdue={isOverdue}
                        isSoon={isSoon}
                      />
                    </td>
                    <td className={styles.tableTdUpdated}>
                      <TimeAgo date={card.updatedAt ?? card.createdAt} />
                    </td>
                    <td className={styles.tableTdActions}>
                      <div className={styles.tableActions}>
                        <button
                          className={styles.tableActionBtn}
                          title="Rename card (F2)"
                          onClick={(e) => { e.stopPropagation(); handleStartRename(card); }}
                        >
                          <Pencil size={13} />
                        </button>
                        <Link
                          to={`/cards/${card.id}`} state={{ cardSiblings: sortedCards.map((c) => c.id), fromCollectionId: id }}
                          className={styles.tableActionBtn}
                          title="Open full view"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ExternalLink size={13} />
                        </Link>
                        <div className={styles.moveWrap} ref={moveCardId === card.id ? moveDropdownRef : undefined}>
                          <button
                            className={styles.tableActionBtn}
                            title="Move to collection"
                            onClick={(e) => { e.stopPropagation(); void openMoveDropdown(card.id); }}
                          >
                            <FolderInput size={13} />
                          </button>
                          {moveCardId === card.id && (
                            <div className={styles.moveDropdown}>
                              {moveCollectionsLoading ? (
                                <div className={styles.moveDropdownLoading}>Loading...</div>
                              ) : moveCollections.length === 0 ? (
                                <div className={styles.moveDropdownLoading}>No other collections</div>
                              ) : (
                                moveCollections.map((col) => (
                                  <button
                                    key={col.id}
                                    className={styles.moveDropdownOption}
                                    onClick={(e) => { e.stopPropagation(); void handleMoveCard(card.id, col.id, col.name); }}
                                  >
                                    <FileText size={12} />
                                    {col.name}
                                  </button>
                                ))
                              )}
                            </div>
                          )}
                        </div>
                        <button
                          className={styles.tableActionBtn}
                          title="Duplicate card"
                          onClick={(e) => { e.stopPropagation(); void handleDuplicateCard(card.id); }}
                        >
                          <Copy size={13} />
                        </button>
                        <button
                          className={`${styles.tableActionBtn} ${styles.tableActionBtnDanger}`}
                          title="Delete card"
                          onClick={(e) => { e.stopPropagation(); void handleDeleteCard(card.id, card.name); }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : groupedCards ? (
        <div className={styles.groupedView}>
          {groupedCards.map((group) => (
            <div key={group.key} className={styles.groupSection}>
              <button
                className={styles.groupHeader}
                onClick={() => toggleGroupCollapsed(group.key)}
              >
                <ChevronRight
                  size={14}
                  className={`${styles.groupChevron}${collapsedGroups.has(group.key) ? '' : ` ${styles.groupChevronOpen}`}`}
                />
                {group.color && <span className={styles.groupDot} style={{ background: group.color }} />}
                <Layers size={13} className={styles.groupIcon} />
                <span className={styles.groupLabel}>{group.label}</span>
                <span className={styles.groupCount}>{group.cards.length}</span>
              </button>
              {!collapsedGroups.has(group.key) && (
                <div className={styles.cardsList}>
                  {group.cards.map((card, index) => {
                    const isSelected = selectedCardIds.has(card.id);
                    const isCompleted = card.customFields?.completed === true;
                    return (
                      <div key={card.id} className={`${styles.cardItemWrapper}${isSelected ? ` ${styles.cardItemSelected}` : ''}${isCompleted ? ` ${styles.cardItemCompleted}` : ''}`}>
                        <button
                          className={`${styles.cardCheckbox}${bulkMode ? ` ${styles.cardCheckboxVisible}` : ''}`}
                          onClick={(e) => { e.stopPropagation(); toggleCardSelection(card.id, index, e.shiftKey); }}
                          title={isSelected ? 'Deselect' : 'Select'}
                        >
                          {isSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                        </button>
                        <div
                          className={styles.cardItem}
                          role="button"
                          tabIndex={0}
                          onClick={() => setQuickViewCardId(card.id)}
                          onKeyDown={(e) => { if (e.key === 'Enter') setQuickViewCardId(card.id); }}
                        >
                          <div className={styles.cardBody}>
                            <div className={styles.cardNameRow}>
                              <button
                                className={`${styles.completeBtn}${isCompleted ? ` ${styles.completeBtnDone}` : ''}`}
                                onClick={(e) => { e.stopPropagation(); void handleToggleComplete(card.id, isCompleted); }}
                                title={isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
                              >
                                {isCompleted ? <CircleCheck size={15} /> : <Circle size={15} />}
                              </button>
                              <div className={`${styles.cardName}${isCompleted ? ` ${styles.cardNameCompleted}` : ''}`}>{card.name}</div>
                            </div>
                            {card.description && <div className={styles.cardDescription}>{stripMarkdown(card.description)}</div>}
                          </div>
                          <div className={styles.cardFooter}>
                            <div className={styles.cardFooterLeft}>
                              {card.tags?.length > 0 && (
                                <div className={styles.cardTags}>
                                  {card.tags.slice(0, 3).map((tag) => (
                                    <span key={tag.id} className={styles.cardTag} style={{ background: tag.color }}>{tag.name}</span>
                                  ))}
                                  {card.tags.length > 3 && <span className={styles.cardTagMore}>+{card.tags.length - 3}</span>}
                                </div>
                              )}
                            </div>
                            <div className={styles.cardFooterRight} onClick={(e) => e.stopPropagation()}>
                              <PriorityBadge
                                priority={(card.customFields?.priority as Priority) ?? null}
                                editable
                                onChange={(p) => { void handleUpdateCardPriority(card.id, p); }}
                                size="sm"
                              />
                              {(() => {
                                const dueDate = card.customFields?.dueDate as string | undefined;
                                const today = new Date();
                                today.setHours(0, 0, 0, 0);
                                const due = dueDate ? new Date(dueDate) : null;
                                const isOverdue = due ? due < today : false;
                                const isSoon = due ? !isOverdue && (due.getTime() - today.getTime()) <= 3 * 24 * 60 * 60 * 1000 : false;
                                return (
                                  <InlineDatePicker
                                    value={dueDate ?? null}
                                    onChange={(d) => { void handleUpdateCardDueDate(card.id, d); }}
                                    isOverdue={isOverdue}
                                    isSoon={isSoon}
                                  />
                                );
                              })()}
                              <TimeAgo date={card.updatedAt ?? card.createdAt} className={styles.cardMeta} />
                              {card.assignee ? (
                                card.assignee.type === 'agent' ? (
                                  <div className={`${styles.cardAssignee} ${styles.cardAssigneeAgent}`} title={card.assignee.firstName}>
                                    <AgentAvatar icon={card.assignee.avatarIcon || 'spark'} bgColor={card.assignee.avatarBgColor || '#1a1a2e'} logoColor={card.assignee.avatarLogoColor || '#e94560'} size={20} />
                                  </div>
                                ) : (
                                  <div className={styles.cardAssignee} title={`${card.assignee.firstName} ${card.assignee.lastName}`}>
                                    {card.assignee.firstName[0]}{card.assignee.lastName[0]}
                                  </div>
                                )
                              ) : (
                                <div className={styles.cardAssigneeEmpty} title="Unassigned"><User size={12} /></div>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className={styles.cardActions}>
                          <Link to={`/cards/${card.id}`} state={{ cardSiblings: sortedCards.map((c) => c.id), fromCollectionId: id }} className={styles.cardActionBtn} title="Open full view" onClick={(e) => e.stopPropagation()}>
                            <ExternalLink size={13} />
                          </Link>
                          <button className={styles.cardActionBtn} title="Copy link" onClick={(e) => { e.stopPropagation(); handleCopyCardLink(card.id); }}>
                            <Link2 size={13} />
                          </button>
                          <button className={styles.cardActionBtn} title="Duplicate card" onClick={(e) => { e.stopPropagation(); void handleDuplicateCard(card.id); }}>
                            <Copy size={13} />
                          </button>
                          <button className={`${styles.cardActionBtn} ${styles.cardActionBtnDanger}`} title="Delete" onClick={(e) => { e.stopPropagation(); void handleDeleteCard(card.id, card.name); }}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
          {groupedCards.length === 0 && (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}><FileText size={48} strokeWidth={1.2} /></div>
              <h3 className={styles.emptyTitle}>No cards to group</h3>
            </div>
          )}
        </div>
      ) : (
        <div className={styles.cardsList} ref={cardListRef}>
          {sortedCards.map((card, index) => {
            const isSelected = selectedCardIds.has(card.id);
            const isFocused = focusedCardIndex === index;
            const isCompleted = card.customFields?.completed === true;
            return (
              <div key={card.id} className={`${styles.cardItemWrapper}${isSelected ? ` ${styles.cardItemSelected}` : ''}${isFocused ? ` ${styles.cardItemFocused}` : ''}${isCompleted ? ` ${styles.cardItemCompleted}` : ''}`}>
                <button
                  className={`${styles.cardCheckbox}${bulkMode ? ` ${styles.cardCheckboxVisible}` : ''}`}
                  onClick={(e) => { e.stopPropagation(); toggleCardSelection(card.id, index, e.shiftKey); }}
                  title={isSelected ? 'Deselect' : 'Select (hold Shift for range)'}
                  aria-label={isSelected ? 'Deselect card' : 'Select card'}
                >
                  {isSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                </button>
                <div
                  className={styles.cardItem}
                  role="button"
                  tabIndex={0}
                  onClick={() => { if (editingCardId !== card.id) setQuickViewCardId(card.id); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && editingCardId !== card.id) setQuickViewCardId(card.id); }}
                >
                  <div className={styles.cardBody}>
                    {editingCardId === card.id ? (
                      <input
                        className={styles.cardNameInput}
                        value={editingCardName}
                        onChange={(e) => setEditingCardName(e.target.value)}
                        onBlur={() => { void handleSaveRename(card.id); }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); void handleSaveRename(card.id); }
                          if (e.key === 'Escape') { e.preventDefault(); handleCancelRename(); }
                          e.stopPropagation();
                        }}
                        onClick={(e) => e.stopPropagation()}
                        // eslint-disable-next-line jsx-a11y/no-autofocus
                        autoFocus
                        aria-label="Rename card"
                      />
                    ) : (
                      <div className={styles.cardNameRow}>
                        <button
                          className={`${styles.completeBtn}${isCompleted ? ` ${styles.completeBtnDone}` : ''}`}
                          onClick={(e) => { e.stopPropagation(); void handleToggleComplete(card.id, isCompleted); }}
                          title={isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
                          aria-label={isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
                        >
                          {isCompleted ? <CircleCheck size={15} /> : <Circle size={15} />}
                        </button>
                        <div className={`${styles.cardName}${isCompleted ? ` ${styles.cardNameCompleted}` : ''}`}>{card.name}</div>
                      </div>
                    )}
                    {card.description && (
                      <div className={styles.cardDescription}>{stripMarkdown(card.description)}</div>
                    )}
                    {(() => {
                      const cl = card.customFields?.checklist as { id: string; done: boolean }[] | undefined;
                      if (!cl || cl.length === 0) return null;
                      const done = cl.filter((i) => i.done).length;
                      const pct = Math.round((done / cl.length) * 100);
                      return (
                        <div className={styles.cardChecklist}>
                          <div className={styles.cardChecklistBar}>
                            <div className={`${styles.cardChecklistFill}${pct === 100 ? ` ${styles.cardChecklistComplete}` : ''}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className={`${styles.cardChecklistLabel}${pct === 100 ? ` ${styles.cardChecklistDone}` : ''}`}>
                            <ListChecks size={11} /> {done}/{cl.length}
                          </span>
                        </div>
                      );
                    })()}
                  </div>
                  <div className={styles.cardFooter}>
                    <div className={styles.cardFooterLeft}>
                      {card.tags?.length > 0 && (
                        <div className={styles.cardTags}>
                          {card.tags.slice(0, 3).map((tag) => (
                            <span key={tag.id} className={styles.cardTag} style={{ background: tag.color }}>
                              {tag.name}
                            </span>
                          ))}
                          {card.tags.length > 3 && (
                            <span className={styles.cardTagMore}>+{card.tags.length - 3}</span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className={styles.cardFooterRight} onClick={(e) => e.stopPropagation()}>
                      <PriorityBadge
                        priority={(card.customFields?.priority as Priority) ?? null}
                        editable
                        onChange={(p) => { void handleUpdateCardPriority(card.id, p); }}
                        size="sm"
                      />
                      {(() => {
                        const dueDate = card.customFields?.dueDate as string | undefined;
                        const today = new Date();
                        today.setHours(0, 0, 0, 0);
                        const due = dueDate ? new Date(dueDate) : null;
                        const isOverdue = due ? due < today : false;
                        const isSoon = due ? !isOverdue && (due.getTime() - today.getTime()) <= 3 * 24 * 60 * 60 * 1000 : false;
                        return (
                          <InlineDatePicker
                            value={dueDate ?? null}
                            onChange={(d) => { void handleUpdateCardDueDate(card.id, d); }}
                            isOverdue={isOverdue}
                            isSoon={isSoon}
                          />
                        );
                      })()}
                      <TimeAgo date={card.updatedAt ?? card.createdAt} className={styles.cardMeta} />
                      {card.assignee ? (
                        card.assignee.type === 'agent' ? (
                          <div className={`${styles.cardAssignee} ${styles.cardAssigneeAgent}`} title={card.assignee.firstName}>
                            <AgentAvatar icon={card.assignee.avatarIcon || 'spark'} bgColor={card.assignee.avatarBgColor || '#1a1a2e'} logoColor={card.assignee.avatarLogoColor || '#e94560'} size={20} />
                          </div>
                        ) : (
                          <div className={styles.cardAssignee} title={`${card.assignee.firstName} ${card.assignee.lastName}`}>
                            {card.assignee.firstName[0]}{card.assignee.lastName[0]}
                          </div>
                        )
                      ) : (
                        <div className={styles.cardAssigneeEmpty} title="Unassigned">
                          <User size={12} />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className={styles.cardActions}>
                  <button
                    className={styles.cardActionBtn}
                    title="Rename card (F2)"
                    onClick={(e) => { e.stopPropagation(); handleStartRename(card); }}
                  >
                    <Pencil size={13} />
                  </button>
                  <Link
                    to={`/cards/${card.id}`} state={{ cardSiblings: sortedCards.map((c) => c.id), fromCollectionId: id }}
                    className={styles.cardActionBtn}
                    title="Open full view"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ExternalLink size={13} />
                  </Link>
                  <button
                    className={styles.cardActionBtn}
                    title="Copy link"
                    onClick={(e) => { e.stopPropagation(); handleCopyCardLink(card.id); }}
                  >
                    <Link2 size={13} />
                  </button>
                  <div className={styles.moveWrap} ref={moveCardId === card.id ? moveDropdownRef : undefined}>
                    <button
                      className={styles.cardActionBtn}
                      title="Move to collection"
                      onClick={(e) => { e.stopPropagation(); void openMoveDropdown(card.id); }}
                    >
                      <FolderInput size={13} />
                    </button>
                    {moveCardId === card.id && (
                      <div className={styles.moveDropdown}>
                        {moveCollectionsLoading ? (
                          <div className={styles.moveDropdownLoading}>Loading...</div>
                        ) : moveCollections.length === 0 ? (
                          <div className={styles.moveDropdownLoading}>No other collections</div>
                        ) : (
                          moveCollections.map((col) => (
                            <button
                              key={col.id}
                              className={styles.moveDropdownOption}
                              onClick={(e) => { e.stopPropagation(); void handleMoveCard(card.id, col.id, col.name); }}
                            >
                              <FileText size={12} />
                              {col.name}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                  <button
                    className={styles.cardActionBtn}
                    title="Duplicate card"
                    onClick={(e) => { e.stopPropagation(); void handleDuplicateCard(card.id); }}
                  >
                    <Copy size={13} />
                  </button>
                  <button
                    className={`${styles.cardActionBtn} ${styles.cardActionBtnDanger}`}
                    title="Delete card"
                    onClick={(e) => { e.stopPropagation(); void handleDeleteCard(card.id, card.name); }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!loading && !hasActiveFilters && cards.length < total && (
        <div className={styles.loadMoreRow}>
          <button
            className={styles.loadMoreBtn}
            onClick={() => { void handleLoadMore(); }}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading...' : `Load more (${total - cards.length} remaining)`}
          </button>
        </div>
      )}

      {showCreate && (
        <CreateCardModal
          onClose={() => setShowCreate(false)}
          onSubmit={handleCreateCard}
        />
      )}

      {quickViewCardId && (
        <CardQuickView
          cardId={quickViewCardId}
          onClose={() => setQuickViewCardId(null)}
          onCardUpdated={(cardId, updates) => {
            if (updates.customFields && 'completed' in updates.customFields) {
              const prevCard = cards.find((c) => c.id === cardId);
              const wasCompleted = prevCard?.customFields?.completed === true;
              const isCompleted = updates.customFields.completed === true;
              if (wasCompleted !== isCompleted) {
                setTotalCompleted(prev => prev !== null ? Math.max(0, prev + (isCompleted ? 1 : -1)) : null);
              }
            }
            setCards((prev) =>
              prev.map((c) => (c.id === cardId ? { ...c, ...updates } : c)),
            );
          }}
          cardIds={sortedCards.map((c) => c.id)}
          onNavigate={setQuickViewCardId}
        />
      )}

      {showBatchModal && (
        <Modal onClose={() => setShowBatchModal(false)} size="md" ariaLabel="Batch Run Configuration">
          <div className={styles.batchModal}>
            <div className={styles.batchModalHeader}>
              <Bot size={18} />
              <h2>Batch Run</h2>
              <button className={styles.batchModalClose} onClick={() => setShowBatchModal(false)}>
                <X size={16} />
              </button>
            </div>
            <p className={styles.batchModalDesc}>
              Run an agent on all cards matching the filters below.
            </p>

            <div className={styles.batchField}>
              <label className={styles.batchLabel}>Agent</label>
              <div ref={batchAgentPickerRef} className={styles.batchAgentPicker}>
                <button
                  type="button"
                  className={styles.batchAgentTrigger}
                  onClick={() => setShowBatchAgentPicker((v) => !v)}
                >
                  {batchAgentId ? (() => {
                    const a = batchAgents.find((x) => x.id === batchAgentId);
                    return a ? (
                      <>
                        <AgentAvatar icon={a.avatarIcon || 'spark'} bgColor={a.avatarBgColor || '#1a1a2e'} logoColor={a.avatarLogoColor || '#e94560'} size={16} />
                        <span>{a.name}</span>
                      </>
                    ) : <span className={styles.batchAgentPlaceholder}>Select an agent...</span>;
                  })() : (
                    <span className={styles.batchAgentPlaceholder}>
                      {!batchAgentsLoaded ? 'Loading agents...' : 'Select an agent...'}
                    </span>
                  )}
                  <ChevronDown size={13} className={styles.batchAgentChevron} />
                </button>
                {showBatchAgentPicker && (
                  <div className={styles.batchAgentDropdown}>
                    {batchAgents.length === 0 ? (
                      <div className={styles.batchAgentEmpty}>No agents available</div>
                    ) : (
                      batchAgents.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          className={`${styles.batchAgentOption}${batchAgentId === a.id ? ` ${styles.batchAgentOptionActive}` : ''}`}
                          onClick={() => { setBatchAgentId(a.id); setShowBatchAgentPicker(false); }}
                        >
                          <AgentAvatar icon={a.avatarIcon || 'spark'} bgColor={a.avatarBgColor || '#1a1a2e'} logoColor={a.avatarLogoColor || '#e94560'} size={16} />
                          <span>{a.name}</span>
                          {batchAgentId === a.id && <Check size={12} className={styles.batchAgentCheck} />}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className={styles.batchField}>
              <label className={styles.batchLabel}>Prompt</label>
              <textarea
                className={styles.batchTextarea}
                value={batchPrompt}
                onChange={(e) => setBatchPrompt(e.target.value)}
                placeholder="Describe the task for the agent to perform on each card..."
                rows={5}
              />
              <span className={styles.batchHint}>
                The agent will receive the card name and description along with this prompt.
              </span>
            </div>

            <div className={styles.batchSection}>
              <div className={styles.batchSectionTitle}><Settings2 size={13} /> Card Filters</div>

              <div className={styles.batchFiltersGrid}>
                <div className={styles.batchField}>
                  <label className={styles.batchLabel}>Search</label>
                  <input
                    type="text"
                    className={styles.batchInput}
                    value={batchFilterSearch}
                    onChange={(e) => setBatchFilterSearch(e.target.value)}
                    placeholder="Search card name/description..."
                  />
                </div>

                <div className={styles.batchField}>
                  <label className={styles.batchLabel}>Status</label>
                  <select
                    className={styles.batchSelect}
                    value={batchFilterCompleted}
                    onChange={(e) => setBatchFilterCompleted(e.target.value as 'all' | 'incomplete' | 'completed')}
                  >
                    <option value="all">All cards</option>
                    <option value="incomplete">Incomplete only</option>
                    <option value="completed">Completed only</option>
                  </select>
                </div>

                <div className={styles.batchField}>
                  <label className={styles.batchLabel}>Priority</label>
                  <select
                    className={styles.batchSelect}
                    value={batchFilterPriority}
                    onChange={(e) => setBatchFilterPriority(e.target.value as '' | 'high' | 'medium' | 'low')}
                  >
                    <option value="">Any priority</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>

                <div className={styles.batchField}>
                  <label className={styles.batchLabel}>Tag</label>
                  <select
                    className={styles.batchSelect}
                    value={batchFilterTagId}
                    onChange={(e) => setBatchFilterTagId(e.target.value)}
                  >
                    <option value="">Any tag</option>
                    {workspaceTags.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className={styles.batchField}>
              <label className={styles.batchLabel}>Max Parallel Agents</label>
              <div className={styles.batchParallelRow}>
                <input
                  type="range"
                  min={1}
                  max={20}
                  value={batchMaxParallel}
                  onChange={(e) => setBatchMaxParallel(Number(e.target.value))}
                  className={styles.batchRange}
                />
                <span className={styles.batchParallelValue}>{batchMaxParallel}</span>
              </div>
              <span className={styles.batchHint}>
                Maximum number of agent instances running simultaneously.
              </span>
            </div>

            <div className={styles.batchActions}>
              <Button
                variant="secondary"
                onClick={() => { void handleSaveBatchConfig(); }}
                disabled={batchSaving || batchRunning}
              >
                {batchSaving ? 'Saving...' : 'Save Config'}
              </Button>
              <Button
                onClick={() => { void handleRunBatch(); }}
                disabled={batchRunning || batchSaving || !batchAgentId || !batchPrompt.trim()}
              >
                <Play size={14} />
                {batchRunning ? 'Starting...' : 'Run Now'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
