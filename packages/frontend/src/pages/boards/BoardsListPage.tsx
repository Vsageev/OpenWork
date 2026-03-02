import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Kanban, Trash2 } from 'lucide-react';
import { PageHeader } from '../../layout';
import { Button } from '../../ui';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../stores/toast';
import { useConfirm } from '../../hooks/useConfirm';
import {
  clearPreferredBoardId,
  getPreferredBoardId,
  setPreferredBoardId,
} from '../../lib/navigation-preferences';
import { useWorkspace } from '../../stores/WorkspaceContext';
import styles from './BoardsListPage.module.css';

interface Board {
  id: string;
  name: string;
  description: string | null;
  isGeneral?: boolean;
  createdAt: string;
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
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { activeWorkspaceId } = useWorkspace();
  const [boards, setBoards] = useState<Board[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [provisioningStarter, setProvisioningStarter] = useState(false);
  const [deletingBoardId, setDeletingBoardId] = useState<string | null>(null);

  const fetchBoards = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qp = new URLSearchParams();
      if (search) qp.set('search', search);
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
  }, [search, activeWorkspaceId]);

  useEffect(() => {
    fetchBoards();
  }, [fetchBoards]);

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

  useEffect(() => {
    const forceList = searchParams.get('list') === '1';
    if (activeWorkspaceId || forceList || search || loading || provisioningStarter || error || boards.length === 0) return;

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
      fetchBoards();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
    } finally {
      setCreating(false);
    }
  }

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
        <input
          className={styles.searchInput}
          placeholder="Search boards..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading || provisioningStarter ? (
        <div className={styles.loadingState}>
          {provisioningStarter ? 'Preparing your board...' : 'Loading boards...'}
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
      ) : boards.length === 0 && search ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>
            <Kanban size={48} strokeWidth={1.2} />
          </div>
          <h3 className={styles.emptyTitle}>No boards found</h3>
          <p className={styles.emptyDescription}>
            No boards match &ldquo;{search}&rdquo;. Try a different search term.
          </p>
        </div>
      ) : (
        <div className={styles.grid}>
          {boards.map((board) => (
            <article key={board.id} className={styles.boardCard}>
              <Link to={`/boards/${board.id}`} className={styles.boardLink}>
                <div className={styles.boardName}>{board.name}</div>
                {board.description && (
                  <div className={styles.boardDescription}>{board.description}</div>
                )}
                <div className={styles.boardMeta}>
                  Created {new Date(board.createdAt).toLocaleDateString()}
                </div>
              </Link>
              <div className={styles.cardActions}>
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
          ))}
        </div>
      )}

      {showCreate && (
        <div className={styles.overlay} onClick={() => setShowCreate(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
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
        </div>
      )}
    </div>
  );
}
