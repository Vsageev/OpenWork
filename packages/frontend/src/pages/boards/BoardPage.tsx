import { memo, useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { Plus, Trash2, Bot, FolderOpen, ChevronDown, Check, Clock, Search, X, ExternalLink, ArrowRight, MoveRight, Copy, CopyPlus, SearchX, ChevronsLeft, ChevronsRight, SlidersHorizontal, Star, Tag, Users, ArrowUpDown, GripVertical, RefreshCw, MoreHorizontal, Layers, User, AlignLeft } from 'lucide-react';
import { AnchoredOverlay, Button, EntitySwitcher, CreateCardModal, Modal } from '../../ui';
import { AgentAvatar } from '../../components/AgentAvatar';
import { ActiveBatchRunsBanner } from '../../components/ActiveBatchRunsBanner';

import { useAuth } from '../../stores/useAuth';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../stores/toast';
import { useConfirm } from '../../hooks/useConfirm';
import { clearPreferredBoardId, setPreferredBoardId } from '../../lib/navigation-preferences';
import { addRecentVisit } from '../../lib/recent-visits';
import { stripMarkdown } from '../../lib/file-utils';
import { fetchProcessingCardAgents } from '../../lib/agent-batch';
import { useWorkspace } from '../../stores/WorkspaceContext';
import { BoardCronTemplatesPanel } from './BoardCronTemplatesPanel';
import { BoardBatchRunPanel } from './BoardBatchRunPanel';
import { CardQuickView } from './CardQuickView';
import { CardContextMenu } from './CardContextMenu';
import type { TagEntry as ContextMenuTagEntry } from './CardContextMenu';
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

interface UserEntry {
  id: string;
  firstName: string;
  lastName: string;
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
}

function getFilterState(boardId: string): SavedFilterState {
  try {
    const raw = localStorage.getItem(`board-filters-${boardId}`);
    if (raw) return JSON.parse(raw) as SavedFilterState;
  } catch { /* ignore */ }
  return { text: '', tagIds: [], assigneeIds: [] };
}

function saveFilterState(boardId: string, state: SavedFilterState) {
  try {
    if (!state.text && !state.tagIds.length && !state.assigneeIds.length) {
      localStorage.removeItem(`board-filters-${boardId}`);
    } else {
      localStorage.setItem(`board-filters-${boardId}`, JSON.stringify(state));
    }
  } catch { /* ignore */ }
}

type ColumnSortOption = 'position' | 'name-asc' | 'name-desc' | 'newest' | 'oldest';

const SORT_LABELS: Record<ColumnSortOption, string> = {
  'position': 'Manual order',
  'name-asc': 'Name A\u2013Z',
  'name-desc': 'Name Z\u2013A',
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
  const [clearingBoardCards, setClearingBoardCards] = useState(false);
  const [showBoardActions, setShowBoardActions] = useState(false);
  const boardActionsRef = useRef<HTMLDivElement>(null);
  const boardActionsOverlayRef = useRef<HTMLDivElement>(null);
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [collections, setCollections] = useState<{ id: string; name: string }[]>([]);
  const [showCollectionPicker, setShowCollectionPicker] = useState(false);
  const collectionPickerOverlayRef = useRef<HTMLDivElement>(null);
  const [showCronPanel, setShowCronPanel] = useState(false);
  const [showBatchRunPanel, setShowBatchRunPanel] = useState(false);
  const [filterText, setFilterText] = useState(() => id ? getFilterState(id).text : '');
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(() => {
    if (!id) return new Set();
    return new Set(getFilterState(id).tagIds);
  });
  const [selectedAssigneeIds, setSelectedAssigneeIds] = useState<Set<string>>(() => {
    if (!id) return new Set();
    return new Set(getFilterState(id).assigneeIds);
  });
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

  /* ── Create New Board ── */
  const [showCreateBoard, setShowCreateBoard] = useState(false);
  const [newBoardName, setNewBoardName] = useState('');
  const [newBoardDesc, setNewBoardDesc] = useState('');
  const [creatingBoard, setCreatingBoard] = useState(false);

  async function handleCreateBoard() {
    if (!newBoardName.trim()) return;
    setCreatingBoard(true);
    try {
      const created = await api<{ id: string }>('/boards', {
        method: 'POST',
        body: JSON.stringify({
          name: newBoardName.trim(),
          description: newBoardDesc.trim() || null,
          columns: [
            { name: 'To Do', color: '#6B7280', position: 0 },
            { name: 'In Progress', color: '#3B82F6', position: 1 },
            { name: 'Done', color: '#10B981', position: 2 },
          ],
        }),
      });
      setShowCreateBoard(false);
      setNewBoardName('');
      setNewBoardDesc('');
      toast.success('Board created');
      navigate(`/boards/${created.id}`);
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
    } finally {
      setCreatingBoard(false);
    }
  }

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

  // Processing cards: cardId → agentId for cards currently processed by batch runs
  const [processingCards, setProcessingCards] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const map = await fetchProcessingCardAgents(
          `/boards/${id}/batch-runs`,
          (runId) => `/boards/${id}/batch-runs/${runId}/items`,
        );
        if (!cancelled) setProcessingCards(map);
      } catch { /* ignore */ }
    };
    void poll();
    const interval = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [id]);

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

  const [boardUsers, setBoardUsers] = useState<UserEntry[]>([]);
  const [boardTags, setBoardTags] = useState<CardTag[]>([]);

  useEffect(() => {
    api<{ entries: AgentEntry[] }>('/agents?limit=100')
      .then((res) => setAgents(res.entries.filter((a) => a.status === 'active')))
      .catch(() => {});
    api<{ entries: { id: string; name: string }[] }>('/collections?limit=100')
      .then((res) => setCollections(res.entries))
      .catch(() => {});
    api<{ entries: UserEntry[] }>('/users')
      .then((res) => setBoardUsers(res.entries))
      .catch(() => {});
    api<{ entries: CardTag[] }>('/tags')
      .then((res) => setBoardTags(res.entries))
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
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist filter state to localStorage whenever filters change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!id) return;
    saveFilterState(id, {
      text: filterText,
      tagIds: [...selectedTagIds],
      assigneeIds: [...selectedAssigneeIds],
    });
  }, [filterText, selectedTagIds, selectedAssigneeIds]);

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
      const arr = map.get(bc.columnId);
      if (arr) arr.push(bc);
      else map.set(bc.columnId, [bc]);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.position - b.position);
    }
    return map;
  }, [board, filterText, selectedTagIds, selectedAssigneeIds]);

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
  const hasChipFilters = selectedTagIds.size > 0 || selectedAssigneeIds.size > 0;

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

  // Reset filter and load collapsed state when switching boards
  useEffect(() => {
    setFilterText('');
    setSelectedTagIds(new Set());
    setSelectedAssigneeIds(new Set());
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

  const handleDragStart = useCallback((e: React.DragEvent, boardCard: BoardCardEntry) => {
    dragCardRef.current = boardCard;
    isDraggingRef.current = true;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', boardCard.cardId);
    requestAnimationFrame(() => {
      (e.currentTarget as HTMLElement).classList.add(styles.dragging);
    });
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    dragCardRef.current = null;
    isDraggingRef.current = false;
    (e.currentTarget as HTMLElement).classList.remove(styles.dragging);
  }, []);

  const handleColumnDragStart = useCallback((e: React.DragEvent, col: BoardColumn) => {
    dragColumnRef.current = col;
    isDraggingRef.current = true;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-column-id', col.id);
    requestAnimationFrame(() => {
      (e.currentTarget as HTMLElement).classList.add(styles.columnDragging);
    });
  }, []);

  const handleColumnDragEnd = useCallback((e: React.DragEvent) => {
    dragColumnRef.current = null;
    isDraggingRef.current = false;
    setColumnDropTarget(null);
    (e.currentTarget as HTMLElement).classList.remove(styles.columnDragging);
  }, []);

  const handleColumnDragOver = useCallback((e: React.DragEvent, targetColumnId: string) => {
    if (!dragColumnRef.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setColumnDropTarget(targetColumnId);
  }, []);

  const handleColumnDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setColumnDropTarget(null);
    }
  }, []);

  const handleColumnDrop = useCallback(async (e: React.DragEvent, targetColumnId: string) => {
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
      void fetchBoard();
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to reorder columns');
    }
  }, [board, fetchBoard]);

  const handleDrop = useCallback(async (e: React.DragEvent, targetColumnId: string) => {
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
              void fetchBoard();
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
  }, [board, confirm, fetchBoard]);

  const handleQuickAddCard = useCallback(async (columnId: string, name: string, extra?: { description?: string | null; assigneeId?: string | null; tagIds?: string[] }) => {
    if (!board) return;
    try {
      const card = await api<CardData>('/cards', {
        method: 'POST',
        body: JSON.stringify({
          collectionId: board.defaultCollectionId,
          name,
          description: extra?.description || null,
          assigneeId: extra?.assigneeId || null,
        }),
      });
      await api(`/boards/${board.id}/cards`, {
        method: 'POST',
        body: JSON.stringify({ cardId: card.id, columnId }),
      });
      // Attach tags in parallel
      if (extra?.tagIds?.length) {
        await Promise.all(
          extra.tagIds.map((tagId) =>
            api(`/cards/${card.id}/tags`, { method: 'POST', body: JSON.stringify({ tagId }) }),
          ),
        );
      }
      void fetchBoard();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to create card');
    }
  }, [board, fetchBoard]);

  async function handleAddCard(data: { name: string; description: string | null; assigneeId: string | null; tagIds: string[]; linkedCardIds: string[] }) {
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

  const handleBulkAddCards = useCallback(async (columnId: string, names: string[]) => {
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
    void fetchBoard();
    if (created === names.length) {
      toast.success(`Created ${created} card${created !== 1 ? 's' : ''}`);
    } else {
      toast.warning(`Created ${created} of ${names.length} cards`);
    }
  }, [board, fetchBoard]);

  const handleUpdateColumn = useCallback(async (columnId: string, data: Record<string, unknown>) => {
    if (!board) return;
    try {
      await api(`/boards/${board.id}/columns/${columnId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
      void fetchBoard();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }, [board, fetchBoard]);

  const handleAddColumn = useCallback(async (name: string, color: string) => {
    if (!board) return;
    const maxPos = board.columns.reduce((max, c) => Math.max(max, c.position), 0);
    try {
      await api(`/boards/${board.id}/columns`, {
        method: 'POST',
        body: JSON.stringify({ name, color, position: maxPos + 1 }),
      });
      void fetchBoard();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }, [board, fetchBoard]);

  const handleMoveCard = useCallback(async (cardId: string, targetColumnId: string) => {
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
              void fetchBoard();
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
  }, [board, confirm, fetchBoard]);

  const handleCardUpdated = useCallback((cardId: string, updates: { name?: string; description?: string | null; assigneeId?: string | null; assignee?: CardAssignee | null; customFields?: Record<string, unknown> }) => {
    if (!board) return;
    setBoard({
      ...board,
      cards: board.cards.map((c) =>
        c.cardId === cardId && c.card
          ? { ...c, card: { ...c.card, ...updates } }
          : c,
      ),
    });
  }, [board]);

  const handleDeleteCard = useCallback((cardId: string, cardName: string) => {
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
  }, [board]);

  const handleDuplicateCard = useCallback(async (cardId: string, columnId: string) => {
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
      void fetchBoard();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to duplicate card');
    }
  }, [board, fetchBoard]);

  const handleDeleteColumn = useCallback(async (columnId: string) => {
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
      void fetchBoard();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }, [board, cardsByColumn, confirm, fetchBoard]);

  useEffect(() => {
    if (!showCollectionPicker) return;
    function onClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !collectionPickerRef.current?.contains(target) &&
        !collectionPickerOverlayRef.current?.contains(target)
      ) {
        setShowCollectionPicker(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [showCollectionPicker]);

  useEffect(() => {
    if (!showBoardActions) return;
    function onClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !boardActionsRef.current?.contains(target) &&
        !boardActionsOverlayRef.current?.contains(target)
      ) {
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

  async function handleClearBoardCards() {
    if (!board) return;
    const confirmed = await confirm({
      title: 'Clear board cards',
      message: `Remove all ${board.cards.length} card(s) from "${board.name}"?`,
      confirmLabel: 'Clear cards',
      variant: 'danger',
    });
    if (!confirmed) return;

    setClearingBoardCards(true);
    try {
      await api(`/boards/${board.id}/cards`, { method: 'DELETE' });
      if (quickViewCardId && board.cards.some((bc) => bc.cardId === quickViewCardId)) {
        setQuickViewCardId(null);
      }
      await fetchBoard();
      toast.success('Board cards cleared');
      setShowBoardActions(false);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('Failed to clear board cards');
    } finally {
      setClearingBoardCards(false);
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
          onCreateNew={() => setShowCreateBoard(true)}
          createLabel="New Board"
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
              placeholder="Filter cards..."
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
              <AnchoredOverlay
                ref={collectionPickerOverlayRef}
                anchorRef={collectionPickerRef}
                className={styles.collectionPickerMenu}
                matchAnchorWidth
              >
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
              </AnchoredOverlay>
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
            {isFiltering || hasChipFilters
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
                <AnchoredOverlay
                  ref={boardActionsOverlayRef}
                  anchorRef={boardActionsRef}
                  className={styles.boardActionsMenu}
                  placement="bottom-end"
                >
                  <button
                    className={styles.boardActionsMenuItem}
                    onClick={() => { setShowBoardActions(false); void handleClearBoardCards(); }}
                    disabled={board.cards.length === 0 || clearingBoardCards}
                  >
                    <Trash2 size={14} />
                    {clearingBoardCards ? 'Clearing cards...' : 'Clear cards'}
                  </button>
                  <button
                    className={styles.boardActionsMenuItem}
                    onClick={() => { setShowBoardActions(false); void handleDeleteBoard(); }}
                    disabled={deletingBoard}
                  >
                    <Trash2 size={14} />
                    {deletingBoard ? 'Deleting...' : 'Delete board'}
                  </button>
                </AnchoredOverlay>
              )}
            </div>
          )}
        </div>
      </div>

      {error && <div className={styles.alert}>{error}</div>}

      {id && (
        <ActiveBatchRunsBanner
          listEndpoint={`/boards/${id}/batch-runs`}
          cancelEndpointPrefix={`/boards/${id}/batch-runs`}
          itemsEndpoint={(runId) => `/boards/${id}/batch-runs/${runId}/items`}
        />
      )}

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
          {hasChipFilters && (
            <button
              className={styles.filterChipClear}
              onClick={() => { setSelectedTagIds(new Set()); setSelectedAssigneeIds(new Set()); }}
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
              users={boardUsers}
              tags={boardTags}
              processingCards={processingCards}
              currentUserId={user?.id ?? null}
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
            onClick={() => { setFilterText(''); setSelectedTagIds(new Set()); setSelectedAssigneeIds(new Set()); filterInputRef.current?.focus(); }}
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

      {showCreateBoard && (
        <Modal onClose={() => setShowCreateBoard(false)} size="sm" ariaLabel="New Board">
          <div className={styles.createModal}>
            <div className={styles.createModalTitle}>New Board</div>
            <div className={styles.createModalField}>
              <label className={styles.createModalLabel}>Name</label>
              <input
                className={styles.createModalInput}
                value={newBoardName}
                onChange={(e) => setNewBoardName(e.target.value)}
                placeholder="Board name"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleCreateBoard()}
              />
            </div>
            <div className={styles.createModalField}>
              <label className={styles.createModalLabel}>Description (optional)</label>
              <input
                className={styles.createModalInput}
                value={newBoardDesc}
                onChange={(e) => setNewBoardDesc(e.target.value)}
                placeholder="Brief description"
              />
            </div>
            <div className={styles.createModalActions}>
              <Button variant="ghost" onClick={() => setShowCreateBoard(false)}>Cancel</Button>
              <Button onClick={handleCreateBoard} disabled={creatingBoard || !newBoardName.trim()}>
                {creatingBoard ? 'Creating...' : 'Create'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

interface ColumnProps {
  column: BoardColumn;
  cards: BoardCardEntry[];
  agents: AgentEntry[];
  users: UserEntry[];
  tags: CardTag[];
  processingCards: Map<string, string>;
  currentUserId: string | null;
  allColumns: BoardColumn[];
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onDragStart: (e: React.DragEvent, bc: BoardCardEntry) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, columnId: string) => void;
  onAddCard: () => void;
  onQuickAddCard: (columnId: string, name: string, extra?: { description?: string | null; assigneeId?: string | null; tagIds?: string[] }) => Promise<void>;
  onBulkAddCards: (columnId: string, names: string[]) => Promise<void>;
  onUpdateColumn: (columnId: string, data: Record<string, unknown>) => void;
  onDeleteColumn: (columnId: string) => void;
  onDeleteCard: (cardId: string, cardName: string) => void;
  onMoveCard: (cardId: string, targetColumnId: string) => void;
  onDuplicateCard: (cardId: string, columnId: string) => void;
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

const Column = memo(function Column({ column, cards, agents, users, tags, processingCards, currentUserId, allColumns, isCollapsed, onToggleCollapse, onDragStart, onDragEnd, onDrop, onAddCard, onQuickAddCard, onBulkAddCards, onUpdateColumn, onDeleteColumn, onDeleteCard, onMoveCard, onDuplicateCard, onCardClick, sortOption, onSortChange, onColumnDragStart, onColumnDragEnd, onColumnDragOver, onColumnDragLeave, onColumnDrop, isColumnDropTarget }: ColumnProps) {
  const navigate = useNavigate();
  const [isDragOver, setIsDragOver] = useState(false);
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(column.name);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const colorPickerOverlayRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; cardId: string; columnId: string; cardName: string; cardAssignee?: CardAssignee | null; cardTags?: CardTag[] } | null>(null);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const sortMenuOverlayRef = useRef<HTMLDivElement>(null);
  const [showWipInput, setShowWipInput] = useState(false);
  const [wipInputValue, setWipInputValue] = useState('');
  const wipInputRef = useRef<HTMLInputElement>(null);
  const wipWrapRef = useRef<HTMLDivElement>(null);
  const wipOverlayRef = useRef<HTMLDivElement>(null);
  const [inlineAdd, setInlineAdd] = useState(false);
  const [inlineName, setInlineName] = useState('');
  const [inlineDesc, setInlineDesc] = useState('');
  const [inlineShowDesc, setInlineShowDesc] = useState(false);
  const [inlineAssigneeId, setInlineAssigneeId] = useState<string | null>(null);
  const [inlineSelectedTagIds, setInlineSelectedTagIds] = useState<Set<string>>(new Set());
  const [inlineShowAssigneeMenu, setInlineShowAssigneeMenu] = useState(false);
  const [inlineSubmitting, setInlineSubmitting] = useState(false);
  const inlineInputRef = useRef<HTMLTextAreaElement>(null);
  const inlineAssigneeMenuRef = useRef<HTMLDivElement>(null);
  const [pastedLines, setPastedLines] = useState<string[] | null>(null);
  const cardListRef = useRef<HTMLDivElement>(null);
  const agentMenuRef = useRef<HTMLDivElement>(null);
  const agentMenuOverlayRef = useRef<HTMLDivElement>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!showAgentMenu) return;
    function onClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !agentMenuRef.current?.contains(target) &&
        !agentMenuOverlayRef.current?.contains(target)
      ) {
        setShowAgentMenu(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [showAgentMenu]);

  useEffect(() => {
    if (!showColorPicker) return;
    function onClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !colorPickerRef.current?.contains(target) &&
        !colorPickerOverlayRef.current?.contains(target)
      ) {
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
      const target = e.target as Node;
      if (
        !sortMenuRef.current?.contains(target) &&
        !sortMenuOverlayRef.current?.contains(target)
      ) {
        setShowSortMenu(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [showSortMenu]);

  useEffect(() => {
    if (!showWipInput) return;
    function onClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !wipWrapRef.current?.contains(target) &&
        !wipOverlayRef.current?.contains(target)
      ) {
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
    if (inlineAdd && currentUserId && users.some((u) => u.id === currentUserId)) {
      setInlineAssigneeId(currentUserId);
    }
  }, [inlineAdd]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!inlineShowAssigneeMenu) return;
    function onClickOutside(e: MouseEvent) {
      if (inlineAssigneeMenuRef.current && !inlineAssigneeMenuRef.current.contains(e.target as Node)) {
        setInlineShowAssigneeMenu(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [inlineShowAssigneeMenu]);

  async function handleInlineSubmit() {
    const trimmed = inlineName.trim();
    if (!trimmed || inlineSubmitting) return;
    setInlineSubmitting(true);
    try {
      await onQuickAddCard(column.id, trimmed, {
        description: inlineDesc.trim() || null,
        assigneeId: inlineAssigneeId,
        tagIds: Array.from(inlineSelectedTagIds),
      });
      setInlineName('');
      setInlineDesc('');
      setInlineShowDesc(false);
      setInlineSelectedTagIds(new Set());
      setPastedLines(null);
      // Keep inline input open for rapid consecutive creation, keep assignee for batch flow
      inlineInputRef.current?.focus();
    } finally {
      setInlineSubmitting(false);
    }
  }

  function resetInlineForm() {
    setInlineName('');
    setInlineDesc('');
    setInlineShowDesc(false);
    setInlineAssigneeId(null);
    setInlineSelectedTagIds(new Set());
    setInlineShowAssigneeMenu(false);
    setPastedLines(null);
    setInlineAdd(false);
  }

  const inlineAssigneeUser = users.find((u) => u.id === inlineAssigneeId);
  const inlineAssigneeAgent = agents.find((a) => a.id === inlineAssigneeId);

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
            <AnchoredOverlay
              ref={colorPickerOverlayRef}
              anchorRef={colorPickerRef}
              className={styles.colorPickerDropdown}
            >
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
            </AnchoredOverlay>
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
            <AnchoredOverlay
              ref={wipOverlayRef}
              anchorRef={wipWrapRef}
              className={styles.wipPopover}
              placement="bottom-end"
            >
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
            </AnchoredOverlay>
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
              <AnchoredOverlay
                ref={agentMenuOverlayRef}
                anchorRef={agentMenuRef}
                className={styles.automationMenu}
                placement="bottom-end"
              >
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
              </AnchoredOverlay>
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
              <AnchoredOverlay
                ref={sortMenuOverlayRef}
                anchorRef={sortMenuRef}
                className={styles.automationMenu}
                placement="bottom-end"
              >
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
              </AnchoredOverlay>
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
            const processingAgentId = processingCards.get(bc.cardId);
            const processingAgent = processingAgentId ? agents.find((a) => a.id === processingAgentId) : null;
            return (
            <div
              key={bc.id}
              className={`${styles.card}${processingAgentId ? ` ${styles.cardProcessing}` : ''}`}
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
                setContextMenu({
                  x: e.clientX,
                  y: e.clientY,
                  cardId: bc.cardId,
                  columnId: column.id,
                  cardName: bc.card?.name ?? 'Unknown card',
                  cardAssignee: bc.card?.assignee ?? null,
                  cardTags: bc.card?.tags ?? [],
                });
              }}
            >
              {processingAgentId && (
                <div className={styles.cardProcessingBadge}>
                  {processingAgent && (
                    <AgentAvatar
                      icon={processingAgent.avatarIcon || 'spark'}
                      bgColor={processingAgent.avatarBgColor || '#1a1a2e'}
                      logoColor={processingAgent.avatarLogoColor || '#e94560'}
                      size={16}
                    />
                  )}
                  <span className={styles.batchLabel}>Batch run</span>
                  {processingAgent && <><span className={styles.batchSep}>·</span><span>{processingAgent.name}</span></>}
                </div>
              )}
              {!!(bc.card?.tags?.length) && (
                <div className={styles.cardTags}>
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
                <div className={styles.cardTitle}>{bc.card?.name ?? 'Unknown card'}</div>
              </div>
              {bc.card?.description && (
                <div className={styles.cardDesc}>{stripMarkdown(bc.card.description)}</div>
              )}
              {(() => {
                const assignee = bc.card?.assignee;
                if (!assignee) return null;
                return (
                  <div className={styles.cardFooter}>
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
                  </div>
                );
              })()}
            </div>
          ); })
        )}
      </div>

      {inlineAdd ? (
        <div className={styles.inlineAddCard}>
          <textarea
            ref={inlineInputRef}
            className={styles.inlineAddInput}
            placeholder="Card name..."
            value={inlineName}
            onChange={(e) => {
              setInlineName(e.target.value);
              if (pastedLines && e.target.value.split('\n').filter((l) => l.trim()).length <= 1) {
                setPastedLines(null);
              }
            }}
            onPaste={handleInlinePaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void handleInlineSubmit();
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                void handleInlineSubmit();
              }
              if (e.key === 'Escape') {
                resetInlineForm();
              }
            }}
            rows={1}
            disabled={inlineSubmitting}
          />

          {inlineShowDesc && (
            <textarea
              className={styles.inlineDescInput}
              placeholder="Description (optional)"
              value={inlineDesc}
              onChange={(e) => setInlineDesc(e.target.value)}
              rows={2}
              disabled={inlineSubmitting}
            />
          )}

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

          {/* Toolbar row: assignee, tags, description toggle */}
          <div className={styles.inlineToolbar}>
            {/* Assignee picker */}
            <div className={styles.inlineAssigneeWrap} ref={inlineAssigneeMenuRef}>
              <button
                type="button"
                className={`${styles.inlineToolbarBtn}${inlineAssigneeId ? ` ${styles.inlineToolbarBtnActive}` : ''}`}
                onClick={() => setInlineShowAssigneeMenu(!inlineShowAssigneeMenu)}
                title="Assign"
              >
                {inlineAssigneeAgent ? (
                  <AgentAvatar
                    icon={inlineAssigneeAgent.avatarIcon || 'spark'}
                    bgColor={inlineAssigneeAgent.avatarBgColor || '#1a1a2e'}
                    logoColor={inlineAssigneeAgent.avatarLogoColor || '#e94560'}
                    size={16}
                  />
                ) : inlineAssigneeUser ? (
                  <span className={styles.inlineAssigneeAvatar}>
                    {inlineAssigneeUser.firstName[0]}{inlineAssigneeUser.lastName[0]}
                  </span>
                ) : (
                  <User size={14} />
                )}
              </button>
              {inlineShowAssigneeMenu && (
                <div className={styles.inlineAssigneeDropdown}>
                  {inlineAssigneeId && (
                    <button
                      className={styles.inlineAssigneeOption}
                      onClick={() => { setInlineAssigneeId(null); setInlineShowAssigneeMenu(false); }}
                    >
                      <X size={12} /> Unassign
                    </button>
                  )}
                  {agents.length > 0 && (
                    <>
                      <div className={styles.inlineAssigneeDivider}>Agents</div>
                      {agents.map((a) => (
                        <button
                          key={a.id}
                          className={`${styles.inlineAssigneeOption}${inlineAssigneeId === a.id ? ` ${styles.inlineAssigneeOptionActive}` : ''}`}
                          onClick={() => { setInlineAssigneeId(a.id); setInlineShowAssigneeMenu(false); }}
                        >
                          <AgentAvatar
                            icon={a.avatarIcon || 'spark'}
                            bgColor={a.avatarBgColor || '#1a1a2e'}
                            logoColor={a.avatarLogoColor || '#e94560'}
                            size={18}
                          />
                          <span className={styles.inlineAssigneeName}>{a.name}</span>
                          {inlineAssigneeId === a.id && <Check size={12} className={styles.inlineAssigneeCheck} />}
                        </button>
                      ))}
                    </>
                  )}
                  {users.length > 0 && (
                    <>
                      <div className={styles.inlineAssigneeDivider}>Users</div>
                      {[
                        ...users.filter((u) => u.id === currentUserId),
                        ...users.filter((u) => u.id !== currentUserId),
                      ].map((u) => (
                        <button
                          key={u.id}
                          className={`${styles.inlineAssigneeOption}${inlineAssigneeId === u.id ? ` ${styles.inlineAssigneeOptionActive}` : ''}`}
                          onClick={() => { setInlineAssigneeId(u.id); setInlineShowAssigneeMenu(false); }}
                        >
                          <span className={styles.inlineAssigneeAvatar}>
                            {u.firstName[0]}{u.lastName[0]}
                          </span>
                          <span className={styles.inlineAssigneeName}>
                            {u.firstName} {u.lastName}
                            {u.id === currentUserId && <span className={styles.inlineAssigneeYou}>(you)</span>}
                          </span>
                          {inlineAssigneeId === u.id && <Check size={12} className={styles.inlineAssigneeCheck} />}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Description toggle */}
            <button
              type="button"
              className={`${styles.inlineToolbarBtn}${inlineShowDesc ? ` ${styles.inlineToolbarBtnActive}` : ''}`}
              onClick={() => setInlineShowDesc(!inlineShowDesc)}
              title="Add description"
            >
              <AlignLeft size={14} />
            </button>

            {/* More options (full modal) */}
            <button
              type="button"
              className={styles.inlineToolbarBtn}
              onClick={() => {
                resetInlineForm();
                onAddCard();
              }}
              title="Full editor"
            >
              <SlidersHorizontal size={13} />
            </button>

            <div className={styles.inlineToolbarSpacer} />

            <button
              className={styles.inlineAddSubmit}
              onClick={() => void handleInlineSubmit()}
              disabled={!inlineName.trim() || inlineSubmitting}
            >
              {inlineSubmitting ? 'Adding...' : 'Add'}
            </button>
            <button
              className={styles.inlineAddCancel}
              onClick={resetInlineForm}
            >
              <X size={14} />
            </button>
          </div>

          {/* Tag pills */}
          {tags.length > 0 && (
            <div className={styles.inlineTagsRow}>
              {tags.map((tag) => {
                const selected = inlineSelectedTagIds.has(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    className={`${styles.inlineTagPill}${selected ? ` ${styles.inlineTagPillSelected}` : ''}`}
                    style={{ '--tag-color': tag.color } as React.CSSProperties}
                    onClick={() => {
                      setInlineSelectedTagIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(tag.id)) next.delete(tag.id);
                        else next.add(tag.id);
                        return next;
                      });
                    }}
                  >
                    {selected && <Check size={10} />}
                    {tag.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <button className={styles.addCardBtn} onClick={() => setInlineAdd(true)}>
          <Plus size={14} />
          Add card
        </button>
      )}

      {contextMenu && (
        <CardContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          cardId={contextMenu.cardId}
          cardName={contextMenu.cardName}
          currentAssignee={contextMenu.cardAssignee}
          currentTags={contextMenu.cardTags}
          allTags={tags}
          allColumns={allColumns.map((col) => ({ id: col.id, name: col.name, color: col.color }))}
          currentColumnId={contextMenu.columnId}
          agents={agents}
          users={users as UserEntry[]}
          currentUserId={currentUserId || ''}
          onClose={() => setContextMenu(null)}
          onOpenCard={(cardId) => {
            navigate(`/cards/${cardId}`);
            setContextMenu(null);
          }}
          onMoveCard={(cardId, columnId) => {
            onMoveCard(cardId, columnId);
            setContextMenu(null);
          }}
          onDuplicateCard={(cardId, columnId) => {
            onDuplicateCard(cardId, columnId);
            setContextMenu(null);
          }}
          onDeleteCard={(cardId, cardName) => {
            onDeleteCard(cardId, cardName);
            setContextMenu(null);
          }}
          onAssignCard={async (cardId, assigneeId) => {
            try {
              await api(`/cards/${cardId}`, {
                method: 'PATCH',
                body: JSON.stringify({ assigneeId }),
              });
              const userName = users.find((u) => u.id === assigneeId);
              const agentName = agents.find((a) => a.id === assigneeId);
              const assigneeName = assigneeId ? (userName?.firstName || agentName?.name || 'Assignee') : 'Unassigned';
              toast.success(`Assigned to ${assigneeName}`);
              setContextMenu(null);
            } catch (err) {
              if (err instanceof ApiError) toast.error(err.message);
              else toast.error('Failed to update assignee');
            }
          }}
          onToggleTag={async (cardId, tagId) => {
            try {
              const tag = tags.find((t) => t.id === tagId);
              if (!tag) return;
              
              // Check if tag is already assigned by looking at the card
              const card = cards.find((c) => c.cardId === cardId);
              const hasTag = card?.card?.tags?.some((t) => t.id === tagId);
              
              if (hasTag) {
                await api(`/cards/${cardId}/tags/${tagId}`, { method: 'DELETE' });
                toast.success(`Removed tag "${tag.name}"`);
              } else {
                await api(`/cards/${cardId}/tags`, {
                  method: 'POST',
                  body: JSON.stringify({ tagId }),
                });
                toast.success(`Added tag "${tag.name}"`);
              }
              setContextMenu(null);
            } catch (err) {
              if (err instanceof ApiError) toast.error(err.message);
              else toast.error('Failed to update tags');
            }
          }}
        />
      )}
    </div>
  );
});

Column.displayName = 'Column';

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
