import { useEffect, useState, useCallback } from 'react';
import { useParams, Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Plus, FileText, Trash2, User } from 'lucide-react';
import { PageHeader } from '../../layout';
import { Button, EntitySwitcher, CreateCardModal } from '../../ui';
import { AgentAvatar } from '../../components/AgentAvatar';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../stores/toast';
import { useConfirm } from '../../hooks/useConfirm';
import { clearPreferredCollectionId, setPreferredCollectionId } from '../../lib/navigation-preferences';
import { useWorkspace } from '../../stores/WorkspaceContext';
import styles from './CollectionDetailPage.module.css';

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
  assignee: {
    id: string; firstName: string; lastName: string; type?: 'user' | 'agent';
    avatarIcon?: string | null; avatarBgColor?: string | null; avatarLogoColor?: string | null;
  } | null;
  tags: CardTag[];
  createdAt: string;
  updatedAt: string;
}

interface Collection {
  id: string;
  name: string;
  description: string | null;
  isGeneral?: boolean;
}

interface CardsResponse {
  total: number;
  entries: Card[];
}

function formatTimeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function isGeneralCollection(collection: Collection): boolean {
  if (collection.isGeneral === true) return true;
  return collection.name.trim().toLowerCase() === 'general';
}

export function CollectionDetailPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { activeWorkspace } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const [collection, setCollection] = useState<Collection | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [deletingCollection, setDeletingCollection] = useState(false);

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
    try {
      const [collectionData, cardsData] = await Promise.all([
        api<Collection>(`/collections/${id}`),
        api<CardsResponse>(
          `/collections/${id}/cards${search ? `?search=${encodeURIComponent(search)}` : ''}`,
        ),
      ]);
      setCollection(collectionData);
      setCards(cardsData.entries);
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
  }, [id, search, recoverFromMissingCollection]);

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

    setShowCreate(false);
    fetchData();
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
    return <div className={styles.loadingState}>Loading...</div>;
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
        title={collection.name}
        description={collection.description || 'Cards in this collection'}
        actions={
          <div className={styles.headerActions}>
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
            <Button size="md" onClick={() => setShowCreate(true)}>
              <Plus size={16} />
              New Card
            </Button>
          </div>
        }
      />

      <div className={styles.toolbar}>
        <input
          className={styles.searchInput}
          placeholder="Search cards..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className={styles.cardCount}>
          {cards.length} card{cards.length !== 1 ? 's' : ''}
        </span>
      </div>

      {cards.length === 0 && search ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>
            <FileText size={48} strokeWidth={1.2} />
          </div>
          <h3 className={styles.emptyTitle}>No cards found</h3>
          <p className={styles.emptyDescription}>
            No cards match &ldquo;{search}&rdquo;. Try a different search term.
          </p>
        </div>
      ) : cards.length === 0 ? (
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
      ) : (
        <div className={styles.cardsList}>
          {cards.map((card) => {
            const timeAgo = formatTimeAgo(card.updatedAt ?? card.createdAt);
            return (
              <Link key={card.id} to={`/cards/${card.id}`} className={styles.cardItem}>
                <div className={styles.cardBody}>
                  <div className={styles.cardName}>{card.name}</div>
                  {card.description && (
                    <div className={styles.cardDescription}>{card.description}</div>
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
                  <div className={styles.cardFooterRight}>
                    <span className={styles.cardMeta}>{timeAgo}</span>
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
              </Link>
            );
          })}
        </div>
      )}

      {showCreate && (
        <CreateCardModal
          onClose={() => setShowCreate(false)}
          onSubmit={handleCreateCard}
        />
      )}
    </div>
  );
}
