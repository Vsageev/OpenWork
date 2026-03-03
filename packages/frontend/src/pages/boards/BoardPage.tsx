import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { Plus, Trash2, Bot, FolderOpen, ChevronDown, Check, Clock, Search, X, ExternalLink, ArrowRight, MoveRight, Copy, CopyPlus, SearchX, ChevronsLeft, ChevronsRight, SlidersHorizontal, CalendarDays, Star, Tag, Users, AlertCircle, Circle, CircleCheck, ArrowUpDown, Flag, ListChecks, GripVertical, RefreshCw, MoreHorizontal, Layers } from 'lucide-react';
import { Button, EntitySwitcher, CreateCardModal } from '../../ui';
import { AgentAvatar } from '../../components/AgentAvatar';
import { PriorityBadge } from '../../components/PriorityBadge';
import { QuickDateButtons } from '../../components/QuickDateButtons';
import type { Priority } from '../../components/PriorityBadge';
import { useAuth } from '../../stores/useAuth';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../stores/toast';
import { useConfirm } from '../../hooks/useConfirm';
import { clearPreferredBoardId, setPreferredBoardId } from '../../lib/navigation-preferences';
import { addRecentVisit } from '../../lib/recent-visits';
import { stripMarkdown } from '../../lib/file-utils';
import { useWorkspace } from '../../stores/WorkspaceContext';
import { BoardCronTemplatesPanel } from './BoardCronTemplatesPanel';
import { BoardBatchRunPanel } from './BoardBatchRunPanel';
import { CardQuickView } from './CardQuickView';
import { useFavorites } from '../../hooks/useFavorites';
import styles from './BoardPage.module.css';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';

const COLUMN_COLORS = ['#6B7280', '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6'];

interface BoardColumn {
  id: string;
  boardId: string;
  name: string;
  color: string;
  position: number;
  assignAgentId: string | null;
  wipLimit: number | null;
}

interface AgentEntry {
  id: string;
  name: string;
  status: 'active' | 'inactive' | 'error';
  avatarIcon: string;
  avatarBgColor: string;
  avatarLogoColor: string;
}

interface CardTag {
  id: string;
  name: string;
  color: string;
}

interface CardAssignee {
  id: string;
  firstName: string;
  lastName: string;
  type?: 'user' | 'agent';
  avatarIcon?: string | null;
  avatarBgColor?: string | null;
  avatarLogoColor?: string | null;
}

interface CardData {
  id: string;
  name: string;
  description: string | null;
  collectionId: string;
  assignee: CardAssignee | null;
  tags: CardTag[];
  customFields?: Record<string, unknown>;
}

interface BoardCardEntry {
  id: string;
  boardId: string;
  cardId: string;
  columnId: string;
  position: number;
  card: CardData | null;
}

interface BoardWithCards {
  id: string;
  name: string;
  description: string | null;
  defaultCollectionId: string | null;
  isGeneral?: boolean;
  columns: BoardColumn[];
  cards: BoardCardEntry[];
}

function isGeneralBoard(board: BoardWithCards): boolean {
  if (board.isGeneral === true) return true;
  const normalizedName = board.name.trim().toLowerCase();
  return normalizedName === 'general' || normalizedName === 'general board';
}

function formatRefreshTime(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function getCollapsedColumns(boardId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`board-collapsed-${boardId}`);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* ignore */ }
  return new Set();
}

function setCollapsedColumns(boardId: string, collapsed: Set<string>) {
  try {
    localStorage.setItem(`board-collapsed-${boardId}`, JSON.stringify([...collapsed]));
  } catch { /* ignore */ }
}

interface SavedFilterState {
  text: string;
  tagIds: string[];
  assigneeIds: string[];
  dueDateFilters: string[];
  priorityFilters: string[];
}

function getFilterState(boardId: string): SavedFilterState {
  try {
    const raw = localStorage.getItem(`board-filters-${boardId}`);
    if (raw) return JSON.parse(raw) as SavedFilterState;
  } catch { /* ignore */ }
  return { text: '', tagIds: [], assigneeIds: [], dueDateFilters: [], priorityFilters: [] };
}

function saveFilterState(boardId: string, state: SavedFilterState) {
  try {
    if (!state.text && !state.tagIds.length && !state.assigneeIds.length && !state.dueDateFilters.length && !state.priorityFilters.length) {
      localStorage.removeItem(`board-filters-${boardId}`);
    } else {
      localStorage.setItem(`board-filters-${boardId}`, JSON.stringify(state));
    }
  } catch { /* ignore */ }
}

const VALID_DUE_FILTERS = new Set(['overdue', 'due-today', 'due-week', 'no-due-date']);

type ColumnSortOption = 'position' | 'name-asc' | 'name-desc' | 'due-asc' | 'due-desc' | 'newest' | 'oldest';

const SORT_LABELS: Record<ColumnSortOption, string> = {
  'position': 'Manual order',
  'name-asc': 'Name A\u2013Z',
  'name-desc': 'Name Z\u2013A',
  'due-asc': 'Due date (earliest)',
  'due-desc': 'Due date (latest)',
  'newest': 'Newest first',
  'oldest': 'Oldest first',
};

function getColumnSorts(boardId: string): Record<string, ColumnSortOption> {
  try {
    const raw = localStorage.getItem(`board-col-sort-${boardId}`);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

function saveColumnSorts(boardId: string, sorts: Record<string, ColumnSortOption>) {
  try {
    const filtered = Object.fromEntries(Object.entries(sorts).filter(([, v]) => v !== 'position'));
    if (Object.keys(filtered).length === 0) {
      localStorage.removeItem(`board-col-sort-${boardId}`);
    } else {
      localStorage.setItem(`board-col-sort-${boardId}`, JSON.stringify(filtered));
    }
  } catch { /* ignore */ }
}

function sortCards(cards: BoardCardEntry[], sortOption: ColumnSortOption): BoardCardEntry[] {
  if (sortOption === 'position') return cards;
  const sorted = [...cards];
  switch (sortOption) {
    case 'name-asc':
      sorted.sort((a, b) => (a.card?.name ?? '').localeCompare(b.card?.name ?? ''));
      break;
    case 'name-desc':
      sorted.sort((a, b) => (b.card?.name ?? '').localeCompare(a.card?.name ?? ''));
      break;
    case 'due-asc':
      sorted.sort((a, b) => {
        const da = (a.card?.customFields?.dueDate as string) ?? '';
        const db = (b.card?.customFields?.dueDate as string) ?? '';
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return da.localeCompare(db);
      });
      break;
    case 'due-desc':
      sorted.sort((a, b) => {
        const da = (a.card?.customFields?.dueDate as string) ?? '';
        const db = (b.card?.customFields?.dueDate as string) ?? '';
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return db.localeCompare(da);
      });
      break;
    case 'newest':
      sorted.sort((a, b) => b.position - a.position);
      break;
    case 'oldest':
      sorted.sort((a, b) => a.position - b.position);
      break;
  }
  return sorted;
}

export function BoardPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { activeWorkspace } = useWorkspace();
  const { isFavorite, toggleFavorite } = useFavorites();
  const [searchParams, setSearchParams] = useSearchParams();
  const [board, setBoard] = useState<BoardWithCards | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAddCard, setShowAddCard] = useState<string | null>(null);
  const [deletingBoard, setDeletingBoard] = useState(false);
  const [showBoardActions, setShowBoardActions] = useState(false);
  const boardActionsRef = useRef<HTMLDivElement>(null);
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [collections, setCollections] = useState<{ id: string; name: string }[]>([]);
  const [showCollectionPicker, setShowCollectionPicker] = useState(false);
  const [showCronPanel, setShowCronPanel] = useState(false);
  const [showBatchRunPanel, setShowBatchRunPanel] = useState(false);
  type DueDateFilter = 'overdue' | 'due-today' | 'due-week' | 'no-due-date';
  const [filterText, setFilterText] = useState(() => id ? getFilterState(id).text : '');
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(() => {
    if (!id) return new Set();
    return new Set(getFilterState(id).tagIds);
  });
  const [selectedAssigneeIds, setSelectedAssigneeIds] = useState<Set<string>>(() => {
    if (!id) return new Set();
    return new Set(getFilterState(id).assigneeIds);
  });
  const [selectedDueDateFilters, setSelectedDueDateFilters] = useState<Set<DueDateFilter>>(() => {
    if (!id) return new Set();
    return new Set(getFilterState(id).dueDateFilters.filter((v) => VALID_DUE_FILTERS.has(v)) as DueDateFilter[]);
  });
  const [selectedPriorityFilters, setSelectedPriorityFilters] = useState<Set<Priority>>(() => {
    if (!id) return new Set();
    const saved = getFilterState(id).priorityFilters ?? [];
    return new Set(saved.filter((v) => ['high', 'medium', 'low'].includes(v)) as Priority[]);
  });
  const [hideCompleted, setHideCompleted] = useState<boolean>(
    () => localStorage.getItem('board-hide-completed') === 'true',
  );
  const filterLoadedRef = useRef(id ?? null);
  const { user } = useAuth();
  useDocumentTitle(board?.name ?? 'Board');
  const [quickViewCardId, setQuickViewCardId] = useState<string | null>(null);
  const [collapsedCols, setCollapsedCols] = useState<Set<string>>(() => id ? getCollapsedColumns(id) : new Set());
  const [columnSorts, setColumnSorts] = useState<Record<string, ColumnSortOption>>(() => id ? getColumnSorts(id) : {});
  const collectionPickerRef = useRef<HTMLDivElement>(null);
  const dragCardRef = useRef<BoardCardEntry | null>(null);
  const dragColumnRef = useRef<BoardColumn | null>(null);
  const [columnDropTarget, setColumnDropTarget] = useState<string | null>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const pendingDeleteTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Auto-refresh polling
  const AUTO_REFRESH_INTERVAL = 30_000; // 30 seconds
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [isAutoRefreshing, setIsAutoRefreshing] = useState(false);
  const isDraggingRef = useRef(false);

  const recoverFromMissingBoard = useCallback(async () => {
    try {
      const res = await api<{ entries: { id: string }[] }>('/boards?limit=100');
      const fallbackBoardId = res.entries[0]?.id;
      if (!fallbackBoardId || fallbackBoardId === id) {
        clearPreferredBoardId();
        navigate('/boards?list=1', { replace: true });
        return;
      }
      setPreferredBoardId(fallbackBoardId);
      navigate(`/boards/${fallbackBoardId}`, { replace: true });
    } catch {
      clearPreferredBoardId();
      navigate('/boards?list=1', { replace: true });
    }
  }, [id, navigate]);

  const fetchBoard = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    setBoard(null);
    try {
      const data = await api<BoardWithCards>(`/boards/${id}`);
      setBoard(data);
      addRecentVisit({ type: 'board', id: data.id, name: data.name, path: `/boards/${data.id}` });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 404) {
          setError('Board not found');
          void recoverFromMissingBoard();
          return;
        }
        setError(err.message);
      } else {
        setError('Failed to load board');
      }
    } finally {
      setLoading(false);
    }
  }, [id, recoverFromMissingBoard]);

  useEffect(() => {
    fetchBoard();
  }, [fetchBoard]);

  // Silent refresh for auto-polling (no loading spinner, no error state changes)
  const silentRefresh = useCallback(async () => {
    if (!id || isDraggingRef.current) return;
    setIsAutoRefreshing(true);
    try {
      const data = await api<BoardWithCards>(`/boards/${id}`);
      setBoard(data);
      setLastRefreshedAt(Date.now());
    } catch {
      // Silently ignore — the user already has the last good state
    } finally {
      setIsAutoRefreshing(false);
    }
  }, [id]);

  // Set lastRefreshedAt after initial load
  useEffect(() => {
    if (board && lastRefreshedAt === null) {
      setLastRefreshedAt(Date.now());
    }
  }, [board, lastRefreshedAt]);

  // Auto-refresh polling with Page Visibility API
  useEffect(() => {
    if (!board || !id) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    function startPolling() {
      if (intervalId) return;
      intervalId = setInterval(() => {
        void silentRefresh();
      }, AUTO_REFRESH_INTERVAL);
    }

    function stopPolling() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        stopPolling();
      } else {
        // Refresh immediately when tab becomes visible again, then resume polling
        void silentRefresh();
        startPolling();
      }
    }

    startPolling();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [board, id, silentRefresh]);

  // Clean up pending delete timers on unmount
  useEffect(() => {
    const timers = pendingDeleteTimers;
    return () => {
      for (const t of timers.current.values()) clearTimeout(t);
      timers.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!board || !activeWorkspace) return;
    if (!activeWorkspace.boardIds.includes(board.id)) {
      void recoverFromMissingBoard();
    }
  }, [board, activeWorkspace, recoverFromMissingBoard]);

  useEffect(() => {
    api<{ entries: AgentEntry[] }>('/agents?limit=100')
      .then((res) => setAgents(res.entries.filter((a) => a.status === 'active')))
      .catch(() => {});
    api<{ entries: { id: string; name: string }[] }>('/collections?limit=100')
      .then((res) => setCollections(res.entries))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!board?.id) return;
    setPreferredBoardId(board.id);
  }, [board?.id]);

  const sortedColumns = useMemo(
    () => (board ? [...board.columns].sort((a, b) => a.position - b.position) : []),
    [board],
  );

  // Restore filter state when navigating to a different board
  useEffect(() => {
    if (!id || filterLoadedRef.current === id) return;
    filterLoadedRef.current = id;
    const saved = getFilterState(id);
    setFilterText(saved.text);
    setSelectedTagIds(new Set(saved.tagIds));
    setSelectedAssigneeIds(new Set(saved.assigneeIds));
    setSelectedDueDateFilters(new Set(saved.dueDateFilters.filter((v) => VALID_DUE_FILTERS.has(v)) as DueDateFilter[]));
    setSelectedPriorityFilters(new Set((saved.priorityFilters ?? []).filter((v) => ['high', 'medium', 'low'].includes(v)) as Priority[]));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist filter state to localStorage whenever filters change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!id) return;
    saveFilterState(id, {
      text: filterText,
      tagIds: [...selectedTagIds],
      assigneeIds: [...selectedAssigneeIds],
      dueDateFilters: [...selectedDueDateFilters],
      priorityFilters: [...selectedPriorityFilters],
    });
  }, [filterText, selectedTagIds, selectedAssigneeIds, selectedDueDateFilters, selectedPriorityFilters]);

  const shouldOpenCreateCard = searchParams.get('newCard') === '1';

  useEffect(() => {
    if (!shouldOpenCreateCard || sortedColumns.length === 0) return;
    setShowAddCard(sortedColumns[0].id);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('newCard');
    setSearchParams(nextParams, { replace: true });
  }, [shouldOpenCreateCard, sortedColumns, searchParams, setSearchParams]);

  const cardsByColumn = useMemo(() => {
    if (!board) return new Map<string, BoardCardEntry[]>();
    const map = new Map<string, BoardCardEntry[]>();
    const needle = filterText.trim().toLowerCase();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekFromNow = new Date(today);
    weekFromNow.setDate(weekFromNow.getDate() + 7);
    for (const bc of board.cards) {
      // Text filter
      if (needle) {
        const name = bc.card?.name?.toLowerCase() ?? '';
        const desc = bc.card?.description?.toLowerCase() ?? '';
        const tagMatch = bc.card?.tags?.some(t => t.name.toLowerCase().includes(needle)) ?? false;
        const assigneeName = bc.card?.assignee
          ? `${bc.card.assignee.firstName} ${bc.card.assignee.lastName}`.toLowerCase()
          : '';
        if (!name.includes(needle) && !desc.includes(needle) && !tagMatch && !assigneeName.includes(needle)) continue;
      }
      // Tag filter
      if (selectedTagIds.size > 0) {
        if (!bc.card?.tags?.some(t => selectedTagIds.has(t.id))) continue;
      }
      // Assignee filter
      if (selectedAssigneeIds.size > 0) {
        if (bc.card?.assignee) {
          if (!selectedAssigneeIds.has(bc.card.assignee.id)) continue;
        } else {
          if (!selectedAssigneeIds.has('__unassigned__')) continue;
        }
      }
      // Hide completed filter
      if (hideCompleted && bc.card?.customFields?.completed === true) continue;
      // Priority filter
      if (selectedPriorityFilters.size > 0) {
        const cardPriority = bc.card?.customFields?.priority as Priority | undefined;
        if (!cardPriority || !selectedPriorityFilters.has(cardPriority)) continue;
      }
      // Due date filter
      if (selectedDueDateFilters.size > 0) {
        const dueDateStr = bc.card?.customFields?.dueDate as string | undefined;
        const matches = Array.from(selectedDueDateFilters).some((f) => {
          if (f === 'no-due-date') return !dueDateStr;
          if (!dueDateStr) return false;
          const due = new Date(dueDateStr);
          if (f === 'overdue') return due < today;
          if (f === 'due-today') return due.toDateString() === today.toDateString();
          if (f === 'due-week') return due >= today && due < weekFromNow;
          return false;
        });
        if (!matches) continue;
      }
      const arr = map.get(bc.columnId);
      if (arr) arr.push(bc);
      else map.set(bc.columnId, [bc]);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.position - b.position);
    }
    return map;
  }, [board, filterText, selectedTagIds, selectedAssigneeIds, selectedDueDateFilters, selectedPriorityFilters, hideCompleted]);

  const visibleCardCount = useMemo(() => {
    let count = 0;
    for (const arr of cardsByColumn.values()) count += arr.length;
    return count;
  }, [cardsByColumn]);

  // Flat list of visible card IDs in column order for quick-view navigation
  const visibleCardIds = useMemo(() => {
    const ids: string[] = [];
    for (const col of sortedColumns) {
      const cards = cardsByColumn.get(col.id);
      if (cards) ids.push(...cards.map((bc) => bc.cardId));
    }
    return ids;
  }, [sortedColumns, cardsByColumn]);

  const isFiltering = filterText.trim().length > 0;
  const hasChipFilters = selectedTagIds.size > 0 || selectedAssigneeIds.size > 0 || selectedDueDateFilters.size > 0 || selectedPriorityFilters.size > 0;

  const completedCount = useMemo(() => {
    if (!board) return 0;
    return board.cards.filter((bc) => bc.card?.customFields?.completed === true).length;
  }, [board]);

  // Collect unique tags from all board cards
  const allBoardTags = useMemo(() => {
    if (!board) return [];
    const tagMap = new Map<string, CardTag>();
    for (const bc of board.cards) {
      for (const tag of bc.card?.tags ?? []) {
        if (!tagMap.has(tag.id)) tagMap.set(tag.id, tag);
      }
    }
    return Array.from(tagMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [board]);

  // Collect unique assignees from all board cards
  const allBoardAssignees = useMemo(() => {
    if (!board) return { entries: [] as CardAssignee[], hasUnassigned: false };
    const assigneeMap = new Map<string, CardAssignee>();
    let hasUnassigned = false;
    for (const bc of board.cards) {
      if (bc.card?.assignee) {
        if (!assigneeMap.has(bc.card.assignee.id)) assigneeMap.set(bc.card.assignee.id, bc.card.assignee);
      } else {
        hasUnassigned = true;
      }
    }
    return {
      entries: Array.from(assigneeMap.values()).sort((a, b) => a.firstName.localeCompare(b.firstName)),
      hasUnassigned,
    };
  }, [board]);

  function toggleTagFilter(tagId: string) {
    setSelectedTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }

  function toggleAssigneeFilter(assigneeId: string) {
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

  function togglePriorityFilter(priority: Priority) {
    setSelectedPriorityFilters((prev) => {
      const next = new Set(prev);
      if (next.has(priority)) next.delete(priority);
      else next.add(priority);
      return next;
    });
  }

  // Reset filter and load collapsed state when switching boards
  useEffect(() => {
    setFilterText('');
    setSelectedTagIds(new Set());
    setSelectedAssigneeIds(new Set());
    setSelectedDueDateFilters(new Set());
    setSelectedPriorityFilters(new Set());
    setLastRefreshedAt(null);
    if (id) {
      setCollapsedCols(getCollapsedColumns(id));
      setColumnSorts(getColumnSorts(id));
    }
  }, [id]);

  const setColumnSort = useCallback((columnId: string, sort: ColumnSortOption) => {
    if (!id) return;
    setColumnSorts((prev) => {
      const next = { ...prev, [columnId]: sort };
      saveColumnSorts(id, next);
      return next;
    });
  }, [id]);

  const toggleColumnCollapsed = useCallback((columnId: string) => {
    if (!id) return;
    setCollapsedCols((prev) => {
      const next = new Set(prev);
      if (next.has(columnId)) next.delete(columnId);
      else next.add(columnId);
      setCollapsedColumns(id, next);
      return next;
    });
  }, [id]);

  // Cmd/Ctrl+F focuses the filter input
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        filterInputRef.current?.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  function handleDragStart(e: React.DragEvent, boardCard: BoardCardEntry) {
    dragCardRef.current = boardCard;
    isDraggingRef.current = true;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', boardCard.cardId);
    requestAnimationFrame(() => {
      (e.currentTarget as HTMLElement).classList.add(styles.dragging);
    });
  }

  function handleDragEnd(e: React.DragEvent) {
    dragCardRef.current = null;
    isDraggingRef.current = false;
    (e.currentTarget as HTMLElement).classList.remove(styles.dragging);
  }

  function handleColumnDragStart(e: React.DragEvent, col: BoardColumn) {
    dragColumnRef.current = col;
    isDraggingRef.current = true;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-column-id', col.id);
    requestAnimationFrame(() => {
      (e.currentTarget as HTMLElement).classList.add(styles.columnDragging);
    });
  }

  function handleColumnDragEnd(e: React.DragEvent) {
    dragColumnRef.current = null;
    isDraggingRef.current = false;
    setColumnDropTarget(null);
    (e.currentTarget as HTMLElement).classList.remove(styles.columnDragging);
  }

  function handleColumnDragOver(e: React.DragEvent, targetColumnId: string) {
    if (!dragColumnRef.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setColumnDropTarget(targetColumnId);
  }

  function handleColumnDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setColumnDropTarget(null);
    }
  }

  async function handleColumnDrop(e: React.DragEvent, targetColumnId: string) {
    e.preventDefault();
    setColumnDropTarget(null);
    const draggedCol = dragColumnRef.current;
    if (!draggedCol || !board || draggedCol.id === targetColumnId) return;

    const sorted = [...board.columns].sort((a, b) => a.position - b.position);
    const fromIndex = sorted.findIndex((c) => c.id === draggedCol.id);
    const toIndex = sorted.findIndex((c) => c.id === targetColumnId);
    if (fromIndex === -1 || toIndex === -1) return;

    // Reorder: remove from old position, insert at new position
    const reordered = [...sorted];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);

    // Assign new positions
    const updatedColumns = reordered.map((col, i) => ({ ...col, position: i }));

    // Optimistic update
    setBoard({ ...board, columns: updatedColumns });

    // Persist each changed column position
    try {
      const promises = updatedColumns
        .filter((col, i) => {
          const original = sorted[i];
          return !original || original.id !== col.id;
        })
        .map((col) =>
          api(`/boards/${board.id}/columns/${col.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ position: col.position }),
          }),
        );
      await Promise.all(promises);
    } catch (err) {
      // Revert on failure
      fetchBoard();
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to reorder columns');
    }
  }

  async function handleDrop(e: React.DragEvent, targetColumnId: string) {
    e.preventDefault();
    const bc = dragCardRef.current;
    if (!bc || !board) return;
    if (bc.columnId === targetColumnId) return;

    const sourceColumnId = bc.columnId;
    const targetCol = board.columns.find((c) => c.id === targetColumnId);
    const cardName = bc.card?.name ?? 'Card';

    // WIP limit check — block the drop if target column is at capacity, allow override via confirm
    if (targetCol?.wipLimit != null) {
      const cardsInTargetCol = board.cards.filter((c) => c.columnId === targetColumnId).length;
      if (cardsInTargetCol >= targetCol.wipLimit) {
        const ok = await confirm({
          title: 'WIP limit reached',
          message: `"${targetCol.name}" is at its WIP limit (${cardsInTargetCol}/${targetCol.wipLimit} cards). Move "${cardName}" anyway?`,
          confirmLabel: 'Move anyway',
        });
        if (!ok) return;
      }
    }

    // Optimistic update
    setBoard({
      ...board,
      cards: board.cards.map((c) =>
        c.cardId === bc.cardId ? { ...c, columnId: targetColumnId } : c,
      ),
    });

    try {
      await api(`/boards/${board.id}/cards/${bc.cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ columnId: targetColumnId }),
      });
      toast.success(`Moved to ${targetCol?.name ?? 'column'}`, {
        action: {
          label: 'Undo',
          onClick: () => {
            // Revert the move optimistically
            setBoard((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                cards: prev.cards.map((c) =>
                  c.cardId === bc.cardId ? { ...c, columnId: sourceColumnId } : c,
                ),
              };
            });
            // Persist the revert
            api(`/boards/${board.id}/cards/${bc.cardId}`, {
              method: 'PATCH',
              body: JSON.stringify({ columnId: sourceColumnId }),
            }).catch(() => {
              toast.error('Failed to undo move');
              fetchBoard();
            });
          },
        },
      });
    } catch (err) {
      // Revert on failure
      setBoard((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          cards: prev.cards.map((c) =>
            c.cardId === bc.cardId ? { ...c, columnId: sourceColumnId } : c,
          ),
        };
      });
      if (err instanceof ApiError) setError(err.message);
    }
  }

  async function handleQuickAddCard(columnId: string, name: string) {
    if (!board) return;
    try {
      const card = await api<CardData>('/cards', {
        method: 'POST',
        body: JSON.stringify({
          collectionId: board.defaultCollectionId,
          name,
          description: null,
        }),
      });
      await api(`/boards/${board.id}/cards`, {
        method: 'POST',
        body: JSON.stringify({ cardId: card.id, columnId }),
      });
      fetchBoard();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to create card');
    }
  }

  async function handleAddCard(data: { name: string; description: string | null; assigneeId: string | null; tagIds: string[]; linkedCardIds: string[]; dueDate?: string; priority?: Priority }) {
    if (!showAddCard || !board) return;
    try {
      // Create the card in the board's default collection
      const card = await api<CardData>('/cards', {
        method: 'POST',
        body: JSON.stringify({
          collectionId: board.defaultCollectionId,
          name: data.name,
          description: data.description,
          assigneeId: data.assigneeId,
          ...((() => { const cf: Record<string, unknown> = {}; if (data.dueDate) cf.dueDate = data.dueDate; if (data.priority) cf.priority = data.priority; return Object.keys(cf).length > 0 ? { customFields: cf } : {}; })()),
        }),
      });

      // Add it to the board column
      await api(`/boards/${board.id}/cards`, {
        method: 'POST',
        body: JSON.stringify({ cardId: card.id, columnId: showAddCard }),
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

      fetchBoard();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to create card');
    }
  }

  async function handleBulkAddCards(columnId: string, names: string[]) {
    if (!board || names.length === 0) return;
    let created = 0;
    for (const name of names) {
      try {
        const card = await api<CardData>('/cards', {
          method: 'POST',
          body: JSON.stringify({
            collectionId: board.defaultCollectionId,
            name,
            description: null,
          }),
        });
        await api(`/boards/${board.id}/cards`, {
          method: 'POST',
          body: JSON.stringify({ cardId: card.id, columnId }),
        });
        created++;
      } catch {
        // Continue creating remaining cards even if one fails
      }
    }
    fetchBoard();
    if (created === names.length) {
      toast.success(`Created ${created} card${created !== 1 ? 's' : ''}`);
    } else {
      toast.warning(`Created ${created} of ${names.length} cards`);
    }
  }

  async function handleUpdateColumn(columnId: string, data: Record<string, unknown>) {
    if (!board) return;
    try {
      await api(`/boards/${board.id}/columns/${columnId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
      fetchBoard();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }

  async function handleAddColumn(name: string, color: string) {
    if (!board) return;
    const maxPos = board.columns.reduce((max, c) => Math.max(max, c.position), 0);
    try {
      await api(`/boards/${board.id}/columns`, {
        method: 'POST',
        body: JSON.stringify({ name, color, position: maxPos + 1 }),
      });
      fetchBoard();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }

  async function handleMoveCard(cardId: string, targetColumnId: string) {
    if (!board) return;
    const bc = board.cards.find((c) => c.cardId === cardId);
    if (!bc || bc.columnId === targetColumnId) return;

    const sourceColumnId = bc.columnId;
    const targetCol = board.columns.find((c) => c.id === targetColumnId);

    // WIP limit check — warn before moving if target column is at capacity
    if (targetCol?.wipLimit != null) {
      const cardsInTargetCol = board.cards.filter((c) => c.columnId === targetColumnId).length;
      if (cardsInTargetCol >= targetCol.wipLimit) {
        const cardName = bc.card?.name ?? 'Card';
        const ok = await confirm({
          title: 'WIP limit reached',
          message: `"${targetCol.name}" is at its WIP limit (${cardsInTargetCol}/${targetCol.wipLimit} cards). Move "${cardName}" anyway?`,
          confirmLabel: 'Move anyway',
        });
        if (!ok) return;
      }
    }

    // Optimistic update
    setBoard({
      ...board,
      cards: board.cards.map((c) =>
        c.cardId === cardId ? { ...c, columnId: targetColumnId } : c,
      ),
    });

    try {
      await api(`/boards/${board.id}/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ columnId: targetColumnId }),
      });
      toast.success(`Moved to ${targetCol?.name ?? 'column'}`, {
        action: {
          label: 'Undo',
          onClick: () => {
            setBoard((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                cards: prev.cards.map((c) =>
                  c.cardId === cardId ? { ...c, columnId: sourceColumnId } : c,
                ),
              };
            });
            api(`/boards/${board.id}/cards/${cardId}`, {
              method: 'PATCH',
              body: JSON.stringify({ columnId: sourceColumnId }),
            }).catch(() => {
              toast.error('Failed to undo move');
              fetchBoard();
            });
          },
        },
      });
    } catch (err) {
      setBoard((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          cards: prev.cards.map((c) =>
            c.cardId === cardId ? { ...c, columnId: sourceColumnId } : c,
          ),
        };
      });
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to move card');
    }
  }

  function handleCardUpdated(cardId: string, updates: { name?: string; description?: string | null; assigneeId?: string | null; assignee?: CardAssignee | null; customFields?: Record<string, unknown> }) {
    if (!board) return;
    setBoard({
      ...board,
      cards: board.cards.map((c) =>
        c.cardId === cardId && c.card
          ? { ...c, card: { ...c.card, ...updates } }
          : c,
      ),
    });
  }

  function handleDeleteCard(cardId: string, cardName: string) {
    if (!board) return;

    // Optimistically remove card from the board
    const prevCards = board.cards;
    setBoard({ ...board, cards: board.cards.filter((c) => c.cardId !== cardId) });

    // Cancel any existing pending delete for this card (e.g. if undo was clicked then delete again)
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
          // Restore the card
          setBoard((prev) => prev ? { ...prev, cards: prevCards } : prev);
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
        // Restore on failure
        setBoard((prev) => prev ? { ...prev, cards: prevCards } : prev);
        if (err instanceof ApiError) toast.error(err.message);
        else toast.error('Failed to delete card');
      }
    }, 5000);

    pendingDeleteTimers.current.set(cardId, timer);
  }

  async function handleDuplicateCard(cardId: string, columnId: string) {
    if (!board) return;
    const entry = board.cards.find((c) => c.cardId === cardId);
    if (!entry?.card) return;
    const src = entry.card;
    try {
      const newCard = await api<CardData>('/cards', {
        method: 'POST',
        body: JSON.stringify({
          collectionId: src.collectionId,
          name: `Copy of ${src.name}`,
          description: src.description ?? undefined,
          customFields: src.customFields ?? undefined,
          assigneeId: src.assignee?.id ?? undefined,
        }),
      });
      if (src.tags.length > 0) {
        await Promise.allSettled(
          src.tags.map((t) =>
            api(`/cards/${newCard.id}/tags`, { method: 'POST', body: JSON.stringify({ tagId: t.id }) }),
          ),
        );
      }
      await api(`/boards/${board.id}/cards`, {
        method: 'POST',
        body: JSON.stringify({ cardId: newCard.id, columnId }),
      });
      toast.success('Card duplicated');
      fetchBoard();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to duplicate card');
    }
  }

  async function handleSetPriority(cardId: string, priority: Priority | null) {
    if (!board) return;
    const entry = board.cards.find((c) => c.cardId === cardId);
    if (!entry?.card) return;
    const prevCustomFields = entry.card.customFields;
    const newCustomFields = { ...prevCustomFields };
    if (priority) newCustomFields.priority = priority;
    else delete newCustomFields.priority;
    setBoard({
      ...board,
      cards: board.cards.map((c) =>
        c.cardId === cardId && c.card
          ? { ...c, card: { ...c.card, customFields: newCustomFields } }
          : c,
      ),
    });
    try {
      await api(`/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
    } catch (err) {
      setBoard((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          cards: prev.cards.map((c) =>
            c.cardId === cardId && c.card
              ? { ...c, card: { ...c.card, customFields: prevCustomFields } }
              : c,
          ),
        };
      });
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to update priority');
    }
  }

  async function handleSetDueDate(cardId: string, dueDate: string | null) {
    if (!board) return;
    const entry = board.cards.find((c) => c.cardId === cardId);
    if (!entry?.card) return;
    const prevCustomFields = entry.card.customFields;
    const newCustomFields = { ...prevCustomFields, dueDate };
    // Optimistic update
    setBoard({
      ...board,
      cards: board.cards.map((c) =>
        c.cardId === cardId && c.card
          ? { ...c, card: { ...c.card, customFields: newCustomFields } }
          : c,
      ),
    });
    try {
      await api(`/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
    } catch (err) {
      // Revert
      setBoard((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          cards: prev.cards.map((c) =>
            c.cardId === cardId && c.card
              ? { ...c, card: { ...c.card, customFields: prevCustomFields } }
              : c,
          ),
        };
      });
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to update due date');
    }
  }

  async function handleToggleComplete(cardId: string, currentCompleted: boolean) {
    if (!board) return;
    const newCompleted = !currentCompleted;
    // Optimistic update
    setBoard({
      ...board,
      cards: board.cards.map((c) =>
        c.cardId === cardId && c.card
          ? { ...c, card: { ...c.card, customFields: { ...c.card.customFields, completed: newCompleted } } }
          : c,
      ),
    });
    try {
      const entry = board.cards.find((c) => c.cardId === cardId);
      const newCustomFields = { ...entry?.card?.customFields, completed: newCompleted };
      await api(`/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
    } catch (err) {
      // Revert
      setBoard((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          cards: prev.cards.map((c) =>
            c.cardId === cardId && c.card
              ? { ...c, card: { ...c.card, customFields: { ...c.card.customFields, completed: currentCompleted } } }
              : c,
          ),
        };
      });
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to update card');
    }
  }

  async function handleDeleteColumn(columnId: string) {
    if (!board) return;
    const col = board.columns.find((c) => c.id === columnId);
    const colCards = cardsByColumn.get(columnId) || [];
    const msg = colCards.length > 0
      ? `Delete column "${col?.name}"? Its ${colCards.length} card(s) will be removed from the board.`
      : `Delete column "${col?.name}"?`;
    const confirmed = await confirm({
      title: 'Delete column',
      message: msg,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await api(`/boards/${board.id}/columns/${columnId}`, { method: 'DELETE' });
      fetchBoard();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }

  useEffect(() => {
    if (!showCollectionPicker) return;
    function onClickOutside(e: MouseEvent) {
      if (collectionPickerRef.current && !collectionPickerRef.current.contains(e.target as Node)) {
        setShowCollectionPicker(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [showCollectionPicker]);

  useEffect(() => {
    if (!showBoardActions) return;
    function onClickOutside(e: MouseEvent) {
      if (boardActionsRef.current && !boardActionsRef.current.contains(e.target as Node)) {
        setShowBoardActions(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [showBoardActions]);

  async function handleChangeDefaultCollection(collectionId: string) {
    if (!board) return;
    setShowCollectionPicker(false);
    try {
      await api(`/boards/${board.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ defaultCollectionId: collectionId }),
      });
      setBoard({ ...board, defaultCollectionId: collectionId });
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }

  async function handleDeleteBoard() {
    if (!board || isGeneralBoard(board)) return;

    const confirmed = await confirm({
      title: 'Delete board',
      message: `Delete board "${board.name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;

    setDeletingBoard(true);
    try {
      await api(`/boards/${board.id}`, { method: 'DELETE' });
      clearPreferredBoardId();
      navigate('/boards?list=1', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('Failed to delete board');
    } finally {
      setDeletingBoard(false);
    }
  }

  if (loading) return (
    <div className={styles.loadingState}>
      {[0, 1, 2].map((i) => (
        <div key={i} className={styles.skeletonColumn} />
      ))}
    </div>
  );
  if (!board) return <div className={styles.emptyState}>{error || 'Board not found'}</div>;

  return (
    <div className={styles.wrapper}>
      {confirmDialog}
      <div className={styles.topBar}>
        <EntitySwitcher
          currentId={id!}
          currentName={board.name}
          fetchEntries={async () => {
            const res = await api<{ entries: { id: string; name: string }[] }>('/boards?limit=100');
            return res.entries;
          }}
          basePath="/boards"
          allLabel="All Boards"
          size="large"
        />
        {board && (
          <button
            className={`${styles.favoriteBtn} ${isFavorite(board.id) ? styles.favoriteBtnActive : ''}`}
            onClick={() => toggleFavorite({ id: board.id, type: 'board', name: board.name })}
            title={isFavorite(board.id) ? 'Remove from favorites' : 'Add to favorites'}
          >
            <Star size={16} />
          </button>
        )}

        <div className={styles.topBarActions}>
          <div className={styles.filterBar}>
            <Search size={14} className={styles.filterIcon} />
            <input
              ref={filterInputRef}
              className={styles.filterInput}
              type="text"
              placeholder={`Filter cards\u2026 ${navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl+'}F`}
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setFilterText('');
                  filterInputRef.current?.blur();
                }
              }}
            />
            {isFiltering && (
              <button
                className={styles.filterClear}
                onClick={() => { setFilterText(''); filterInputRef.current?.focus(); }}
                title="Clear filter"
              >
                <X size={12} />
              </button>
            )}
          </div>
          <div className={styles.collectionPicker} ref={collectionPickerRef}>
            <button
              className={styles.collectionPickerBtn}
              onClick={() => setShowCollectionPicker(!showCollectionPicker)}
            >
              <FolderOpen size={14} />
              {collections.find((c) => c.id === board.defaultCollectionId)?.name || 'Default collection'}
              <ChevronDown size={12} />
            </button>
            {showCollectionPicker && (
              <div className={styles.collectionPickerMenu}>
                <div className={styles.automationMenuTitle}>Default collection</div>
                {collections.map((c) => (
                  <button
                    key={c.id}
                    className={[styles.automationMenuItem, c.id === board.defaultCollectionId ? styles.automationMenuItemActive : ''].filter(Boolean).join(' ')}
                    onClick={() => handleChangeDefaultCollection(c.id)}
                  >
                    {c.name}
                    {c.id === board.defaultCollectionId && <Check size={12} style={{ marginLeft: 'auto' }} />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button variant="secondary" onClick={() => setShowCronPanel(true)}>
            <Clock size={14} />
            Scheduled
          </Button>
          <Button variant="secondary" onClick={() => setShowBatchRunPanel(true)}>
            <Bot size={14} />
            Batch run
          </Button>
          <span className={styles.cardCountInline}>
            {isFiltering || hasChipFilters || hideCompleted
              ? `${visibleCardCount} of ${board.cards.length} card${board.cards.length !== 1 ? 's' : ''}`
              : `${board.cards.length} card${board.cards.length !== 1 ? 's' : ''}`
            }
          </span>
          <button
            className={`${styles.refreshBtn}${isAutoRefreshing ? ` ${styles.refreshBtnSpinning}` : ''}`}
            onClick={() => void silentRefresh()}
            title={lastRefreshedAt ? `Last updated ${formatRefreshTime(lastRefreshedAt)}. Click to refresh.` : 'Refresh board'}
            aria-label="Refresh board"
          >
            <RefreshCw size={13} />
          </button>
          {completedCount > 0 && (
            <button
              className={`${styles.completedToggle}${hideCompleted ? '' : ` ${styles.completedToggleVisible}`}`}
              onClick={() => {
                setHideCompleted((v) => {
                  localStorage.setItem('board-hide-completed', String(!v));
                  return !v;
                });
              }}
              title={hideCompleted ? `Show ${completedCount} completed card${completedCount !== 1 ? 's' : ''}` : 'Hide completed cards'}
            >
              <CircleCheck size={13} />
              {hideCompleted ? `${completedCount} done` : 'Hide done'}
            </button>
          )}
          {!isGeneralBoard(board) && (
            <div className={styles.boardActionsWrap} ref={boardActionsRef}>
              <button
                className={styles.boardActionsBtn}
                onClick={() => setShowBoardActions((v) => !v)}
                title="Board actions"
                aria-label="Board actions"
              >
                <MoreHorizontal size={16} />
              </button>
              {showBoardActions && (
                <div className={styles.boardActionsMenu}>
                  <button
                    className={styles.boardActionsMenuItem}
                    onClick={() => { setShowBoardActions(false); void handleDeleteBoard(); }}
                    disabled={deletingBoard}
                  >
                    <Trash2 size={14} />
                    {deletingBoard ? 'Deleting...' : 'Delete board'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {error && <div className={styles.alert}>{error}</div>}

      {(allBoardTags.length > 0 || allBoardAssignees.entries.length > 0 || board.cards.length > 0) && (
        <div className={styles.filtersRow}>
          {allBoardTags.length > 0 && (
            <div className={styles.chipGroup}>
              <Tag size={13} className={styles.chipIcon} />
              {allBoardTags.map((tag) => {
                const active = selectedTagIds.has(tag.id);
                return (
                  <button
                    key={tag.id}
                    className={`${styles.filterChip}${active ? ` ${styles.filterChipTagActive}` : ''}`}
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
          {allBoardAssignees.entries.length > 0 && (
            <div className={styles.chipGroup}>
              <Users size={13} className={styles.chipIcon} />
              {user && allBoardAssignees.entries.some((a) => a.id === user.id) && (
                <button
                  className={`${styles.filterChip}${selectedAssigneeIds.has(user.id) ? ` ${styles.filterChipActive}` : ''}`}
                  onClick={() => toggleAssigneeFilter(user.id)}
                  title={selectedAssigneeIds.has(user.id) ? 'Remove "My cards" filter' : 'Show only my cards'}
                >
                  My cards
                </button>
              )}
              {allBoardAssignees.entries
                .filter((a) => !user || a.id !== user.id)
                .map((assignee) => {
                  const active = selectedAssigneeIds.has(assignee.id);
                  const label = assignee.type === 'agent' ? assignee.firstName : `${assignee.firstName} ${assignee.lastName}`;
                  return (
                    <button
                      key={assignee.id}
                      className={`${styles.filterChip}${active ? ` ${styles.filterChipActive}` : ''}${assignee.type === 'agent' ? ` ${styles.filterChipAgent}` : ''}`}
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
              {allBoardAssignees.hasUnassigned && (
                <button
                  className={`${styles.filterChip}${selectedAssigneeIds.has('__unassigned__') ? ` ${styles.filterChipActive}` : ''}`}
                  onClick={() => toggleAssigneeFilter('__unassigned__')}
                  title={selectedAssigneeIds.has('__unassigned__') ? 'Remove "Unassigned" filter' : 'Show only unassigned cards'}
                >
                  Unassigned
                </button>
              )}
            </div>
          )}
          <div className={styles.chipGroup}>
            <CalendarDays size={13} className={styles.chipIcon} />
            {([
              { key: 'overdue' as DueDateFilter, label: 'Overdue', danger: true },
              { key: 'due-today' as DueDateFilter, label: 'Due today', danger: false },
              { key: 'due-week' as DueDateFilter, label: 'This week', danger: false },
              { key: 'no-due-date' as DueDateFilter, label: 'No due date', danger: false },
            ]).map(({ key, label, danger }) => {
              const active = selectedDueDateFilters.has(key);
              return (
                <button
                  key={key}
                  className={`${styles.filterChip}${active ? ` ${styles.filterChipActive}` : ''}${danger && active ? ` ${styles.filterChipDanger}` : ''}`}
                  onClick={() => toggleDueDateFilter(key)}
                  title={active ? `Remove "${label}" filter` : `Filter by "${label}"`}
                >
                  {key === 'overdue' && <AlertCircle size={11} />}
                  {label}
                </button>
              );
            })}
          </div>
          {board.cards.some((bc) => bc.card?.customFields?.priority) && (
            <div className={styles.chipGroup}>
              <Flag size={13} className={styles.chipIcon} />
              {([
                { value: 'high' as Priority, label: 'High', color: '#EF4444' },
                { value: 'medium' as Priority, label: 'Medium', color: '#F59E0B' },
                { value: 'low' as Priority, label: 'Low', color: '#60A5FA' },
              ]).map(({ value, label, color }) => {
                const active = selectedPriorityFilters.has(value);
                return (
                  <button
                    key={value}
                    className={`${styles.filterChip}${active ? ` ${styles.filterChipPriorityActive}` : ''}`}
                    style={active ? { background: color, borderColor: color, color: '#fff' } : { borderColor: color, color }}
                    onClick={() => togglePriorityFilter(value)}
                    title={active ? `Remove "${label}" filter` : `Filter by "${label}" priority`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          {hasChipFilters && (
            <button
              className={styles.filterChipClear}
              onClick={() => { setSelectedTagIds(new Set()); setSelectedAssigneeIds(new Set()); setSelectedDueDateFilters(new Set()); setSelectedPriorityFilters(new Set()); }}
            >
              <X size={11} /> Clear filters
            </button>
          )}
        </div>
      )}

      <div className={styles.board}>
        {sortedColumns.map((col) => {
          const colCards = cardsByColumn.get(col.id) || [];
          return (
            <Column
              key={col.id}
              column={col}
              cards={colCards}
              agents={agents}
              allColumns={sortedColumns}
              isCollapsed={collapsedCols.has(col.id)}
              onToggleCollapse={() => toggleColumnCollapsed(col.id)}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDrop={handleDrop}
              onAddCard={() => setShowAddCard(col.id)}
              onQuickAddCard={handleQuickAddCard}
              onBulkAddCards={handleBulkAddCards}
              onUpdateColumn={handleUpdateColumn}
              onDeleteColumn={handleDeleteColumn}
              onDeleteCard={handleDeleteCard}
              onMoveCard={handleMoveCard}
              onDuplicateCard={handleDuplicateCard}
              onToggleComplete={handleToggleComplete}
              onSetDueDate={handleSetDueDate}
              onSetPriority={handleSetPriority}
              onCardClick={setQuickViewCardId}
              sortOption={columnSorts[col.id] || 'position'}
              onSortChange={setColumnSort}
              onColumnDragStart={handleColumnDragStart}
              onColumnDragEnd={handleColumnDragEnd}
              onColumnDragOver={handleColumnDragOver}
              onColumnDragLeave={handleColumnDragLeave}
              onColumnDrop={handleColumnDrop}
              isColumnDropTarget={columnDropTarget === col.id}
            />
          );
        })}
        <AddColumnButton onAdd={handleAddColumn} />
      </div>

      {(isFiltering || hasChipFilters) && visibleCardCount === 0 && (
        <div className={styles.filterNoResults}>
          <SearchX size={32} strokeWidth={1.5} />
          <span className={styles.filterNoResultsTitle}>
            {isFiltering ? <>No cards match &ldquo;{filterText}&rdquo;</> : 'No cards match the selected filters'}
          </span>
          <button
            className={styles.filterNoResultsClear}
            onClick={() => { setFilterText(''); setSelectedTagIds(new Set()); setSelectedAssigneeIds(new Set()); setSelectedDueDateFilters(new Set()); filterInputRef.current?.focus(); }}
          >
            Clear all filters
          </button>
        </div>
      )}

      {showAddCard && (
        <CreateCardModal
          onClose={() => setShowAddCard(null)}
          onSubmit={handleAddCard}
        />
      )}

      {showCronPanel && (
        <BoardCronTemplatesPanel
          boardId={board.id}
          columns={sortedColumns}
          onClose={() => setShowCronPanel(false)}
        />
      )}

      {showBatchRunPanel && (
        <BoardBatchRunPanel
          boardId={board.id}
          columns={sortedColumns}
          onClose={() => setShowBatchRunPanel(false)}
        />
      )}

      {quickViewCardId && (
        <CardQuickView
          cardId={quickViewCardId}
          boardId={board?.id}
          boardName={board?.name}
          onClose={() => setQuickViewCardId(null)}
          onCardUpdated={handleCardUpdated}
          cardIds={visibleCardIds}
          onNavigate={setQuickViewCardId}
        />
      )}
    </div>
  );
}

interface ColumnProps {
  column: BoardColumn;
  cards: BoardCardEntry[];
  agents: AgentEntry[];
  allColumns: BoardColumn[];
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onDragStart: (e: React.DragEvent, bc: BoardCardEntry) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, columnId: string) => void;
  onAddCard: () => void;
  onQuickAddCard: (columnId: string, name: string) => Promise<void>;
  onBulkAddCards: (columnId: string, names: string[]) => Promise<void>;
  onUpdateColumn: (columnId: string, data: Record<string, unknown>) => void;
  onDeleteColumn: (columnId: string) => void;
  onDeleteCard: (cardId: string, cardName: string) => void;
  onMoveCard: (cardId: string, targetColumnId: string) => void;
  onDuplicateCard: (cardId: string, columnId: string) => void;
  onToggleComplete: (cardId: string, currentCompleted: boolean) => void;
  onSetDueDate: (cardId: string, dueDate: string | null) => void;
  onSetPriority: (cardId: string, priority: Priority | null) => void;
  onCardClick: (cardId: string) => void;
  sortOption: ColumnSortOption;
  onSortChange: (columnId: string, sort: ColumnSortOption) => void;
  onColumnDragStart: (e: React.DragEvent, col: BoardColumn) => void;
  onColumnDragEnd: (e: React.DragEvent) => void;
  onColumnDragOver: (e: React.DragEvent, columnId: string) => void;
  onColumnDragLeave: (e: React.DragEvent) => void;
  onColumnDrop: (e: React.DragEvent, columnId: string) => void;
  isColumnDropTarget: boolean;
}

function Column({ column, cards, agents, allColumns, isCollapsed, onToggleCollapse, onDragStart, onDragEnd, onDrop, onAddCard, onQuickAddCard, onBulkAddCards, onUpdateColumn, onDeleteColumn, onDeleteCard, onMoveCard, onDuplicateCard, onToggleComplete, onSetDueDate, onSetPriority, onCardClick, sortOption, onSortChange, onColumnDragStart, onColumnDragEnd, onColumnDragOver, onColumnDragLeave, onColumnDrop, isColumnDropTarget }: ColumnProps) {
  const navigate = useNavigate();
  const [isDragOver, setIsDragOver] = useState(false);
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(column.name);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; cardId: string; cardName: string; showMoveMenu?: boolean } | null>(null);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const [showWipInput, setShowWipInput] = useState(false);
  const [wipInputValue, setWipInputValue] = useState('');
  const wipInputRef = useRef<HTMLInputElement>(null);
  const wipWrapRef = useRef<HTMLDivElement>(null);
  const [inlineAdd, setInlineAdd] = useState(false);
  const [inlineName, setInlineName] = useState('');
  const [inlineSubmitting, setInlineSubmitting] = useState(false);
  const inlineInputRef = useRef<HTMLTextAreaElement>(null);
  const [pastedLines, setPastedLines] = useState<string[] | null>(null);
  const cardListRef = useRef<HTMLDivElement>(null);
  const agentMenuRef = useRef<HTMLDivElement>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!showAgentMenu) return;
    function onClickOutside(e: MouseEvent) {
      if (agentMenuRef.current && !agentMenuRef.current.contains(e.target as Node)) {
        setShowAgentMenu(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [showAgentMenu]);

  useEffect(() => {
    if (!showColorPicker) return;
    function onClickOutside(e: MouseEvent) {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setShowColorPicker(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [showColorPicker]);

  useEffect(() => {
    if (!contextMenu) return;
    function onClickOutside(e: MouseEvent) {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [contextMenu]);

  useEffect(() => {
    if (!showSortMenu) return;
    function onClickOutside(e: MouseEvent) {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
        setShowSortMenu(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [showSortMenu]);

  useEffect(() => {
    if (!showWipInput) return;
    function onClickOutside(e: MouseEvent) {
      if (wipWrapRef.current && !wipWrapRef.current.contains(e.target as Node)) {
        setShowWipInput(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [showWipInput]);

  useEffect(() => {
    if (showWipInput && wipInputRef.current) {
      wipInputRef.current.focus();
      wipInputRef.current.select();
    }
  }, [showWipInput]);

  const displayCards = useMemo(() => sortCards(cards, sortOption), [cards, sortOption]);

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  useEffect(() => {
    if (inlineAdd && inlineInputRef.current) {
      inlineInputRef.current.focus();
    }
  }, [inlineAdd]);

  async function handleInlineSubmit() {
    const trimmed = inlineName.trim();
    if (!trimmed || inlineSubmitting) return;
    setInlineSubmitting(true);
    try {
      await onQuickAddCard(column.id, trimmed);
      setInlineName('');
      setPastedLines(null);
      // Keep inline input open for rapid consecutive creation
      inlineInputRef.current?.focus();
    } finally {
      setInlineSubmitting(false);
    }
  }

  function handleInlinePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const text = e.clipboardData.getData('text/plain');
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1) {
      setPastedLines(lines);
    }
  }

  async function handleBulkSubmit() {
    if (!pastedLines || pastedLines.length === 0 || inlineSubmitting) return;
    setInlineSubmitting(true);
    try {
      await onBulkAddCards(column.id, pastedLines);
      setInlineName('');
      setPastedLines(null);
      inlineInputRef.current?.focus();
    } finally {
      setInlineSubmitting(false);
    }
  }

  function dismissPastedLines() {
    setPastedLines(null);
  }

  const assignedAgent = agents.find((a) => a.id === column.assignAgentId);

  function handleDragOver(e: React.DragEvent) {
    // Ignore column drags — only handle card drags in the card list
    if (e.dataTransfer.types.includes('application/x-column-id')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    if (e.dataTransfer.types.includes('application/x-column-id')) return;
    e.preventDefault();
    setIsDragOver(false);
    onDrop(e, column.id);
  }

  function commitRename() {
    const trimmed = renameValue.trim();
    setIsRenaming(false);
    if (trimmed && trimmed !== column.name) {
      onUpdateColumn(column.id, { name: trimmed });
    } else {
      setRenameValue(column.name);
    }
  }

  function commitWipLimit() {
    setShowWipInput(false);
    const trimmed = wipInputValue.trim();
    if (trimmed === '') {
      // Clear the WIP limit
      onUpdateColumn(column.id, { wipLimit: null });
    } else {
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num !== column.wipLimit) {
        onUpdateColumn(column.id, { wipLimit: num });
      }
    }
  }

  if (isCollapsed) {
    return (
      <div
        className={`${styles.columnCollapsed}${isDragOver ? ` ${styles.columnCollapsedDragOver}` : ''}${isColumnDropTarget ? ` ${styles.columnDropTarget}` : ''}`}
        onClick={onToggleCollapse}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (e.dataTransfer.types.includes('application/x-column-id')) {
            onColumnDragOver(e, column.id);
          } else {
            setIsDragOver(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setIsDragOver(false);
            onColumnDragLeave(e);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragOver(false);
          if (e.dataTransfer.types.includes('application/x-column-id')) {
            onColumnDrop(e, column.id);
          } else {
            onDrop(e, column.id);
          }
        }}
        title={`${column.name} (${cards.length}${column.wipLimit != null ? `/${column.wipLimit}` : ''}) — click to expand`}
      >
        <div className={styles.collapsedInner}>
          <span className={styles.collapsedColor} style={{ background: column.color }} />
          <span className={styles.collapsedCount}>{cards.length}</span>
          <span className={styles.collapsedName}>{column.name}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${styles.column}${isColumnDropTarget ? ` ${styles.columnDropTarget}` : ''}`}
      onDragOver={(e) => {
        // Only handle column drags (check for the column MIME type)
        if (e.dataTransfer.types.includes('application/x-column-id')) {
          onColumnDragOver(e, column.id);
        }
      }}
      onDragLeave={(e) => {
        if (e.dataTransfer.types.includes('application/x-column-id')) {
          onColumnDragLeave(e);
        }
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes('application/x-column-id')) {
          onColumnDrop(e, column.id);
        }
      }}
    >
      <div
        className={styles.columnHeader}
        draggable
        onDragStart={(e) => onColumnDragStart(e, column)}
        onDragEnd={onColumnDragEnd}
      >
        <div className={styles.columnDragHandle} title="Drag to reorder">
          <GripVertical size={14} />
        </div>
        <div className={styles.colorPickerWrap} ref={colorPickerRef}>
          <button
            className={styles.colorDot}
            style={{ background: column.color }}
            onClick={() => setShowColorPicker(!showColorPicker)}
            title="Change color"
          />
          {showColorPicker && (
            <div className={styles.colorPickerDropdown}>
              {COLUMN_COLORS.map((c) => (
                <button
                  key={c}
                  className={[styles.colorSwatch, c === column.color ? styles.colorSwatchActive : ''].filter(Boolean).join(' ')}
                  style={{ background: c }}
                  onClick={() => {
                    onUpdateColumn(column.id, { color: c });
                    setShowColorPicker(false);
                  }}
                />
              ))}
            </div>
          )}
        </div>
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className={styles.renameInput}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                setRenameValue(column.name);
                setIsRenaming(false);
              }
            }}
          />
        ) : (
          <span
            className={styles.columnName}
            onDoubleClick={() => {
              setRenameValue(column.name);
              setIsRenaming(true);
            }}
            title="Double-click to rename"
          >
            {column.name}
          </span>
        )}
        <div className={styles.wipWrap} ref={wipWrapRef}>
          <button
            className={[
              styles.cardCount,
              column.wipLimit != null && cards.length >= column.wipLimit ? styles.cardCountOverLimit : '',
              column.wipLimit != null && cards.length === column.wipLimit - 1 ? styles.cardCountNearLimit : '',
            ].filter(Boolean).join(' ')}
            onClick={() => {
              setWipInputValue(column.wipLimit != null ? String(column.wipLimit) : '');
              setShowWipInput(true);
            }}
            title={column.wipLimit != null
              ? `${cards.length}/${column.wipLimit} cards — click to change WIP limit`
              : 'Click to set WIP limit'}
          >
            {column.wipLimit != null ? `${cards.length}/${column.wipLimit}` : cards.length}
          </button>
          {showWipInput && (
            <div className={styles.wipPopover}>
              <div className={styles.wipPopoverLabel}>WIP limit</div>
              <input
                ref={wipInputRef}
                className={styles.wipPopoverInput}
                type="number"
                min="1"
                max="999"
                placeholder="No limit"
                value={wipInputValue}
                onChange={(e) => setWipInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitWipLimit();
                  if (e.key === 'Escape') setShowWipInput(false);
                }}
              />
              <div className={styles.wipPopoverHint}>Leave blank to remove limit</div>
              <div className={styles.wipPopoverActions}>
                <button className={styles.wipPopoverSave} onClick={commitWipLimit}>Set</button>
                {column.wipLimit != null && (
                  <button
                    className={styles.wipPopoverClear}
                    onClick={() => {
                      setWipInputValue('');
                      onUpdateColumn(column.id, { wipLimit: null });
                      setShowWipInput(false);
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        <div className={styles.columnHeaderActions}>
          <button
            className={styles.headerAddBtn}
            onClick={() => {
              setInlineAdd(true);
              // Scroll card list to bottom so the inline input is visible
              requestAnimationFrame(() => {
                cardListRef.current?.scrollTo({ top: cardListRef.current.scrollHeight, behavior: 'smooth' });
              });
            }}
            title="Add card"
          >
            <Plus size={13} />
          </button>
          <div className={styles.automationWrap} ref={agentMenuRef}>
            <button
              className={[styles.automationBtn, assignedAgent ? styles.automationActive : ''].filter(Boolean).join(' ')}
              onClick={() => setShowAgentMenu(!showAgentMenu)}
              title={assignedAgent ? `Auto-assign: ${assignedAgent.name}` : 'Set auto-assign agent'}
            >
              {assignedAgent ? (
                <AgentAvatar icon={assignedAgent.avatarIcon} bgColor={assignedAgent.avatarBgColor} logoColor={assignedAgent.avatarLogoColor} size={16} />
              ) : (
                <Bot size={13} />
              )}
            </button>
            {showAgentMenu && (
              <div className={styles.automationMenu}>
                <div className={styles.automationMenuTitle}>Auto-assign agent</div>
                {agents.length === 0 && (
                  <div className={styles.automationMenuItem} style={{ color: 'var(--color-text-tertiary)' }}>
                    No active agents
                  </div>
                )}
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    className={[styles.automationMenuItem, column.assignAgentId === agent.id ? styles.automationMenuItemActive : ''].filter(Boolean).join(' ')}
                    onClick={() => {
                      onUpdateColumn(column.id, { assignAgentId: agent.id });
                      setShowAgentMenu(false);
                    }}
                  >
                    <AgentAvatar icon={agent.avatarIcon} bgColor={agent.avatarBgColor} logoColor={agent.avatarLogoColor} size={16} />
                    {agent.name}
                  </button>
                ))}
                {column.assignAgentId && (
                  <>
                    <div className={styles.automationDivider} />
                    <button
                      className={styles.automationMenuItem}
                      onClick={() => {
                        onUpdateColumn(column.id, { assignAgentId: null });
                        setShowAgentMenu(false);
                      }}
                    >
                      Clear automation
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <div className={styles.automationWrap} ref={sortMenuRef}>
            <button
              className={[styles.automationBtn, sortOption !== 'position' ? styles.automationActive : ''].filter(Boolean).join(' ')}
              onClick={() => setShowSortMenu(!showSortMenu)}
              title={sortOption === 'position' ? 'Sort cards' : `Sorted: ${SORT_LABELS[sortOption]}`}
            >
              <ArrowUpDown size={13} />
            </button>
            {showSortMenu && (
              <div className={styles.automationMenu}>
                <div className={styles.automationMenuTitle}>Sort cards</div>
                {(Object.entries(SORT_LABELS) as [ColumnSortOption, string][]).map(([key, label]) => (
                  <button
                    key={key}
                    className={[styles.automationMenuItem, sortOption === key ? styles.automationMenuItemActive : ''].filter(Boolean).join(' ')}
                    onClick={() => {
                      onSortChange(column.id, key);
                      setShowSortMenu(false);
                    }}
                  >
                    {label}
                    {sortOption === key && <Check size={12} style={{ marginLeft: 'auto' }} />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className={styles.collapseBtn}
            onClick={onToggleCollapse}
            title="Collapse column"
          >
            <ChevronsLeft size={13} />
          </button>
          <button
            className={styles.deleteColumnBtn}
            onClick={() => onDeleteColumn(column.id)}
            title="Delete column"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      <div
        ref={cardListRef}
        className={[
          styles.cardList,
          isDragOver
            ? (column.wipLimit != null && cards.length >= column.wipLimit ? styles.dragOverFull : styles.dragOver)
            : '',
        ].filter(Boolean).join(' ')}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {displayCards.length === 0 ? (
          <div className={styles.emptyColumn}>
            <Plus size={20} strokeWidth={1.5} />
            <span>No cards yet</span>
            <span className={styles.emptyColumnHint}>Drop a card here or click + below</span>
          </div>
        ) : (
          displayCards.map((bc) => {
            const isCompleted = bc.card?.customFields?.completed === true;
            return (
            <div
              key={bc.id}
              className={`${styles.card}${isCompleted ? ` ${styles.cardCompleted}` : ''}`}
              draggable
              onDragStart={(e) => onDragStart(e, bc)}
              onDragEnd={onDragEnd}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) {
                  window.open(`/cards/${bc.cardId}`, '_blank');
                } else {
                  onCardClick(bc.cardId);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, cardId: bc.cardId, cardName: bc.card?.name ?? 'Unknown card' });
              }}
            >
              {(!!(bc.card?.tags?.length) || !!(bc.card?.customFields?.priority)) && (
                <div className={styles.cardTags}>
                  {!!(bc.card?.customFields?.priority) && (
                    <PriorityBadge
                      priority={bc.card.customFields.priority as Priority}
                      size="sm"
                    />
                  )}
                  {bc.card?.tags?.slice(0, 3).map((tag: CardTag) => (
                    <span
                      key={tag.id}
                      className={styles.cardTag}
                      style={{ background: tag.color }}
                      title={tag.name}
                    >
                      {tag.name}
                    </span>
                  ))}
                  {(bc.card?.tags?.length ?? 0) > 3 && (
                    <span className={styles.cardTagMore}>+{(bc.card?.tags?.length ?? 0) - 3}</span>
                  )}
                </div>
              )}
              <div className={styles.cardTitleRow}>
                <button
                  className={`${styles.completeBtn}${isCompleted ? ` ${styles.completeBtnDone}` : ''}`}
                  onClick={(e) => { e.stopPropagation(); onToggleComplete(bc.cardId, isCompleted); }}
                  title={isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
                  aria-label={isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
                >
                  {isCompleted ? <CircleCheck size={14} /> : <Circle size={14} />}
                </button>
                <div className={`${styles.cardTitle}${isCompleted ? ` ${styles.cardTitleCompleted}` : ''}`}>{bc.card?.name ?? 'Unknown card'}</div>
              </div>
              {bc.card?.description && (
                <div className={styles.cardDesc}>{stripMarkdown(bc.card.description)}</div>
              )}
              {(() => {
                const cl = bc.card?.customFields?.checklist as { id: string; text: string; done: boolean }[] | undefined;
                if (!cl || cl.length === 0) return null;
                const done = cl.filter((i) => i.done).length;
                const pct = Math.round((done / cl.length) * 100);
                return (
                  <div className={styles.cardChecklist}>
                    <div className={styles.cardChecklistBar}>
                      <div
                        className={`${styles.cardChecklistFill}${pct === 100 ? ` ${styles.cardChecklistComplete}` : ''}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className={`${styles.cardChecklistLabel}${pct === 100 ? ` ${styles.cardChecklistLabelComplete}` : ''}`}>
                      <ListChecks size={10} />
                      {done}/{cl.length}
                    </span>
                  </div>
                );
              })()}
              {(() => {
                const dueDate = bc.card?.customFields?.dueDate as string | undefined;
                const assignee = bc.card?.assignee;
                if (!dueDate && !assignee) return null;
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const due = dueDate ? new Date(dueDate) : null;
                const isOverdue = due && due < today;
                const isSoon = due && !isOverdue && (due.getTime() - today.getTime()) <= 3 * 24 * 60 * 60 * 1000;
                const dueDateLabel = due
                  ? due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                  : null;
                return (
                  <div className={styles.cardFooter}>
                    {dueDate && (
                      <span className={`${styles.cardDueDate}${isOverdue ? ` ${styles.cardDueDateOverdue}` : isSoon ? ` ${styles.cardDueDateSoon}` : ''}`}>
                        <CalendarDays size={10} />
                        {dueDateLabel}
                      </span>
                    )}
                    {assignee && (
                      <div className={styles.cardAssignee}>
                        <span className={styles.cardAssigneeName}>
                          {assignee.firstName} {assignee.lastName}
                        </span>
                        {assignee.type === 'agent' ? (
                          <AgentAvatar
                            icon={assignee.avatarIcon || 'spark'}
                            bgColor={assignee.avatarBgColor || '#1a1a2e'}
                            logoColor={assignee.avatarLogoColor || '#e94560'}
                            size={22}
                          />
                        ) : (
                          <div className={styles.cardAvatar} title={`${assignee.firstName} ${assignee.lastName}`}>
                            {assignee.firstName[0]}{assignee.lastName[0]}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          );})
        )}
      </div>

      {/* Column summary stats */}
      {(() => {
        if (displayCards.length === 0) return null;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        let overdueCount = 0;
        let highPriorityCount = 0;
        let completedCount = 0;
        for (const bc of displayCards) {
          const cf = bc.card?.customFields;
          if (cf?.completed === true) { completedCount++; continue; }
          const dueDate = cf?.dueDate as string | undefined;
          if (dueDate && new Date(dueDate) < today) overdueCount++;
          if (cf?.priority === 'high') highPriorityCount++;
        }
        if (overdueCount === 0 && highPriorityCount === 0 && completedCount === 0) return null;
        return (
          <div className={styles.columnSummary}>
            {overdueCount > 0 && (
              <span className={styles.columnSummaryOverdue} title={`${overdueCount} overdue card${overdueCount !== 1 ? 's' : ''}`}>
                <AlertCircle size={10} />
                {overdueCount} overdue
              </span>
            )}
            {highPriorityCount > 0 && (
              <span className={styles.columnSummaryHigh} title={`${highPriorityCount} high priority card${highPriorityCount !== 1 ? 's' : ''}`}>
                <Flag size={10} />
                {highPriorityCount} high
              </span>
            )}
            {completedCount > 0 && (
              <span className={styles.columnSummaryDone} title={`${completedCount} completed card${completedCount !== 1 ? 's' : ''}`}>
                <CircleCheck size={10} />
                {completedCount}/{displayCards.length}
              </span>
            )}
          </div>
        );
      })()}

      {inlineAdd ? (
        <div className={styles.inlineAddCard}>
          <textarea
            ref={inlineInputRef}
            className={styles.inlineAddInput}
            placeholder="Card name..."
            value={inlineName}
            onChange={(e) => {
              setInlineName(e.target.value);
              // Clear multi-paste banner if user edits to single line
              if (pastedLines && e.target.value.split('\n').filter((l) => l.trim()).length <= 1) {
                setPastedLines(null);
              }
            }}
            onPaste={handleInlinePaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleInlineSubmit();
              }
              if (e.key === 'Escape') {
                setInlineName('');
                setPastedLines(null);
                setInlineAdd(false);
              }
            }}
            rows={2}
            disabled={inlineSubmitting}
          />
          {pastedLines && pastedLines.length > 1 && (
            <div className={styles.bulkPasteBanner}>
              <span className={styles.bulkPasteText}>
                <Layers size={12} />
                {pastedLines.length} lines detected
              </span>
              <button
                className={styles.bulkPasteBtn}
                onClick={() => void handleBulkSubmit()}
                disabled={inlineSubmitting}
              >
                {inlineSubmitting ? 'Creating...' : `Create ${pastedLines.length} cards`}
              </button>
              <button
                className={styles.bulkPasteDismiss}
                onClick={dismissPastedLines}
                title="Dismiss"
              >
                <X size={12} />
              </button>
            </div>
          )}
          <div className={styles.inlineAddActions}>
            <button
              className={styles.inlineAddSubmit}
              onClick={() => void handleInlineSubmit()}
              disabled={!inlineName.trim() || inlineSubmitting}
            >
              {inlineSubmitting ? 'Adding...' : 'Add'}
            </button>
            <button
              className={styles.inlineAddMore}
              onClick={() => {
                setInlineAdd(false);
                setInlineName('');
                setPastedLines(null);
                onAddCard();
              }}
              title="More options"
            >
              <SlidersHorizontal size={13} />
            </button>
            <button
              className={styles.inlineAddCancel}
              onClick={() => { setInlineName(''); setPastedLines(null); setInlineAdd(false); }}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      ) : (
        <button className={styles.addCardBtn} onClick={() => setInlineAdd(true)}>
          <Plus size={14} />
          Add card
        </button>
      )}

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className={styles.cardContextMenu}
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            className={styles.cardContextMenuItemNeutral}
            onClick={() => {
              navigate(`/cards/${contextMenu.cardId}`);
              setContextMenu(null);
            }}
          >
            <ArrowRight size={13} />
            Open card
          </button>
          <button
            className={styles.cardContextMenuItemNeutral}
            onClick={() => {
              window.open(`/cards/${contextMenu.cardId}`, '_blank');
              setContextMenu(null);
            }}
          >
            <ExternalLink size={13} />
            Open in new tab
          </button>
          <button
            className={styles.cardContextMenuItemNeutral}
            onClick={() => {
              const url = `${window.location.origin}/cards/${contextMenu.cardId}`;
              navigator.clipboard.writeText(url).then(() => {
                toast.success('Link copied to clipboard');
              }).catch(() => {
                toast.error('Failed to copy link');
              });
              setContextMenu(null);
            }}
          >
            <Copy size={13} />
            Copy link
          </button>
          <button
            className={styles.cardContextMenuItemNeutral}
            onClick={() => {
              onDuplicateCard(contextMenu.cardId, column.id);
              setContextMenu(null);
            }}
          >
            <CopyPlus size={13} />
            Duplicate
          </button>
          <button
            className={styles.cardContextMenuItemNeutral}
            onClick={() => {
              const bc = cards.find((c) => c.cardId === contextMenu.cardId);
              const isComp = bc?.card?.customFields?.completed === true;
              onToggleComplete(contextMenu.cardId, isComp);
              setContextMenu(null);
            }}
          >
            {cards.find((c) => c.cardId === contextMenu.cardId)?.card?.customFields?.completed === true
              ? <><Circle size={13} /> Mark incomplete</>
              : <><CircleCheck size={13} /> Mark complete</>
            }
          </button>
          <div className={styles.cardContextMenuDivider} />
          <div className={styles.cardContextMenuLabel}>
            <CalendarDays size={12} />
            Due date
          </div>
          <div className={styles.contextMenuDueDateRow}>
            <input
              type="date"
              className={styles.contextMenuDueDateInput}
              value={(cards.find((c) => c.cardId === contextMenu.cardId)?.card?.customFields?.dueDate as string) ?? ''}
              onChange={(e) => {
                onSetDueDate(contextMenu.cardId, e.target.value || null);
              }}
              onClick={(e) => e.stopPropagation()}
            />
            {!!(cards.find((c) => c.cardId === contextMenu.cardId)?.card?.customFields?.dueDate) && (
              <button
                className={styles.contextMenuDueDateClear}
                onClick={() => {
                  onSetDueDate(contextMenu.cardId, null);
                }}
                title="Clear due date"
              >
                <X size={12} />
              </button>
            )}
          </div>
          <div className={styles.contextMenuQuickDates}>
            <QuickDateButtons
              currentValue={(cards.find((c) => c.cardId === contextMenu.cardId)?.card?.customFields?.dueDate as string) ?? undefined}
              onSelect={(value) => onSetDueDate(contextMenu.cardId, value)}
            />
          </div>
          <div className={styles.cardContextMenuDivider} />
          <div className={styles.cardContextMenuLabel}>
            <Flag size={12} />
            Priority
          </div>
          <div className={styles.contextMenuPriorityRow}>
            {([
              { value: null, label: 'None', color: 'var(--color-text-tertiary)' },
              { value: 'high' as Priority, label: 'High', color: '#EF4444' },
              { value: 'medium' as Priority, label: 'Medium', color: '#F59E0B' },
              { value: 'low' as Priority, label: 'Low', color: '#60A5FA' },
            ]).map(({ value, label, color }) => {
              const current = cards.find((c) => c.cardId === contextMenu!.cardId)?.card?.customFields?.priority;
              const isActive = (value === null && !current) || current === value;
              return (
                <button
                  key={label}
                  className={`${styles.priorityChip}${isActive ? ` ${styles.priorityChipActive}` : ''}`}
                  style={{ '--chip-color': color } as React.CSSProperties}
                  onClick={() => { onSetPriority(contextMenu!.cardId, value); setContextMenu(null); }}
                  title={label}
                >
                  <span className={styles.priorityChipDot} />
                  {label}
                </button>
              );
            })}
          </div>
          {allColumns.length > 1 && (
            <>
              <div className={styles.cardContextMenuDivider} />
              <div className={styles.cardContextMenuLabel}>
                <MoveRight size={12} />
                Move to
              </div>
              {allColumns
                .filter((col) => col.id !== column.id)
                .map((col) => (
                  <button
                    key={col.id}
                    className={styles.cardContextMenuItemNeutral}
                    onClick={() => {
                      onMoveCard(contextMenu.cardId, col.id);
                      setContextMenu(null);
                    }}
                  >
                    <span className={styles.contextMenuDot} style={{ background: col.color }} />
                    {col.name}
                  </button>
                ))}
            </>
          )}
          <div className={styles.cardContextMenuDivider} />
          <button
            className={styles.cardContextMenuItem}
            onClick={() => {
              onDeleteCard(contextMenu.cardId, contextMenu.cardName);
              setContextMenu(null);
            }}
          >
            <Trash2 size={13} />
            Delete card
          </button>
        </div>
      )}
    </div>
  );
}

function AddColumnButton({ onAdd }: { onAdd: (name: string, color: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLUMN_COLORS[0]);

  function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onAdd(trimmed, color);
    setName('');
    setColor(COLUMN_COLORS[0]);
    setOpen(false);
  }

  if (!open) {
    return (
      <button className={styles.addColumnBtn} onClick={() => setOpen(true)}>
        <Plus size={18} />
        Add Column
      </button>
    );
  }

  return (
    <div className={styles.addColumnForm}>
      <div className={styles.addColumnFormTitle}>New Column</div>
      <input
        className={styles.input}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Column name"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleCreate();
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      <div className={styles.addColumnColorRow}>
        {COLUMN_COLORS.map((c) => (
          <button
            key={c}
            className={[styles.colorSwatch, c === color ? styles.colorSwatchActive : ''].filter(Boolean).join(' ')}
            style={{ background: c }}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      <div className={styles.addColumnActions}>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        <Button onClick={handleCreate} disabled={!name.trim()}>Create</Button>
      </div>
    </div>
  );
}
