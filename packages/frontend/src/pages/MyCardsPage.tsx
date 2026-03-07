import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  FileText,
  Search,
  X,
  Plus,
  Tag,
  AlertTriangle,
  RotateCcw,
  FolderOpen,
  Square,
  CheckSquare,
  Minus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Layers,
  ExternalLink,
  Copy,
  MousePointer,
} from 'lucide-react';
import { PageHeader } from '../layout';
import { Button, Tooltip } from '../ui';
import { api, ApiError } from '../lib/api';
import { toast } from '../stores/toast';
import { useAuth } from '../stores/useAuth';
import { useConfirm } from '../hooks/useConfirm';
import { AgentAvatar } from '../components/AgentAvatar';
import { CardQuickView } from './boards/CardQuickView';
import { CreateCardModal } from '../ui/CreateCardModal';
import type { CreateCardData } from '../ui/CreateCardModal';
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

type SortOption =
  | 'name-asc'
  | 'name-desc'
  | 'created-newest'
  | 'created-oldest'
  | 'updated-newest'
  | 'updated-oldest'
  | 'collection';

const SORT_LABELS: Record<SortOption, string> = {
  'name-asc': 'Name (A-Z)',
  'name-desc': 'Name (Z-A)',
  'created-newest': 'Created (newest)',
  'created-oldest': 'Created (oldest)',
  'updated-newest': 'Updated (newest)',
  'updated-oldest': 'Updated (oldest)',
  collection: 'Collection',
};

const SORT_OPTIONS = Object.keys(SORT_LABELS) as SortOption[];

interface CollectionGroup {
  collectionId: string;
  collectionName: string;
  cards: CardItem[];
}

const PAGE_SIZE = 100;

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function MyCardsPage() {
  useDocumentTitle('My Cards');
  const { user } = useAuth();
  const navigate = useNavigate();
  const [cards, setCards] = useState<CardItem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [search, setSearch] = useState('');
  const [tagFilters, setTagFilters] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('my-cards-page-tag-filters');
      if (saved) return new Set(JSON.parse(saved) as string[]);
    } catch { /* ignore */ }
    return new Set();
  });
  const [sort, setSort] = useState<SortOption>(() => {
    try {
      const saved = localStorage.getItem('my-cards-page-sort');
      if (saved && SORT_OPTIONS.includes(saved as SortOption)) return saved as SortOption;
    } catch { /* ignore */ }
    return 'updated-newest';
  });
  const [groupByCollection, setGroupByCollection] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('my-cards-page-group-by-collection');
      if (saved !== null) return JSON.parse(saved) as boolean;
    } catch { /* ignore */ }
    return false;
  });
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [quickViewCardId, setQuickViewCardId] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const cardRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [collectionNames, setCollectionNames] = useState<Map<string, string>>(new Map());

  const [showCreateModal, setShowCreateModal] = useState(false);

  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [bulkActionsOpen, setBulkActionsOpen] = useState<string | null>(null);
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const bulkBarRef = useRef<HTMLDivElement>(null);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; cardId: string } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ entries: { id: string; name: string }[]; total: number }>('/collections?limit=200')
      .then((data) => {
        setCollectionNames(new Map(data.entries.map((c) => [c.id, c.name])));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    localStorage.setItem('my-cards-page-tag-filters', JSON.stringify([...tagFilters]));
  }, [tagFilters]);

  useEffect(() => {
    localStorage.setItem('my-cards-page-sort', sort);
  }, [sort]);

  useEffect(() => {
    localStorage.setItem('my-cards-page-group-by-collection', JSON.stringify(groupByCollection));
  }, [groupByCollection]);

  const fetchCards = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setFetchError(false);
    try {
      const qp = new URLSearchParams();
      qp.set('assigneeId', user.id);
      qp.set('limit', String(PAGE_SIZE));
      if (search.trim()) qp.set('search', search.trim());

      const data = await api<CardsResponse>(`/cards?${qp.toString()}`);
      setCards(data.entries);
      setTotal(data.total);
      setTotalCount(data.total);
    } catch (err) {
      setFetchError(true);
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to load cards');
    } finally {
      setLoading(false);
    }
  }, [user, search]);

  useEffect(() => {
    const id = setTimeout(() => { void fetchCards(); }, search ? 300 : 0);
    return () => clearTimeout(id);
  }, [fetchCards, search]);

  const handleCardUpdated = useCallback((
    cardId: string,
    updates: { name?: string; description?: string | null; assigneeId?: string | null; customFields?: Record<string, unknown> },
  ) => {
    setCards((prev) => prev.map((c) => c.id === cardId ? { ...c, ...updates } : c));
  }, []);

  const openQuickView = useCallback((e: React.MouseEvent, cardId: string) => {
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    setQuickViewCardId(cardId);
  }, []);

  const handleCreateCard = useCallback(async (data: CreateCardData) => {
    if (!data.collectionId) throw new Error('No collection selected.');
    const card = await api<CardItem>('/cards', {
      method: 'POST',
      body: JSON.stringify({
        collectionId: data.collectionId,
        name: data.name,
        description: data.description,
        assigneeId: data.assigneeId,
        tagIds: data.tagIds,
        linkedCardIds: data.linkedCardIds,
      }),
    });
    setCards((prev) => [card, ...prev]);
    setTotal((t) => t + 1);
    setTotalCount((t) => t + 1);
    toast.success('Card created', {
      action: { label: 'Open', onClick: () => navigate(`/cards/${card.id}`) },
    });
  }, [navigate]);

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

  useEffect(() => {
    if (!contextMenu) return;
    function handleClick(e: MouseEvent) {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    }
    function handleScroll() { setContextMenu(null); }
    document.addEventListener('mousedown', handleClick);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [contextMenu]);

  useEffect(() => {
    setSelectedCardIds(new Set());
    setSelectionMode(false);
  }, [search, tagFilters]);

  const toggleSelectCard = useCallback((cardId: string) => {
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      if (next.size === 0) setSelectionMode(false);
      return next;
    });
  }, []);

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
    setSelectionMode(false);
    setBulkProcessing(false);
  }, [selectedCardIds, bulkProcessing, confirm]);

  const activeCards = useMemo(() => {
    let filtered = cards;
    if (tagFilters.size > 0) filtered = filtered.filter((c) => c.tags?.some((t) => tagFilters.has(t.id)));

    const sorted = [...filtered];
    switch (sort) {
      case 'name-asc':
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'name-desc':
        sorted.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case 'created-newest':
        sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        break;
      case 'created-oldest':
        sorted.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        break;
      case 'updated-newest':
        sorted.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        break;
      case 'updated-oldest':
        sorted.sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
        break;
      case 'collection':
        sorted.sort((a, b) => {
          const aName = collectionNames.get(a.collectionId) ?? '';
          const bName = collectionNames.get(b.collectionId) ?? '';
          return aName.localeCompare(bName) || a.name.localeCompare(b.name);
        });
        break;
    }
    return sorted;
  }, [cards, tagFilters, sort, collectionNames]);

  const allVisibleCards = activeCards;
  const quickViewCardIds = useMemo(() => allVisibleCards.map((c) => c.id), [allVisibleCards]);

  const collectionGroups = useMemo<CollectionGroup[]>(() => {
    if (!groupByCollection) return [];
    const groupMap = new Map<string, CardItem[]>();
    for (const card of allVisibleCards) {
      const existing = groupMap.get(card.collectionId);
      if (existing) existing.push(card);
      else groupMap.set(card.collectionId, [card]);
    }
    return Array.from(groupMap.entries())
      .map(([collectionId, groupCards]) => ({
        collectionId,
        collectionName: collectionNames.get(collectionId) ?? 'Unknown collection',
        cards: groupCards,
      }))
      .sort((a, b) => a.collectionName.localeCompare(b.collectionName));
  }, [allVisibleCards, groupByCollection, collectionNames]);

  const toggleGroupCollapsed = useCallback((collectionId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(collectionId)) next.delete(collectionId);
      else next.add(collectionId);
      return next;
    });
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if (quickViewCardId) return;

      if (e.key === 'a' && (e.metaKey || e.ctrlKey) && allVisibleCards.length > 0) {
        e.preventDefault();
        if (selectionMode && selectedCardIds.size === allVisibleCards.length) {
          setSelectedCardIds(new Set());
          setSelectionMode(false);
        } else {
          setSelectionMode(true);
          setSelectedCardIds(new Set(allVisibleCards.map((c) => c.id)));
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        if (contextMenu) {
          setContextMenu(null);
        } else if (selectionMode) {
          setSelectedCardIds(new Set());
          setSelectionMode(false);
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
        e.preventDefault();
        toggleSelectCard(allVisibleCards[focusedIndex].id);
      } else if (e.key === 'Enter' && focusedIndex >= 0 && focusedIndex < allVisibleCards.length) {
        e.preventDefault();
        setQuickViewCardId(allVisibleCards[focusedIndex].id);
      } else if (e.key === 'o' && focusedIndex >= 0 && focusedIndex < allVisibleCards.length) {
        e.preventDefault();
        navigate(`/cards/${allVisibleCards[focusedIndex].id}`);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [allVisibleCards, focusedIndex, quickViewCardId, navigate, selectedCardIds, selectionMode, toggleSelectCard, contextMenu]);

  useEffect(() => {
    if (focusedIndex >= 0 && focusedIndex < allVisibleCards.length) {
      const el = cardRowRefs.current.get(allVisibleCards[focusedIndex].id);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focusedIndex, allVisibleCards]);

  useEffect(() => {
    setFocusedIndex(-1);
  }, [search, tagFilters]);

  const hasSelection = selectedCardIds.size > 0;

  const allTags = useMemo(() => {
    const map = new Map<string, CardTag>();
    for (const card of cards) {
      for (const tag of card.tags ?? []) {
        if (!map.has(tag.id)) map.set(tag.id, tag);
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [cards]);

  const handleCardContextMenu = useCallback((e: React.MouseEvent, cardId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, cardId });
  }, []);

  const enterSelectionMode = useCallback((cardId?: string) => {
    setSelectionMode(true);
    if (cardId) {
      setSelectedCardIds(new Set([cardId]));
    }
    setContextMenu(null);
  }, []);

  function renderCardRow(card: CardItem, index: number) {
    const isFocused = focusedIndex === index;
    const isSelected = selectedCardIds.has(card.id);
    return (
      <div
        key={card.id}
        className={`${styles.cardRow}${isFocused ? ` ${styles.cardRowFocused}` : ''}${isSelected ? ` ${styles.cardRowSelected}` : ''}`}
        ref={(el) => { if (el) cardRowRefs.current.set(card.id, el); else cardRowRefs.current.delete(card.id); }}
        onContextMenu={(e) => handleCardContextMenu(e, card.id)}
      >
        {selectionMode && (
          <button
            className={`${styles.selectBtn} ${styles.selectBtnVisible}`}
            onClick={() => toggleSelectCard(card.id)}
            aria-label={isSelected ? 'Deselect' : 'Select'}
            tabIndex={-1}
          >
            {isSelected ? <CheckSquare size={15} /> : <Square size={15} />}
          </button>
        )}
        <Link
          to={`/cards/${card.id}`}
          className={`${styles.cardItem}${quickViewCardId === card.id ? ` ${styles.cardItemActive}` : ''}`}
          onClick={(e) => {
            if (selectionMode) {
              e.preventDefault();
              toggleSelectCard(card.id);
            } else {
              openQuickView(e, card.id);
            }
          }}
          tabIndex={-1}
        >
          <div className={styles.cardLeft}>
            <div className={styles.cardHeader}>
              <span className={styles.cardName}>
                {highlightMatch(card.name, search)}
              </span>
              {!groupByCollection && collectionNames.get(card.collectionId) && (
                <span className={styles.cardCollection}>
                  {collectionNames.get(card.collectionId)}
                </span>
              )}
            </div>
            {card.description && (
              <div className={styles.cardDesc}>{highlightMatch(stripMarkdown(card.description), search)}</div>
            )}
          </div>
          <div className={styles.cardRight}>
            {card.tags && card.tags.length > 0 && (
              <div className={styles.cardTagsGroup}>
                {card.tags.slice(0, 2).map((tag) => (
                  <span
                    key={tag.id}
                    className={styles.cardTagPill}
                    style={{ '--tag-color': tag.color } as React.CSSProperties}
                  >
                    {tag.name}
                  </span>
                ))}
                {card.tags.length > 2 && (
                  <span className={styles.cardTagMore}>
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
            <span className={styles.cardTime}>
              {timeAgo(card.updatedAt)}
            </span>
          </div>
        </Link>
      </div>
    );
  }

  function renderGroupedCards() {
    return (
      <div className={styles.cardsList}>
        {collectionGroups.map((group) => {
          const isCollapsed = collapsedGroups.has(group.collectionId);
          return (
            <div key={group.collectionId} className={styles.group}>
              <button
                className={styles.groupHeader}
                onClick={() => toggleGroupCollapsed(group.collectionId)}
              >
                <span className={styles.groupChevron}>
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </span>
                <FolderOpen size={13} />
                <span className={styles.groupLabel}>{group.collectionName}</span>
                <span className={styles.groupCount}>{group.cards.length}</span>
              </button>
              {!isCollapsed && (
                <div className={styles.groupCards}>
                  {group.cards.map((card) => renderCardRow(card, allVisibleCards.indexOf(card)))}
                </div>
              )}
            </div>
          );
        })}
        {total > PAGE_SIZE && (
          <div className={styles.moreNote}>
            Showing {PAGE_SIZE} of {total} cards. Use search to find specific cards.
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="My Cards"
        description="Cards assigned to you across all collections"
        actions={
          <Button
            size="md"
            onClick={() => setShowCreateModal(true)}
          >
            <Plus size={16} />
            New Card
          </Button>
        }
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
            <button className={styles.searchClear} onClick={() => setSearch('')} aria-label="Clear search">
              <X size={12} />
            </button>
          )}
        </div>
        <div className={styles.toolbarRight}>
          <select
            className={styles.sortSelect}
            value={sort}
            onChange={(e) => setSort(e.target.value as SortOption)}
            aria-label="Sort cards"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>{SORT_LABELS[opt]}</option>
            ))}
          </select>
          <Tooltip label={groupByCollection ? 'Show flat list' : 'Group by collection'}>
            <button
              className={`${styles.controlBtn}${groupByCollection ? ` ${styles.controlBtnActive}` : ''}`}
              onClick={() => setGroupByCollection((v) => !v)}
              aria-label={groupByCollection ? 'Show flat list' : 'Group by collection'}
            >
              <Layers size={14} />
            </button>
          </Tooltip>
        </div>
      </div>

      {allTags.length > 0 && (
        <div className={styles.tagFiltersRow}>
          <Tag size={12} className={styles.tagFiltersIcon} />
          <div className={styles.tagScroll}>
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
                >
                  {tag.name}
                </button>
              );
            })}
          </div>
          {tagFilters.size > 0 && (
            <Tooltip label="Clear tag filters">
              <button
                className={styles.tagFiltersClear}
                onClick={() => setTagFilters(new Set())}
                aria-label="Clear tag filters"
              >
                <X size={11} />
              </button>
            </Tooltip>
          )}
        </div>
      )}

      {showCreateModal && (
        <CreateCardModal
          onClose={() => setShowCreateModal(false)}
          onSubmit={handleCreateCard}
          showCollectionPicker
          allowCreateAnother
        />
      )}

      {loading ? (
        <div className={styles.loadingState}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className={styles.skeletonRow} />
          ))}
        </div>
      ) : fetchError ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>
            <AlertTriangle size={48} strokeWidth={1.2} />
          </div>
          <div className={styles.emptyTitle}>Failed to load cards</div>
          <div className={styles.emptyDesc}>Something went wrong while fetching your cards.</div>
          <Button variant="ghost" onClick={() => void fetchCards()}>
            <RotateCcw size={14} />
            Try again
          </Button>
        </div>
      ) : allVisibleCards.length === 0 ? (
        <div className={styles.emptyState}>
          {tagFilters.size > 0 && !search ? (
            <>
              <div className={styles.emptyIcon}><Tag size={48} strokeWidth={1.2} /></div>
              <div className={styles.emptyTitle}>No cards with selected tags</div>
              <Button variant="ghost" onClick={() => setTagFilters(new Set())}>Clear tag filters</Button>
            </>
          ) : search ? (
            <>
              <div className={styles.emptyIcon}><Search size={48} strokeWidth={1.2} /></div>
              <div className={styles.emptyTitle}>No cards match &quot;{search}&quot;</div>
              <Button variant="ghost" onClick={() => setSearch('')}>Clear search</Button>
            </>
          ) : (
            <>
              <div className={styles.emptyIcon}><FileText size={48} strokeWidth={1.2} /></div>
              <div className={styles.emptyTitle}>No cards assigned to you</div>
              <div className={styles.emptyDesc}>Cards assigned to you will appear here.</div>
              <Button
                size="sm"
                onClick={() => setShowCreateModal(true)}
              >
                <Plus size={14} />
                Create your first card
              </Button>
            </>
          )}
        </div>
      ) : groupByCollection ? (
        renderGroupedCards()
      ) : (
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

      {selectedCardIds.size > 0 && (
        <div className={styles.bulkBar} ref={bulkBarRef}>
          <div className={styles.bulkBarInner}>
            <Tooltip label={selectedCardIds.size === allVisibleCards.length ? 'Deselect all' : 'Select all'}>
              <button
                className={styles.bulkSelectAll}
                onClick={() => {
                  if (selectedCardIds.size === allVisibleCards.length) {
                    setSelectedCardIds(new Set());
                  } else {
                    setSelectedCardIds(new Set(allVisibleCards.map((c) => c.id)));
                  }
                }}
                aria-label={selectedCardIds.size === allVisibleCards.length ? 'Deselect all' : 'Select all'}
              >
                {selectedCardIds.size === allVisibleCards.length
                  ? <CheckSquare size={14} />
                  : selectedCardIds.size > 0
                    ? <Minus size={14} />
                    : <Square size={14} />}
              </button>
            </Tooltip>
            <span className={styles.bulkCount}>
              {selectedCardIds.size} selected
            </span>

            <div className={styles.bulkDivider} />

            <button
              className={`${styles.bulkActionBtn} ${styles.bulkActionBtnDanger}`}
              onClick={() => void handleBulkDelete()}
              disabled={bulkProcessing}
            >
              <Trash2 size={13} />
              Delete
            </button>

            <div className={styles.bulkDivider} />

            <Tooltip label="Clear selection">
              <button
                className={styles.bulkClearBtn}
                onClick={() => { setSelectedCardIds(new Set()); setSelectionMode(false); setBulkActionsOpen(null); }}
                aria-label="Clear selection"
              >
                <X size={14} />
              </button>
            </Tooltip>
          </div>
        </div>
      )}

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className={styles.contextMenu}
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            className={styles.contextMenuItem}
            onClick={() => {
              setQuickViewCardId(contextMenu.cardId);
              setContextMenu(null);
            }}
          >
            <FileText size={14} />
            Open
          </button>
          <button
            className={styles.contextMenuItem}
            onClick={() => {
              navigate(`/cards/${contextMenu.cardId}`);
              setContextMenu(null);
            }}
          >
            <ExternalLink size={14} />
            Open full page
          </button>
          <button
            className={styles.contextMenuItem}
            onClick={() => {
              void navigator.clipboard.writeText(`${window.location.origin}/cards/${contextMenu.cardId}`);
              toast.success('Link copied');
              setContextMenu(null);
            }}
          >
            <Copy size={14} />
            Copy link
          </button>
          <div className={styles.contextMenuDivider} />
          <button
            className={styles.contextMenuItem}
            onClick={() => enterSelectionMode(contextMenu.cardId)}
          >
            <MousePointer size={14} />
            Select
          </button>
          <div className={styles.contextMenuDivider} />
          <button
            className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
            onClick={async () => {
              const cardId = contextMenu.cardId;
              setContextMenu(null);
              const ok = await confirm({
                title: 'Delete card',
                message: 'Are you sure you want to delete this card? This cannot be undone.',
                confirmLabel: 'Delete',
                variant: 'danger',
              });
              if (!ok) return;
              try {
                await api(`/cards/${cardId}`, { method: 'DELETE' });
                setCards((prev) => prev.filter((c) => c.id !== cardId));
                setTotal((t) => Math.max(0, t - 1));
                setTotalCount((t) => Math.max(0, t - 1));
                toast.success('Card deleted');
              } catch {
                toast.error('Failed to delete card');
              }
            }}
          >
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      )}

      {confirmDialog}
    </div>
  );
}
