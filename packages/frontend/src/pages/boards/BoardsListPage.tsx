import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Kanban, Trash2, X, Star, FileText } from 'lucide-react';
import { PageHeader } from '../../layout';
import { Button } from '../../ui';
import { Modal } from '../../ui/Modal';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../stores/toast';
import { useConfirm } from '../../hooks/useConfirm';
import {
  clearPreferredBoardId,
  getPreferredBoardId,
  setPreferredBoardId,
} from '../../lib/navigation-preferences';
import { useWorkspace } from '../../stores/WorkspaceContext';
import { useFavorites } from '../../hooks/useFavorites';
import styles from './BoardsListPage.module.css';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useDebounce } from '../../hooks/useDebounce';
import { highlightMatch } from '../../components/SearchHighlight';

type SortOption = 'name-asc' | 'name-desc' | 'created-desc' | 'created-asc';
const SORT_STORAGE_KEY = 'boards-sort';

interface BoardColumn {
  id: string;
  name: string;
  color: string;
  position: number;
}

interface BoardCardEntry {
  id: string;
  columnId: string;
  card: { id: string } | null;
}

interface Board {
  id: string;
  name: string;
  description: string | null;
  isGeneral?: boolean;
  createdAt: string;
}

interface BoardDetail {
  columns: BoardColumn[];
  cards: BoardCardEntry[];
}

interface BoardsResponse {
  total: number;
  entries: Board[];
}

function isGeneralBoard(board: Board): boolean {
  if (board.isGeneral === true) return true;
  const normalizedName = board.name.trim().toLowerCase();
  return normalizedName === 'general' || normalizedName === 'general board';
}

export function BoardsListPage() {
  useDocumentTitle('Boards');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { activeWorkspaceId } = useWorkspace();
  const { isFavorite, toggleFavorite } = useFavorites();
  const [boards, setBoards] = useState<Board[]>([]);
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
  const [deletingBoardId, setDeletingBoardId] = useState<string | null>(null);
  const [boardDetails, setBoardDetails] = useState<Record<string, BoardDetail>>({});
  const debouncedSearch = useDebounce(search, 300);

  const fetchBoards = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qp = new URLSearchParams();
      if (debouncedSearch) qp.set('search', debouncedSearch);
      if (activeWorkspaceId) qp.set('workspaceId', activeWorkspaceId);
      const qs = qp.toString();
      const data = await api<BoardsResponse>(`/boards${qs ? `?${qs}` : ''}`);
      setBoards(Array.isArray(data.entries) ? data.entries : []);
    } catch (err) {
      setBoards([]);
      if (err instanceof ApiError) setError(err.message);
      else setError('Failed to load boards');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, activeWorkspaceId]);

  useEffect(() => {
    fetchBoards();
  }, [fetchBoards]);

  // Fetch column/card details for each board to show previews
  useEffect(() => {
    if (boards.length === 0) return;
    let cancelled = false;
    const fetchDetails = async () => {
      const results = await Promise.allSettled(
        boards.map((b) =>
          api<BoardDetail>(`/boards/${b.id}`).then((d) => ({ id: b.id, detail: d })),
        ),
      );
      if (cancelled) return;
      const details: Record<string, BoardDetail> = {};
      for (const r of results) {
        if (r.status === 'fulfilled') {
          details[r.value.id] = r.value.detail;
        }
      }
      setBoardDetails(details);
    };
    void fetchDetails();
    return () => { cancelled = true; };
  }, [boards]);

  const createDefaultBoard = useCallback(async () => {
    setProvisioningStarter(true);
    try {
      await api('/boards', {
        method: 'POST',
        body: JSON.stringify({
          name: 'General Board',
          description: 'Default board',
          columns: [
            { name: 'To Do', color: '#6B7280', position: 0 },
            { name: 'In Progress', color: '#3B82F6', position: 1 },
            { name: 'Done', color: '#10B981', position: 2 },
          ],
        }),
      });
      await fetchBoards();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('Failed to prepare starter board');
    } finally {
      setProvisioningStarter(false);
    }
  }, [fetchBoards]);

  useEffect(() => {
    if (activeWorkspaceId || search || loading || provisioningStarter || error || boards.length > 0) return;
    void createDefaultBoard();
  }, [activeWorkspaceId, search, loading, provisioningStarter, error, boards.length, createDefaultBoard]);

  // Auto-open create dialog when navigated with ?action=create
  useEffect(() => {
    if (searchParams.get('action') === 'create' && !loading) {
      setShowCreate(true);
    }
  }, [searchParams, loading]);

  useEffect(() => {
    const forceList = searchParams.get('list') === '1';
    const forceCreate = searchParams.get('action') === 'create';
    if (activeWorkspaceId || forceList || forceCreate || search || loading || provisioningStarter || error || boards.length === 0) return;

    const preferredBoardId = getPreferredBoardId();
    const targetBoardId =
      preferredBoardId && boards.some((board) => board.id === preferredBoardId)
        ? preferredBoardId
        : boards[0].id;

    navigate(`/boards/${targetBoardId}`, { replace: true });
  }, [activeWorkspaceId, searchParams, search, loading, provisioningStarter, error, boards, navigate]);

  async function handleCreate() {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      await api('/boards', {
        method: 'POST',
        body: JSON.stringify({
          name: createName.trim(),
          description: createDesc.trim() || null,
          columns: [
            { name: 'To Do', color: '#6B7280', position: 0 },
            { name: 'In Progress', color: '#3B82F6', position: 1 },
            { name: 'Done', color: '#10B981', position: 2 },
          ],
        }),
      });
      setShowCreate(false);
      setCreateName('');
      setCreateDesc('');
      toast.success('Board created');
      fetchBoards();
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

  const sortedBoards = useMemo(() => {
    const sorted = [...boards];
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
    }
    return sorted;
  }, [boards, sort]);

  async function handleDeleteBoard(board: Board) {
    if (isGeneralBoard(board)) return;

    const confirmed = await confirm({
      title: 'Delete board',
      message: `Delete board "${board.name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;

    setDeletingBoardId(board.id);
    try {
      await api(`/boards/${board.id}`, { method: 'DELETE' });
      setBoards((prev) => {
        const remainingBoards = prev.filter((item) => item.id !== board.id);
        if (getPreferredBoardId() === board.id) {
          if (remainingBoards.length > 0) setPreferredBoardId(remainingBoards[0].id);
          else clearPreferredBoardId();
        }
        return remainingBoards;
      });
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error(err.message);
      } else {
        toast.error('Failed to delete board');
      }
    } finally {
      setDeletingBoardId(null);
    }
  }

  return (
    <div className={styles.page}>
      {confirmDialog}
      <PageHeader
        title="Boards"
        description="Kanban boards for visual workflow"
        actions={
          <Button size="md" onClick={() => setShowCreate(true)}>
            <Plus size={16} />
            New Board
          </Button>
        }
      />

      <div className={styles.toolbar}>
        <div className={styles.searchWrapper}>
          <input
            className={styles.searchInput}
            placeholder="Search boards..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search boards"
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
            <Kanban size={48} strokeWidth={1.2} />
          </div>
          <h3 className={styles.emptyTitle}>Unable to load boards</h3>
          <p className={styles.emptyDescription}>{error}</p>
          <Button variant="ghost" onClick={fetchBoards}>Try again</Button>
        </div>
      ) : sortedBoards.length === 0 && search ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>
            <Kanban size={48} strokeWidth={1.2} />
          </div>
          <h3 className={styles.emptyTitle}>No boards found</h3>
          <p className={styles.emptyDescription}>
            No boards match &ldquo;{search}&rdquo;.
          </p>
          <Button
            variant="primary"
            size="sm"
            onClick={() => { setCreateName(search); setShowCreate(true); }}
          >
            <Plus size={14} />
            Create board &ldquo;{search}&rdquo;
          </Button>
        </div>
      ) : (
        <div className={styles.grid}>
          {sortedBoards.map((board) => {
            const detail = boardDetails[board.id];
            const columns = detail?.columns?.slice().sort((a, b) => a.position - b.position) ?? [];
            const cards = detail?.cards ?? [];
            const totalCards = cards.length;
            const columnCounts = columns.map((col) => ({
              ...col,
              count: cards.filter((c) => c.columnId === col.id).length,
            }));
            return (
            <article key={board.id} className={styles.boardCard}>
              <Link to={`/boards/${board.id}`} className={styles.boardLink}>
                <div className={styles.boardName}>{highlightMatch(board.name, debouncedSearch)}</div>
                {board.description && (
                  <div className={styles.boardDescription}>{highlightMatch(board.description, debouncedSearch)}</div>
                )}
                {columns.length > 0 && (
                  <div className={styles.columnPreview}>
                    <div className={styles.columnBars}>
                      {columnCounts.map((col) => (
                        <div
                          key={col.id}
                          className={styles.columnBar}
                          style={{
                            flex: totalCards > 0 ? Math.max(col.count, 0.15 * totalCards) : 1,
                            backgroundColor: col.color,
                          }}
                          title={`${col.name}: ${col.count} card${col.count !== 1 ? 's' : ''}`}
                        />
                      ))}
                    </div>
                    <div className={styles.columnLabels}>
                      {columnCounts.map((col) => (
                        <span key={col.id} className={styles.columnLabel} title={col.name}>
                          <span className={styles.columnDot} style={{ backgroundColor: col.color }} />
                          {col.name}
                          <span className={styles.columnCount}>{col.count}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                <div className={styles.boardMeta}>
                  {totalCards > 0 && (
                    <span className={styles.cardCountMeta}>
                      <FileText size={12} />
                      {totalCards} {totalCards === 1 ? 'card' : 'cards'}
                    </span>
                  )}
                  <span>Created {new Date(board.createdAt).toLocaleDateString()}</span>
                </div>
              </Link>
              <div className={styles.cardActions}>
                <button
                  type="button"
                  className={`${styles.favoriteButton} ${isFavorite(board.id) ? styles.favoriteButtonActive : ''}`}
                  onClick={() => toggleFavorite({ id: board.id, type: 'board', name: board.name })}
                  aria-label={isFavorite(board.id) ? 'Remove from favorites' : 'Add to favorites'}
                >
                  <Star size={14} />
                </button>
                {isGeneralBoard(board) ? (
                  <span className={styles.generalBadge}>General</span>
                ) : (
                  <button
                    type="button"
                    className={styles.deleteButton}
                    onClick={() => { void handleDeleteBoard(board); }}
                    disabled={deletingBoardId === board.id}
                    aria-label={`Delete ${board.name}`}
                  >
                    <Trash2 size={14} />
                    {deletingBoardId === board.id ? 'Deleting...' : 'Delete'}
                  </button>
                )}
              </div>
            </article>
            );
          })}
        </div>
      )}

      {showCreate && (
        <Modal onClose={() => setShowCreate(false)} size="sm" ariaLabel="New Board">
          <div className={styles.modal}>
            <div className={styles.modalTitle}>New Board</div>
            <div className={styles.field}>
              <label className={styles.label}>Name</label>
              <input
                className={styles.input}
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="Board name"
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
