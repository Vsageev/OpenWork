import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useParams, Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Plus, Trash2, Bot, FolderOpen, ChevronDown, Check, Clock } from 'lucide-react';
import { Button, EntitySwitcher, CreateCardModal } from '../../ui';
import { AgentAvatar } from '../../components/AgentAvatar';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../stores/toast';
import { useConfirm } from '../../hooks/useConfirm';
import { clearPreferredBoardId, setPreferredBoardId } from '../../lib/navigation-preferences';
import { useWorkspace } from '../../stores/WorkspaceContext';
import { BoardCronTemplatesPanel } from './BoardCronTemplatesPanel';
import styles from './BoardPage.module.css';

const COLUMN_COLORS = ['#6B7280', '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6'];

interface BoardColumn {
  id: string;
  boardId: string;
  name: string;
  color: string;
  position: number;
  assignAgentId: string | null;
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

export function BoardPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { activeWorkspace } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const [board, setBoard] = useState<BoardWithCards | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAddCard, setShowAddCard] = useState<string | null>(null);
  const [deletingBoard, setDeletingBoard] = useState(false);
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [collections, setCollections] = useState<{ id: string; name: string }[]>([]);
  const [showCollectionPicker, setShowCollectionPicker] = useState(false);
  const [showCronPanel, setShowCronPanel] = useState(false);
  const collectionPickerRef = useRef<HTMLDivElement>(null);
  const dragCardRef = useRef<BoardCardEntry | null>(null);

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
    for (const bc of board.cards) {
      const arr = map.get(bc.columnId);
      if (arr) arr.push(bc);
      else map.set(bc.columnId, [bc]);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.position - b.position);
    }
    return map;
  }, [board]);

  function handleDragStart(e: React.DragEvent, boardCard: BoardCardEntry) {
    dragCardRef.current = boardCard;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', boardCard.cardId);
    requestAnimationFrame(() => {
      (e.currentTarget as HTMLElement).classList.add(styles.dragging);
    });
  }

  function handleDragEnd(e: React.DragEvent) {
    dragCardRef.current = null;
    (e.currentTarget as HTMLElement).classList.remove(styles.dragging);
  }

  async function handleDrop(e: React.DragEvent, targetColumnId: string) {
    e.preventDefault();
    const bc = dragCardRef.current;
    if (!bc || !board) return;
    if (bc.columnId === targetColumnId) return;

    // Optimistic update
    const prevBoard = { ...board, cards: [...board.cards] };
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
    } catch (err) {
      setBoard(prevBoard);
      if (err instanceof ApiError) setError(err.message);
    }
  }

  async function handleAddCard(data: { name: string; description: string | null; assigneeId: string | null; tagIds: string[]; linkedCardIds: string[] }) {
    if (!showAddCard || !board) return;
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

    setShowAddCard(null);
    fetchBoard();
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

  async function handleDeleteCard(cardId: string, cardName: string) {
    if (!board) return;
    const confirmed = await confirm({
      title: 'Delete card',
      message: `Delete "${cardName}"? This will permanently delete the card and all its data.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await api(`/cards/${cardId}`, { method: 'DELETE' });
      fetchBoard();
      toast.success('Card deleted');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to delete card');
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

  if (loading) return <div className={styles.loadingState}>Loading board...</div>;
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

        <div className={styles.topBarActions}>
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
          <span className={styles.cardCountInline}>{board.cards.length} card{board.cards.length !== 1 ? 's' : ''}</span>
          {!isGeneralBoard(board) && (
            <Button variant="secondary" onClick={() => { void handleDeleteBoard(); }} disabled={deletingBoard}>
              <Trash2 size={14} />
              {deletingBoard ? 'Deleting...' : 'Delete Board'}
            </Button>
          )}
        </div>
      </div>

      {error && <div className={styles.alert}>{error}</div>}

      <div className={styles.board}>
        {sortedColumns.map((col) => {
          const colCards = cardsByColumn.get(col.id) || [];
          return (
            <Column
              key={col.id}
              column={col}
              cards={colCards}
              agents={agents}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDrop={handleDrop}
              onAddCard={() => setShowAddCard(col.id)}
              onUpdateColumn={handleUpdateColumn}
              onDeleteColumn={handleDeleteColumn}
              onDeleteCard={handleDeleteCard}
            />
          );
        })}
        <AddColumnButton onAdd={handleAddColumn} />
      </div>

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
    </div>
  );
}

interface ColumnProps {
  column: BoardColumn;
  cards: BoardCardEntry[];
  agents: AgentEntry[];
  onDragStart: (e: React.DragEvent, bc: BoardCardEntry) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, columnId: string) => void;
  onAddCard: () => void;
  onUpdateColumn: (columnId: string, data: Record<string, unknown>) => void;
  onDeleteColumn: (columnId: string) => void;
  onDeleteCard: (cardId: string, cardName: string) => void;
}

function Column({ column, cards, agents, onDragStart, onDragEnd, onDrop, onAddCard, onUpdateColumn, onDeleteColumn, onDeleteCard }: ColumnProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(column.name);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; cardId: string; cardName: string } | null>(null);
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
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  const assignedAgent = agents.find((a) => a.id === column.assignAgentId);

  function handleDragOver(e: React.DragEvent) {
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

  return (
    <div className={styles.column}>
      <div className={styles.columnHeader}>
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
        <span className={styles.cardCount}>{cards.length}</span>
        <div className={styles.columnHeaderActions}>
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
        className={[styles.cardList, isDragOver ? styles.dragOver : ''].filter(Boolean).join(' ')}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {cards.length === 0 ? (
          <div className={styles.emptyColumn}>No cards</div>
        ) : (
          cards.map((bc) => (
            <Link
              key={bc.id}
              to={`/cards/${bc.cardId}`}
              className={styles.card}
              draggable
              onDragStart={(e) => onDragStart(e, bc)}
              onDragEnd={onDragEnd}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, cardId: bc.cardId, cardName: bc.card?.name ?? 'Unknown card' });
              }}
            >
              {bc.card?.tags && bc.card.tags.length > 0 && (
                <div className={styles.cardTags}>
                  {bc.card.tags.slice(0, 3).map((tag: CardTag) => (
                    <span
                      key={tag.id}
                      className={styles.cardTag}
                      style={{ background: tag.color }}
                      title={tag.name}
                    >
                      {tag.name}
                    </span>
                  ))}
                  {bc.card.tags.length > 3 && (
                    <span className={styles.cardTagMore}>+{bc.card.tags.length - 3}</span>
                  )}
                </div>
              )}
              <div className={styles.cardTitle}>{bc.card?.name ?? 'Unknown card'}</div>
              {bc.card?.description && (
                <div className={styles.cardDesc}>{bc.card.description}</div>
              )}
              {bc.card?.assignee && (
                <div className={styles.cardFooter}>
                  <div className={styles.cardAssignee}>
                    <span className={styles.cardAssigneeName}>
                      {bc.card.assignee.firstName} {bc.card.assignee.lastName}
                    </span>
                    {bc.card.assignee.type === 'agent' ? (
                      <AgentAvatar
                        icon={bc.card.assignee.avatarIcon || 'spark'}
                        bgColor={bc.card.assignee.avatarBgColor || '#1a1a2e'}
                        logoColor={bc.card.assignee.avatarLogoColor || '#e94560'}
                        size={22}
                      />
                    ) : (
                      <div className={styles.cardAvatar} title={`${bc.card.assignee.firstName} ${bc.card.assignee.lastName}`}>
                        {bc.card.assignee.firstName[0]}{bc.card.assignee.lastName[0]}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </Link>
          ))
        )}
      </div>

      <button className={styles.addCardBtn} onClick={onAddCard}>
        <Plus size={14} />
        Add card
      </button>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className={styles.cardContextMenu}
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
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
