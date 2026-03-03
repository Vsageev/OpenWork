import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, FolderOpen, Trash2, X, Star, AlertTriangle } from 'lucide-react';
import { PageHeader } from '../../layout';
import { Button } from '../../ui';
import { Modal } from '../../ui/Modal';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../stores/toast';
import { useConfirm } from '../../hooks/useConfirm';
import {
  clearPreferredCollectionId,
  getPreferredCollectionId,
  setPreferredCollectionId,
} from '../../lib/navigation-preferences';
import { useWorkspace } from '../../stores/WorkspaceContext';
import { useFavorites } from '../../hooks/useFavorites';
import styles from './CollectionsListPage.module.css';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useDebounce } from '../../hooks/useDebounce';
import { highlightMatch } from '../../components/SearchHighlight';

type SortOption = 'name-asc' | 'name-desc' | 'created-desc' | 'created-asc' | 'progress-desc' | 'overdue-desc';
const SORT_STORAGE_KEY = 'collections-sort';

interface Collection {
  id: string;
  name: string;
  description: string | null;
  isGeneral?: boolean;
  createdAt: string;
  cardCount?: number;
  completedCardCount?: number;
  overdueCardCount?: number;
}

interface CollectionsResponse {
  total: number;
  entries: Collection[];
}

function isGeneralCollection(collection: Collection): boolean {
  if (collection.isGeneral === true) return true;
  return collection.name.trim().toLowerCase() === 'general';
}

export function CollectionsListPage() {
  useDocumentTitle('Collections');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { activeWorkspaceId } = useWorkspace();
  const { isFavorite, toggleFavorite } = useFavorites();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortOption>(
    () => (localStorage.getItem(SORT_STORAGE_KEY) as SortOption) || 'created-desc',
  );
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [provisioningStarter, setProvisioningStarter] = useState(false);
  const [deletingCollectionId, setDeletingCollectionId] = useState<string | null>(null);
  const debouncedSearch = useDebounce(search, 300);

  const fetchCollections = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qp = new URLSearchParams();
      if (debouncedSearch) qp.set('search', debouncedSearch);
      if (activeWorkspaceId) qp.set('workspaceId', activeWorkspaceId);
      qp.set('withCardCounts', 'true');
      const data = await api<CollectionsResponse>(`/collections?${qp.toString()}`);
      setCollections(Array.isArray(data.entries) ? data.entries : []);
    } catch (err) {
      setCollections([]);
      if (err instanceof ApiError) setError(err.message);
      else setError('Failed to load collections');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, activeWorkspaceId]);

  useEffect(() => {
    fetchCollections();
  }, [fetchCollections]);

  const createDefaultCollection = useCallback(async () => {
    setProvisioningStarter(true);
    try {
      await api('/collections', {
        method: 'POST',
        body: JSON.stringify({
          name: 'General',
          description: 'Default collection',
        }),
      });
      await fetchCollections();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('Failed to prepare starter collection');
    } finally {
      setProvisioningStarter(false);
    }
  }, [fetchCollections]);

  useEffect(() => {
    if (activeWorkspaceId || search || loading || provisioningStarter || error || collections.length > 0) return;
    void createDefaultCollection();
  }, [activeWorkspaceId, search, loading, provisioningStarter, error, collections.length, createDefaultCollection]);

  // Auto-open create dialog when navigated with ?action=create
  useEffect(() => {
    if (searchParams.get('action') === 'create' && !loading) {
      setShowCreate(true);
    }
  }, [searchParams, loading]);

  useEffect(() => {
    const forceList = searchParams.get('list') === '1';
    const forceCreate = searchParams.get('action') === 'create';
    if (activeWorkspaceId || forceList || forceCreate || search || loading || provisioningStarter || error || collections.length === 0) return;

    const preferredCollectionId = getPreferredCollectionId();
    const targetCollectionId =
      preferredCollectionId && collections.some((collection) => collection.id === preferredCollectionId)
        ? preferredCollectionId
        : collections[0].id;

    navigate(`/collections/${targetCollectionId}`, { replace: true });
  }, [activeWorkspaceId, searchParams, search, loading, provisioningStarter, error, collections, navigate]);

  async function handleCreate() {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      await api('/collections', {
        method: 'POST',
        body: JSON.stringify({
          name: createName.trim(),
          description: createDesc.trim() || null,
        }),
      });
      setShowCreate(false);
      setCreateName('');
      setCreateDesc('');
      toast.success('Collection created');
      fetchCollections();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
    } finally {
      setCreating(false);
    }
  }

  function handleSortChange(value: SortOption) {
    setSort(value);
    localStorage.setItem(SORT_STORAGE_KEY, value);
  }

  const sortedCollections = useMemo(() => {
    const sorted = [...collections];
    switch (sort) {
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
      case 'progress-desc':
        sorted.sort((a, b) => {
          const aPct = a.cardCount ? (a.completedCardCount ?? 0) / a.cardCount : 0;
          const bPct = b.cardCount ? (b.completedCardCount ?? 0) / b.cardCount : 0;
          return bPct - aPct;
        });
        break;
      case 'overdue-desc':
        sorted.sort((a, b) => (b.overdueCardCount ?? 0) - (a.overdueCardCount ?? 0));
        break;
    }
    return sorted;
  }, [collections, sort]);

  async function handleDeleteCollection(collection: Collection) {
    if (isGeneralCollection(collection)) return;

    const confirmed = await confirm({
      title: 'Delete collection',
      message: `Delete collection "${collection.name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;

    setDeletingCollectionId(collection.id);
    try {
      await api(`/collections/${collection.id}`, { method: 'DELETE' });
      setCollections((prev) => {
        const remainingCollections = prev.filter((item) => item.id !== collection.id);
        if (getPreferredCollectionId() === collection.id) {
          if (remainingCollections.length > 0) setPreferredCollectionId(remainingCollections[0].id);
          else clearPreferredCollectionId();
        }
        return remainingCollections;
      });
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error(err.message);
      } else {
        toast.error('Failed to delete collection');
      }
    } finally {
      setDeletingCollectionId(null);
    }
  }

  return (
    <div className={styles.page}>
      {confirmDialog}
      <PageHeader
        title="Collections"
        description="Organize your cards into collections"
        actions={
          <Button size="md" onClick={() => setShowCreate(true)}>
            <Plus size={16} />
            New Collection
          </Button>
        }
      />

      <div className={styles.toolbar}>
        <div className={styles.searchWrapper}>
          <input
            className={styles.searchInput}
            placeholder="Search collections..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search collections"
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
          <option value="created-desc">Newest first</option>
          <option value="created-asc">Oldest first</option>
          <option value="name-asc">Name A–Z</option>
          <option value="name-desc">Name Z–A</option>
          <option value="progress-desc">Most progress first</option>
          <option value="overdue-desc">Most overdue first</option>
        </select>
      </div>

      {loading || provisioningStarter ? (
        <div className={styles.loadingState}>
          <div className={styles.skeletonGrid}>
            {[0, 1, 2].map((i) => (
              <div key={i} className={styles.skeletonCard} />
            ))}
          </div>
        </div>
      ) : error ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>
            <FolderOpen size={48} strokeWidth={1.2} />
          </div>
          <h3 className={styles.emptyTitle}>Unable to load collections</h3>
          <p className={styles.emptyDescription}>{error}</p>
          <Button variant="ghost" onClick={fetchCollections}>Try again</Button>
        </div>
      ) : sortedCollections.length === 0 && search ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>
            <FolderOpen size={48} strokeWidth={1.2} />
          </div>
          <h3 className={styles.emptyTitle}>No collections found</h3>
          <p className={styles.emptyDescription}>
            No collections match &ldquo;{search}&rdquo;.
          </p>
          <Button
            variant="primary"
            size="sm"
            onClick={() => { setCreateName(search); setShowCreate(true); }}
          >
            <Plus size={14} />
            Create collection &ldquo;{search}&rdquo;
          </Button>
        </div>
      ) : (
        <div className={styles.grid}>
          {sortedCollections.map((collection) => (
            <article key={collection.id} className={styles.folderCard}>
              <Link to={`/collections/${collection.id}`} className={styles.folderLink}>
                <div className={styles.folderName}>{highlightMatch(collection.name, debouncedSearch)}</div>
                {collection.description && (
                  <div className={styles.folderDescription}>{highlightMatch(collection.description, debouncedSearch)}</div>
                )}
                <div className={styles.folderMeta}>
                  {collection.cardCount !== undefined && (
                    <span className={styles.cardCount}>
                      {collection.completedCardCount !== undefined && collection.cardCount > 0
                        ? `${collection.completedCardCount}/${collection.cardCount} done`
                        : `${collection.cardCount} ${collection.cardCount === 1 ? 'card' : 'cards'}`}
                    </span>
                  )}
                  {(collection.overdueCardCount ?? 0) > 0 && (
                    <span className={styles.overdueCount} title={`${collection.overdueCardCount} overdue card${collection.overdueCardCount === 1 ? '' : 's'}`}>
                      <AlertTriangle size={11} />
                      {collection.overdueCardCount} overdue
                    </span>
                  )}
                  <span>Created {new Date(collection.createdAt).toLocaleDateString()}</span>
                </div>
                {collection.cardCount !== undefined && collection.cardCount > 0 && collection.completedCardCount !== undefined && (
                  <div className={styles.progressBar}>
                    <div
                      className={styles.progressFill}
                      style={{ width: `${Math.round((collection.completedCardCount / collection.cardCount) * 100)}%` }}
                    />
                  </div>
                )}
              </Link>
              <div className={styles.cardActions}>
                <button
                  type="button"
                  className={`${styles.favoriteButton} ${isFavorite(collection.id) ? styles.favoriteButtonActive : ''}`}
                  onClick={() => toggleFavorite({ id: collection.id, type: 'collection', name: collection.name })}
                  aria-label={isFavorite(collection.id) ? 'Remove from favorites' : 'Add to favorites'}
                >
                  <Star size={14} />
                </button>
                {isGeneralCollection(collection) ? (
                  <span className={styles.generalBadge}>General</span>
                ) : (
                  <button
                    type="button"
                    className={styles.deleteButton}
                    onClick={() => { void handleDeleteCollection(collection); }}
                    disabled={deletingCollectionId === collection.id}
                    aria-label={`Delete ${collection.name}`}
                  >
                    <Trash2 size={14} />
                    {deletingCollectionId === collection.id ? 'Deleting...' : 'Delete'}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {showCreate && (
        <Modal onClose={() => setShowCreate(false)} size="sm" ariaLabel="New Collection">
          <div className={styles.modal}>
            <div className={styles.modalTitle}>New Collection</div>
            <div className={styles.field}>
              <label className={styles.label}>Name</label>
              <input
                className={styles.input}
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="Collection name"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Description (optional)</label>
              <input
                className={styles.input}
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                placeholder="Brief description"
              />
            </div>
            <div className={styles.modalActions}>
              <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={creating || !createName.trim()}>
                {creating ? 'Creating...' : 'Create'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
