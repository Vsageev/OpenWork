import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Plus, FileText, Trash2, User, X, Tag, CornerDownLeft, Star, Link2, ExternalLink, Users, ChevronDown, LayoutList, Table2, ChevronUp, Pencil, FolderInput, Layers, ChevronRight, Check, Bookmark, BookmarkPlus, Download, Copy, Bot } from 'lucide-react';
import { PageHeader } from '../../layout';
import { Button, EntitySwitcher, CreateCardModal, Modal } from '../../ui';
import { AgentAvatar } from '../../components/AgentAvatar';
import { api, ApiError } from '../../lib/api';
import { fetchProcessingCardAgents } from '../../lib/agent-batch';
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
import { ActiveBatchRunsBanner } from '../../components/ActiveBatchRunsBanner';
import { CollectionBatchRunPanel } from './CollectionBatchRunPanel';

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

type SortOption = 'updated-desc' | 'updated-asc' | 'name-asc' | 'name-desc' | 'created-desc' | 'created-asc';
type GroupByOption = 'none' | 'assignee';
const SORT_STORAGE_KEY = 'collection-cards-sort';
const VIEW_MODE_STORAGE_KEY = 'collection-cards-view';
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
  tagIds: string[];
  assigneeIds: string[];
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
}

function getCollectionFilterState(collectionId: string): SavedCollectionFilterState {
  try {
    const raw = localStorage.getItem(`collection-filters-${collectionId}`);
    if (raw) return JSON.parse(raw) as SavedCollectionFilterState;
  } catch { /* ignore */ }
  return { tagIds: [], assigneeIds: [] };
}

function saveCollectionFilterState(collectionId: string, state: SavedCollectionFilterState) {
  try {
    if (!state.tagIds.length && !state.assigneeIds.length) {
      localStorage.removeItem(`collection-filters-${collectionId}`);
    } else {
      localStorage.setItem(`collection-filters-${collectionId}`, JSON.stringify(state));
    }
  } catch { /* ignore */ }
}

type AssigneeFilterId = string | '__unassigned__';

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
  const [tableSortKey, setTableSortKey] = useState<'name' | 'assignee' | 'updated'>('updated');
  const [tableSortAsc, setTableSortAsc] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [deletingCollection, setDeletingCollection] = useState(false);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(() => {
    if (!id) return new Set();
    return new Set(getCollectionFilterState(id).tagIds);
  });
  const [quickAddName, setQuickAddName] = useState('');
  const [quickAddSaving, setQuickAddSaving] = useState(false);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [quickViewCardId, setQuickViewCardId] = useState<string | null>(null);
  const [selectedAssigneeIds, setSelectedAssigneeIds] = useState<Set<AssigneeFilterId>>(() => {
    if (!id) return new Set();
    return new Set(getCollectionFilterState(id).assigneeIds);
  });
  const [exporting, setExporting] = useState(false);
  const [focusedCardIndex, setFocusedCardIndex] = useState<number>(-1);
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

  /* ── Create New Collection ── */
  const [showCreateCollection, setShowCreateCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [newCollectionDesc, setNewCollectionDesc] = useState('');
  const [creatingCollection, setCreatingCollection] = useState(false);

  async function handleCreateCollection() {
    if (!newCollectionName.trim()) return;
    setCreatingCollection(true);
    try {
      const created = await api<{ id: string }>('/collections', {
        method: 'POST',
        body: JSON.stringify({
          name: newCollectionName.trim(),
          description: newCollectionDesc.trim() || null,
        }),
      });
      setShowCreateCollection(false);
      setNewCollectionName('');
      setNewCollectionDesc('');
      toast.success('Collection created');
      navigate(`/collections/${created.id}`);
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
    } finally {
      setCreatingCollection(false);
    }
  }

  /* ── Agent Batch Run state ── */
  const [showBatchPanel, setShowBatchPanel] = useState(false);
  const [processingCardAgents, setProcessingCardAgents] = useState<Map<string, string>>(new Map());
  const [agentInfoCache, setAgentInfoCache] = useState<Record<string, { name: string; avatarIcon?: string | null; avatarBgColor?: string | null; avatarLogoColor?: string | null }>>({});
  const processingCardsPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopProcessingCardPolling = useCallback(() => {
    if (processingCardsPollRef.current) {
      clearInterval(processingCardsPollRef.current);
      processingCardsPollRef.current = null;
    }
  }, []);

  const pollProcessingCards = useCallback(async (collectionId: string) => {
    try {
      const nextProcessing = await fetchProcessingCardAgents(
        `/collections/${collectionId}/agent-batch/runs`,
        (runId) => `/collections/${collectionId}/agent-batch/runs/${runId}/items`,
        200,
      );
      setProcessingCardAgents(nextProcessing);
      const agentIds = new Set(nextProcessing.values());
      setAgentInfoCache((prev) => {
        const missing = [...agentIds].filter((aid) => !prev[aid]);
        if (missing.length === 0) return prev;
        for (const agentId of missing) {
          api<{ id: string; name: string; avatarIcon?: string | null; avatarBgColor?: string | null; avatarLogoColor?: string | null }>(`/agents/${agentId}`)
            .then((agent) => setAgentInfoCache((p) => ({ ...p, [agentId]: agent })))
            .catch(() => {});
        }
        return prev;
      });
    } catch {
      // ignore polling errors for non-critical UI hints
    }
  }, []);

  useEffect(() => {
    if (!id) {
      setProcessingCardAgents(new Map());
      stopProcessingCardPolling();
      return;
    }

    void pollProcessingCards(id);
    processingCardsPollRef.current = setInterval(() => {
      void pollProcessingCards(id);
    }, 4000);

    return () => stopProcessingCardPolling();
  }, [id, pollProcessingCards, stopProcessingCardPolling]);

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
      tagIds: [...selectedTagIds],
      assigneeIds: [...selectedAssigneeIds],
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
    setSelectedTagIds(new Set(view.tagIds));
    setSelectedAssigneeIds(new Set(view.assigneeIds));
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
  }, [id]);

  // Persist filter state when filters change
  useEffect(() => {
    if (!id) return;
    saveCollectionFilterState(id, {
      tagIds: [...selectedTagIds],
      assigneeIds: [...selectedAssigneeIds],
    });
  }, [id, selectedTagIds, selectedAssigneeIds]);

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

  async function handleCreateCard(data: { name: string; description: string | null; assigneeId: string | null; tagIds: string[]; linkedCardIds: string[] }) {
    if (!id) return;
    const card = await api<{ id: string }>('/cards', {
      method: 'POST',
      body: JSON.stringify({
        collectionId: id,
        name: data.name,
        description: data.description,
        assigneeId: data.assigneeId,
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

  function handleTableSort(key: 'name' | 'assignee' | 'updated') {
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

    // Optimistically remove the card
    setCards((prev) => prev.filter((c) => c.id !== cardId));
    setTotal((prev) => prev - 1);

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
      // Build CSV
      function escapeCell(value: string): string {
        if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      }

      const headers = ['Name', 'Tags', 'Assignee', 'Description', 'Created', 'Updated'];
      const rows = allCards.map((card) => {
        const tags = card.tags.map((t) => t.name).join('; ');
        const assignee = card.assignee
          ? `${card.assignee.firstName} ${card.assignee.lastName}`.trim()
          : '';
        const description = stripMarkdown(card.description || '').replace(/\n+/g, ' ').trim();
        const created = new Date(card.createdAt).toLocaleDateString();
        const updated = new Date(card.updatedAt).toLocaleDateString();
        return [card.name, tags, assignee, description, created, updated];
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

  const hasActiveFilters = selectedTagIds.size > 0 || selectedAssigneeIds.size > 0;

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
    return filtered;
  }, [cards, sort, selectedTagIds, selectedAssigneeIds]);

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
    }

    return groups;
  }, [groupBy, sortedCards, tableSortedCards, viewMode]);

  // Reset focused index when filters/sort change
  useEffect(() => {
    setFocusedCardIndex(-1);
  }, [debouncedSearch, sort, selectedTagIds, selectedAssigneeIds]);

  // Keyboard navigation for card list
  useEffect(() => {
    if (loading || quickViewCardId || showCreate || editingCardId) return;

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
  }, [loading, quickViewCardId, showCreate, editingCardId, moveCardId, sortedCards, focusedCardIndex, navigate]);

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
        onCreateNew={() => setShowCreateCollection(true)}
        createLabel="New Collection"
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
              onClick={() => setShowBatchPanel(true)}
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

      <ActiveBatchRunsBanner
        listEndpoint={`/collections/${id}/agent-batch/runs`}
        cancelEndpointPrefix={`/collections/${id}/agent-batch/runs`}
        itemsEndpoint={(runId) => `/collections/${id}/agent-batch/runs/${runId}/items`}
      />

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
          </select>
          <select
            className={styles.sortSelect}
            value={groupBy}
            onChange={(e) => handleGroupByChange(e.target.value as GroupByOption)}
            title="Group cards by"
          >
            <option value="none">No grouping</option>
            <option value="assignee">Group by assignee</option>
          </select>
          <span className={styles.cardCount}>
            {hasActiveFilters
              ? `${sortedCards.length} of ${cards.length} card${cards.length !== 1 ? 's' : ''}`
              : total > cards.length
                ? `${cards.length} of ${total} card${total !== 1 ? 's' : ''}`
                : `${total || cards.length} card${(total || cards.length) !== 1 ? 's' : ''}`}
          </span>
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
          {hasActiveFilters && (
            <button
              className={styles.tagFilterClear}
              onClick={() => { setSelectedTagIds(new Set()); setSelectedAssigneeIds(new Set()); }}
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
                onClick={() => { setSelectedTagIds(new Set()); setSelectedAssigneeIds(new Set()); }}
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
                        <th className={styles.tableTh}>Name</th>
                        <th className={`${styles.tableTh} ${styles.tableThAssignee}`}>Assignee</th>
                        <th className={`${styles.tableTh} ${styles.tableThTags}`}>Tags</th>
                        <th className={`${styles.tableTh} ${styles.tableThUpdated}`}>Updated</th>
                        <th className={`${styles.tableTh} ${styles.tableThActions}`} />
                      </tr>
                    </thead>
                    <tbody>
                      {group.cards.map((card) => {
                        const isProcessing = processingCardAgents.has(card.id);
                        const procAgent = isProcessing ? agentInfoCache[processingCardAgents.get(card.id)!] : null;
                        return (
                          <tr
                            key={card.id}
                            className={`${styles.tableRow}${isProcessing ? ` ${styles.tableRowProcessing}` : ''}`}
                            onClick={() => setQuickViewCardId(card.id)}
                          >
                            <td className={styles.tableTdName} onClick={(e) => e.stopPropagation()}>
                              <div className={styles.tableNameCell}>
                                <div>
                                  <span className={styles.tableCardName}>{card.name}</span>
                                  {isProcessing && (
                                    <span className={styles.tableProcessingBadge}>
                                      {procAgent && (
                                        <AgentAvatar icon={procAgent.avatarIcon || 'spark'} bgColor={procAgent.avatarBgColor || '#1a1a2e'} logoColor={procAgent.avatarLogoColor || '#e94560'} size={14} />
                                      )}
                                      <span className={styles.batchLabel}>Batch run</span>
                                      {procAgent && <><span className={styles.batchSep}>·</span><span>{procAgent.name}</span></>}
                                    </span>
                                  )}
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
                const isFocused = focusedCardIndex === index;
                const isProcessing = processingCardAgents.has(card.id);
                const procAgent = isProcessing ? agentInfoCache[processingCardAgents.get(card.id)!] : null;
                return (
                  <tr
                    key={card.id}
                    className={`${styles.tableRow}${isFocused ? ` ${styles.tableRowFocused}` : ''}${isProcessing ? ` ${styles.tableRowProcessing}` : ''}`}
                    onClick={() => setQuickViewCardId(card.id)}
                  >
                    <td className={styles.tableTdName} onClick={(e) => e.stopPropagation()}>
                      <div className={styles.tableNameCell}>
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
                            <span className={styles.tableCardName}>{card.name}</span>
                          )}
                          {isProcessing && (
                            <span className={styles.tableProcessingBadge}>
                              {procAgent && (
                                <AgentAvatar icon={procAgent.avatarIcon || 'spark'} bgColor={procAgent.avatarBgColor || '#1a1a2e'} logoColor={procAgent.avatarLogoColor || '#e94560'} size={14} />
                              )}
                              <span className={styles.batchLabel}>Batch run</span>
                              {procAgent && <><span className={styles.batchSep}>·</span><span>{procAgent.name}</span></>}
                            </span>
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
                  {group.cards.map((card) => {
                    const isProcessing = processingCardAgents.has(card.id);
                    const procAgent = isProcessing ? agentInfoCache[processingCardAgents.get(card.id)!] : null;
                    return (
                      <div key={card.id} className={styles.cardItemWrapper}>
                        <div
                          className={`${styles.cardItem}${isProcessing ? ` ${styles.cardItemProcessing}` : ''}`}
                          role="button"
                          tabIndex={0}
                          onClick={() => setQuickViewCardId(card.id)}
                          onKeyDown={(e) => { if (e.key === 'Enter') setQuickViewCardId(card.id); }}
                        >
                          <div className={styles.cardBody}>
                            {isProcessing && (
                              <div className={styles.cardProcessingBadge}>
                                {procAgent && (
                                  <AgentAvatar icon={procAgent.avatarIcon || 'spark'} bgColor={procAgent.avatarBgColor || '#1a1a2e'} logoColor={procAgent.avatarLogoColor || '#e94560'} size={14} />
                                )}
                                <span className={styles.batchLabel}>Batch run</span>
                                {procAgent && <><span className={styles.batchSep}>·</span><span>{procAgent.name}</span></>}
                              </div>
                            )}
                            <div className={styles.cardNameRow}>
                              <div className={styles.cardName}>{card.name}</div>
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
            const isFocused = focusedCardIndex === index;
            const isProcessing = processingCardAgents.has(card.id);
            const procAgent = isProcessing ? agentInfoCache[processingCardAgents.get(card.id)!] : null;
            return (
              <div key={card.id} className={`${styles.cardItemWrapper}${isFocused ? ` ${styles.cardItemFocused}` : ''}`}>
                <div
                  className={`${styles.cardItem}${isProcessing ? ` ${styles.cardItemProcessing}` : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => { if (editingCardId !== card.id) setQuickViewCardId(card.id); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && editingCardId !== card.id) setQuickViewCardId(card.id); }}
                >
                  <div className={styles.cardBody}>
                    {isProcessing && (
                      <div className={styles.cardProcessingBadge}>
                        {procAgent && (
                          <AgentAvatar icon={procAgent.avatarIcon || 'spark'} bgColor={procAgent.avatarBgColor || '#1a1a2e'} logoColor={procAgent.avatarLogoColor || '#e94560'} size={14} />
                        )}
                        <span className={styles.batchLabel}>Batch run</span>
                        {procAgent && <><span className={styles.batchSep}>·</span><span>{procAgent.name}</span></>}
                      </div>
                    )}
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
                        <div className={styles.cardName}>{card.name}</div>
                      </div>
                    )}
                    {card.description && (
                      <div className={styles.cardDescription}>{stripMarkdown(card.description)}</div>
                    )}
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
            setCards((prev) =>
              prev.map((c) => (c.id === cardId ? { ...c, ...updates } : c)),
            );
          }}
          cardIds={sortedCards.map((c) => c.id)}
          onNavigate={setQuickViewCardId}
        />
      )}

      {showCreateCollection && (
        <Modal onClose={() => setShowCreateCollection(false)} size="sm" ariaLabel="New Collection">
          <div className={styles.createModal}>
            <div className={styles.createModalTitle}>New Collection</div>
            <div className={styles.createModalField}>
              <label className={styles.createModalLabel}>Name</label>
              <input
                className={styles.createModalInput}
                value={newCollectionName}
                onChange={(e) => setNewCollectionName(e.target.value)}
                placeholder="Collection name"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleCreateCollection()}
              />
            </div>
            <div className={styles.createModalField}>
              <label className={styles.createModalLabel}>Description (optional)</label>
              <input
                className={styles.createModalInput}
                value={newCollectionDesc}
                onChange={(e) => setNewCollectionDesc(e.target.value)}
                placeholder="Brief description"
              />
            </div>
            <div className={styles.createModalActions}>
              <Button variant="ghost" onClick={() => setShowCreateCollection(false)}>Cancel</Button>
              <Button onClick={handleCreateCollection} disabled={creatingCollection || !newCollectionName.trim()}>
                {creatingCollection ? 'Creating...' : 'Create'}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {showBatchPanel && id && (
        <CollectionBatchRunPanel
          collectionId={id}
          tags={allTags}
          initialConfig={collection?.agentBatchConfig}
          onClose={() => setShowBatchPanel(false)}
          onConfigSaved={(cfg) => {
            if (collection) setCollection({ ...collection, agentBatchConfig: cfg });
          }}
        />
      )}
    </div>
  );
}
