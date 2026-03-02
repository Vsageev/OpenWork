import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, FolderOpen, Trash2 } from 'lucide-react';
import { PageHeader } from '../../layout';
import { Button } from '../../ui';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../stores/toast';
import { useConfirm } from '../../hooks/useConfirm';
import {
  clearPreferredCollectionId,
  getPreferredCollectionId,
  setPreferredCollectionId,
} from '../../lib/navigation-preferences';
import { useWorkspace } from '../../stores/WorkspaceContext';
import styles from './CollectionsListPage.module.css';

interface Collection {
  id: string;
  name: string;
  description: string | null;
  isGeneral?: boolean;
  createdAt: string;
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
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { activeWorkspaceId } = useWorkspace();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [provisioningStarter, setProvisioningStarter] = useState(false);
  const [deletingCollectionId, setDeletingCollectionId] = useState<string | null>(null);

  const fetchCollections = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qp = new URLSearchParams();
      if (search) qp.set('search', search);
      if (activeWorkspaceId) qp.set('workspaceId', activeWorkspaceId);
      const qs = qp.toString();
      const data = await api<CollectionsResponse>(`/collections${qs ? `?${qs}` : ''}`);
      setCollections(Array.isArray(data.entries) ? data.entries : []);
    } catch (err) {
      setCollections([]);
      if (err instanceof ApiError) setError(err.message);
      else setError('Failed to load collections');
    } finally {
      setLoading(false);
    }
  }, [search, activeWorkspaceId]);

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

  useEffect(() => {
    const forceList = searchParams.get('list') === '1';
    if (activeWorkspaceId || forceList || search || loading || provisioningStarter || error || collections.length === 0) return;

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
      fetchCollections();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
    } finally {
      setCreating(false);
    }
  }

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
        <input
          className={styles.searchInput}
          placeholder="Search collections..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading || provisioningStarter ? (
        <div className={styles.loadingState}>
          {provisioningStarter ? 'Preparing your collection...' : 'Loading collections...'}
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
      ) : collections.length === 0 && search ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>
            <FolderOpen size={48} strokeWidth={1.2} />
          </div>
          <h3 className={styles.emptyTitle}>No collections found</h3>
          <p className={styles.emptyDescription}>
            No collections match &ldquo;{search}&rdquo;. Try a different search term.
          </p>
        </div>
      ) : (
        <div className={styles.grid}>
          {collections.map((collection) => (
            <article key={collection.id} className={styles.folderCard}>
              <Link to={`/collections/${collection.id}`} className={styles.folderLink}>
                <div className={styles.folderName}>{collection.name}</div>
                {collection.description && (
                  <div className={styles.folderDescription}>{collection.description}</div>
                )}
                <div className={styles.folderMeta}>
                  Created {new Date(collection.createdAt).toLocaleDateString()}
                </div>
              </Link>
              <div className={styles.cardActions}>
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
        <div className={styles.overlay} onClick={() => setShowCreate(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
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
        </div>
      )}
    </div>
  );
}
