import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  X, ExternalLink, User, Send, Columns3, FileText,
  Link2, MessageSquare, ChevronDown, Pencil, Check, Trash2, CalendarDays, Loader2, UserPlus,
  ChevronLeft, ChevronRight, Copy, Circle, CircleCheck, ListChecks, Plus,
} from 'lucide-react';
import { Button, MarkdownContent, Tooltip } from '../../ui';
import { AgentAvatar } from '../../components/AgentAvatar';
import { PriorityBadge } from '../../components/PriorityBadge';
import { QuickDateButtons } from '../../components/QuickDateButtons';
import type { Priority } from '../../components/PriorityBadge';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../stores/toast';
import { TimeAgo } from '../../components/TimeAgo';
import { useConfirm } from '../../hooks/useConfirm';
import styles from './CardQuickView.module.css';

/* ── Types ──────────────────────────────────────────── */

interface Tag { id: string; name: string; color: string }
interface Assignee {
  id: string; firstName: string; lastName: string; type?: 'user' | 'agent';
  avatarIcon?: string | null; avatarBgColor?: string | null; avatarLogoColor?: string | null;
}
interface LinkedCard { linkId: string; id: string; name: string; collectionId: string }
interface BoardPlacement { boardId: string; boardName: string; columnId: string; columnName: string | null; columnColor: string | null }
interface UserEntry { id: string; firstName: string; lastName: string }
interface AgentListEntry { id: string; name: string; status: string; avatarIcon?: string; avatarBgColor?: string; avatarLogoColor?: string }

interface CardDetail {
  id: string;
  collectionId: string;
  name: string;
  description: string | null;
  customFields: Record<string, unknown>;
  assigneeId: string | null;
  assignee: Assignee | null;
  position: number;
  tags: Tag[];
  linkedCards: LinkedCard[];
  boards: BoardPlacement[];
  createdAt: string;
  updatedAt: string;
}

interface CardComment {
  id: string;
  cardId: string;
  authorId: string;
  content: string;
  author: {
    id: string;
    firstName: string;
    lastName: string;
    type?: 'user' | 'agent';
    avatarIcon?: string | null;
    avatarBgColor?: string | null;
    avatarLogoColor?: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

interface BoardColumnInfo {
  id: string;
  boardId: string;
  name: string;
  color: string;
  position: number;
}

interface CardQuickViewProps {
  cardId: string;
  boardId?: string;
  boardName?: string;
  onClose: () => void;
  onCardUpdated?: (cardId: string, updates: { name?: string; description?: string | null; assigneeId?: string | null; assignee?: Assignee | null; customFields?: Record<string, unknown> }) => void;
  /** Ordered list of card IDs for prev/next navigation */
  cardIds?: string[];
  /** Called when user navigates to a different card */
  onNavigate?: (cardId: string) => void;
}

function ini(f: string, l: string) {
  return `${f[0] ?? ''}${l[0] ?? ''}`.toUpperCase();
}

export function CardQuickView({ cardId, boardId, boardName, onClose, onCardUpdated, cardIds, onNavigate }: CardQuickViewProps) {
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [card, setCard] = useState<CardDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [comments, setComments] = useState<CardComment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [boardColumns, setBoardColumns] = useState<Map<string, BoardColumnInfo[]>>(new Map());
  const [movingColumn, setMovingColumn] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState('');
  const [savingDesc, setSavingDesc] = useState(false);
  const [savingDueDate, setSavingDueDate] = useState(false);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editCommentDraft, setEditCommentDraft] = useState('');
  const [savingEditComment, setSavingEditComment] = useState(false);
  const [showAssignee, setShowAssignee] = useState(false);
  const [assigneeUsers, setAssigneeUsers] = useState<UserEntry[]>([]);
  const [assigneeAgents, setAssigneeAgents] = useState<AgentListEntry[]>([]);
  const [loadingAssignees, setLoadingAssignees] = useState(false);
  const cancelTitleEditRef = useRef(false);
  const assigneeDropdownRef = useRef<HTMLDivElement>(null);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const descTextareaRef = useRef<HTMLTextAreaElement>(null);

  const [togglingComplete, setTogglingComplete] = useState(false);

  const [linkCopied, setLinkCopied] = useState(false);

  function copyCardLink() {
    const url = `${window.location.origin}/cards/${cardId}`;
    navigator.clipboard.writeText(url).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    });
  }

  const handleToggleComplete = useCallback(async () => {
    if (!card) return;
    const currentCompleted = card.customFields?.completed === true;
    const newCompleted = !currentCompleted;
    const prevCustomFields = card.customFields;
    const newCustomFields = { ...card.customFields, completed: newCompleted };
    setCard({ ...card, customFields: newCustomFields });
    setTogglingComplete(true);
    try {
      await api(`/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
      onCardUpdated?.(cardId, { customFields: newCustomFields });
      toast.success(newCompleted ? 'Card marked complete' : 'Card reopened');
    } catch (e) {
      setCard({ ...card, customFields: prevCustomFields });
      if (e instanceof ApiError) toast.error(e.message);
      else toast.error('Failed to update card');
    } finally {
      setTogglingComplete(false);
    }
  }, [card, cardId, onCardUpdated]);

  // Navigation helpers
  const currentIndex = cardIds ? cardIds.indexOf(cardId) : -1;
  const hasPrev = currentIndex > 0;
  const hasNext = cardIds ? currentIndex < cardIds.length - 1 : false;
  const navigatePrev = useCallback(() => {
    if (hasPrev && cardIds && onNavigate) onNavigate(cardIds[currentIndex - 1]);
  }, [hasPrev, cardIds, onNavigate, currentIndex]);
  const navigateNext = useCallback(() => {
    if (hasNext && cardIds && onNavigate) onNavigate(cardIds[currentIndex + 1]);
  }, [hasNext, cardIds, onNavigate, currentIndex]);

  const fetchCard = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<CardDetail>(`/cards/${cardId}`);
      setCard(data);
    } catch {
      toast.error('Failed to load card');
      onClose();
    } finally {
      setLoading(false);
    }
  }, [cardId, onClose]);

  const fetchComments = useCallback(async () => {
    try {
      const d = await api<{ entries: CardComment[] }>(`/cards/${cardId}/comments`);
      setComments(d.entries);
    } catch { /* best-effort */ }
  }, [cardId]);

  const fetchBoardColumns = useCallback(async (boards: BoardPlacement[]) => {
    const map = new Map<string, BoardColumnInfo[]>();
    await Promise.all(
      boards.map(async (bp) => {
        try {
          const data = await api<{ columns: BoardColumnInfo[] }>(`/boards/${bp.boardId}`);
          map.set(bp.boardId, data.columns.sort((a, b) => a.position - b.position));
        } catch { /* best-effort */ }
      }),
    );
    setBoardColumns(map);
  }, []);

  useEffect(() => {
    fetchCard();
    fetchComments();
  }, [fetchCard, fetchComments]);

  useEffect(() => {
    if (card?.boards.length) fetchBoardColumns(card.boards);
  }, [card?.boards, fetchBoardColumns]);

  async function moveToColumn(boardId: string, cardId: string, targetColumnId: string, columnName: string) {
    setMovingColumn(targetColumnId);
    try {
      await api(`/boards/${boardId}/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ columnId: targetColumnId }),
      });
      toast.success(`Moved to ${columnName}`);
      fetchCard();
    } catch (e) {
      if (e instanceof ApiError) toast.error(e.message);
      else toast.error('Failed to move card');
    } finally {
      setMovingColumn(null);
    }
  }

  // Keyboard shortcuts: Escape to close, X to toggle complete, M/C to focus comment, J/K to navigate
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // If an editing mode is active, let its local handler cancel the edit — don't close the panel
        if (editingTitle || editingDesc || editingCommentId !== null || showAssignee) return;
        onClose();
        return;
      }
      const active = document.activeElement;
      const inInput = active instanceof HTMLInputElement
        || active instanceof HTMLTextAreaElement
        || active instanceof HTMLSelectElement;
      if (inInput) return;
      // J/K or arrow keys to navigate between cards
      if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown') {
        if (editingTitle || editingDesc || editingCommentId !== null) return;
        if (hasNext) { e.preventDefault(); navigateNext(); }
      }
      if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowUp') {
        if (editingTitle || editingDesc || editingCommentId !== null) return;
        if (hasPrev) { e.preventDefault(); navigatePrev(); }
      }
      // Press M or C to jump to the comment box (M matches Card Detail shortcut)
      if (e.key === 'm' || e.key === 'M' || e.key === 'c' || e.key === 'C') {
        if (editingTitle || editingDesc || editingCommentId !== null) return;
        e.preventDefault();
        commentInputRef.current?.focus();
      }
      // Press X to toggle card completion (consistent with Card Detail, Collection, My Cards)
      if (e.key === 'x' || e.key === 'X') {
        if (editingTitle || editingDesc || editingCommentId !== null) return;
        e.preventDefault();
        void handleToggleComplete();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, editingTitle, editingDesc, editingCommentId, showAssignee, hasNext, hasPrev, navigateNext, navigatePrev, handleToggleComplete]);

  function startEditTitle() {
    if (!card) return;
    setTitleDraft(card.name);
    setEditingTitle(true);
    setTimeout(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }, 0);
  }

  async function saveTitle() {
    // onBlur fires after Escape — skip saving if the edit was explicitly cancelled
    if (cancelTitleEditRef.current) {
      cancelTitleEditRef.current = false;
      setEditingTitle(false);
      return;
    }
    if (!card || !titleDraft.trim() || titleDraft.trim() === card.name) {
      setEditingTitle(false);
      return;
    }
    setSavingTitle(true);
    try {
      await api(`/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: titleDraft.trim() }),
      });
      setCard((prev) => prev ? { ...prev, name: titleDraft.trim() } : prev);
      onCardUpdated?.(cardId, { name: titleDraft.trim() });
      toast.success('Card renamed');
    } catch (e) {
      if (e instanceof ApiError) toast.error(e.message);
      else toast.error('Failed to rename card');
    } finally {
      setSavingTitle(false);
      setEditingTitle(false);
    }
  }

  async function addComment() {
    if (!newComment.trim()) return;
    setSubmitting(true);
    try {
      await api(`/cards/${cardId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ content: newComment.trim() }),
      });
      setNewComment('');
      if (commentInputRef.current) commentInputRef.current.style.height = '';
      fetchComments();
    } catch (e) {
      if (e instanceof ApiError) toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteComment(commentId: string) {
    const confirmed = await confirm({
      title: 'Delete comment',
      message: 'Delete this comment? This cannot be undone.',
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await api(`/cards/${cardId}/comments/${commentId}`, { method: 'DELETE' });
      fetchComments();
    } catch (e) {
      if (e instanceof ApiError) toast.error(e.message);
    }
  }

  function startEditComment(cid: string, content: string) {
    setEditingCommentId(cid);
    setEditCommentDraft(content);
  }

  function cancelEditComment() {
    setEditingCommentId(null);
    setEditCommentDraft('');
  }

  async function saveEditComment(cid: string) {
    if (!editCommentDraft.trim()) return;
    setSavingEditComment(true);
    try {
      await api(`/cards/${cardId}/comments/${cid}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: editCommentDraft.trim() }),
      });
      setEditingCommentId(null);
      setEditCommentDraft('');
      fetchComments();
    } catch (e) {
      if (e instanceof ApiError) toast.error(e.message);
      else toast.error('Failed to save comment');
    } finally {
      setSavingEditComment(false);
    }
  }

  async function saveDueDate(value: string) {
    if (!card) return;
    const dueDate = value || null;
    const prevCustomFields = card.customFields;
    const newCustomFields = { ...card.customFields, dueDate };
    setCard({ ...card, customFields: newCustomFields });
    setSavingDueDate(true);
    try {
      await api(`/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
    } catch (e) {
      setCard({ ...card, customFields: prevCustomFields });
      if (e instanceof ApiError) toast.error(e.message);
      else toast.error('Failed to update due date');
    } finally {
      setSavingDueDate(false);
    }
  }

  async function savePriority(value: Priority | null) {
    if (!card) return;
    const prevCustomFields = card.customFields;
    const newCustomFields = { ...card.customFields };
    if (value) newCustomFields.priority = value;
    else delete newCustomFields.priority;
    setCard({ ...card, customFields: newCustomFields });
    try {
      await api(`/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
      onCardUpdated?.(cardId, { customFields: newCustomFields });
    } catch (e) {
      setCard({ ...card, customFields: prevCustomFields });
      if (e instanceof ApiError) toast.error(e.message);
      else toast.error('Failed to update priority');
    }
  }

  // ── Checklist ───────────────────────────────────────
  interface ChecklistItem { id: string; text: string; done: boolean }

  const checklist: ChecklistItem[] = useMemo(
    () => (card?.customFields?.checklist as ChecklistItem[] | undefined) ?? [],
    [card?.customFields?.checklist],
  );
  const checklistDone = useMemo(() => checklist.filter((i) => i.done).length, [checklist]);
  const checklistProgress = checklist.length > 0 ? Math.round((checklistDone / checklist.length) * 100) : 0;

  const [newChecklistItem, setNewChecklistItem] = useState('');
  const [addingChecklist, setAddingChecklist] = useState(false);
  const checklistInputRef = useRef<HTMLInputElement>(null);

  async function saveChecklist(items: ChecklistItem[]) {
    if (!card) return;
    const prevCustomFields = card.customFields;
    const newCustomFields = { ...card.customFields, checklist: items };
    setCard({ ...card, customFields: newCustomFields });
    try {
      await api(`/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
      onCardUpdated?.(cardId, { customFields: newCustomFields });
    } catch (e) {
      setCard({ ...card, customFields: prevCustomFields });
      if (e instanceof ApiError) toast.error(e.message);
      else toast.error('Failed to update checklist');
    }
  }

  function addChecklistItem() {
    const text = newChecklistItem.trim();
    if (!text) return;
    const item: ChecklistItem = { id: `cl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, done: false };
    setNewChecklistItem('');
    void saveChecklist([...checklist, item]);
  }

  function toggleChecklistItem(itemId: string) {
    const updated = checklist.map((i) => (i.id === itemId ? { ...i, done: !i.done } : i));
    void saveChecklist(updated);
    if (updated.length > 0 && updated.every((i) => i.done) && card?.customFields?.completed !== true) {
      toast.success('All checklist items done!', {
        action: { label: 'Mark complete', onClick: () => void handleToggleComplete() },
      });
    }
  }

  function removeChecklistItem(itemId: string) {
    const updated = checklist.filter((i) => i.id !== itemId);
    void saveChecklist(updated);
  }

  async function openAssigneePicker() {
    if (showAssignee) { setShowAssignee(false); return; }
    setShowAssignee(true);
    setLoadingAssignees(true);
    try {
      const [usersRes, agentsRes] = await Promise.allSettled([
        api<{ entries: UserEntry[] }>('/users'),
        api<{ entries: AgentListEntry[] }>('/agents'),
      ]);
      setAssigneeUsers(usersRes.status === 'fulfilled' ? usersRes.value.entries : []);
      setAssigneeAgents(
        agentsRes.status === 'fulfilled'
          ? agentsRes.value.entries.filter(a => a.status === 'active')
          : [],
      );
    } catch { /* ignore */ }
    finally { setLoadingAssignees(false); }
  }

  async function assignTo(uid: string | null) {
    if (!card) return;
    const prevAssigneeId = card.assigneeId;
    const prevAssignee = card.assignee;
    // Optimistic update
    const newAssignee: Assignee | null = uid
      ? (() => {
          const agent = assigneeAgents.find(a => a.id === uid);
          if (agent) return { id: agent.id, firstName: agent.name, lastName: '', type: 'agent' as const, avatarIcon: agent.avatarIcon, avatarBgColor: agent.avatarBgColor, avatarLogoColor: agent.avatarLogoColor };
          const user = assigneeUsers.find(u => u.id === uid);
          if (user) return { id: user.id, firstName: user.firstName, lastName: user.lastName, type: 'user' as const };
          return null;
        })()
      : null;
    setCard({ ...card, assigneeId: uid, assignee: newAssignee });
    setShowAssignee(false);
    try {
      await api(`/cards/${cardId}`, { method: 'PATCH', body: JSON.stringify({ assigneeId: uid }) });
      onCardUpdated?.(cardId, { assigneeId: uid, assignee: newAssignee });
      toast.success(uid ? `Assigned to ${newAssignee?.firstName ?? 'user'}` : 'Unassigned');
    } catch (e) {
      // Rollback
      setCard((prev) => prev ? { ...prev, assigneeId: prevAssigneeId, assignee: prevAssignee } : prev);
      if (e instanceof ApiError) toast.error(e.message);
      else toast.error('Failed to update assignee');
    }
  }

  // Close assignee dropdown on outside click
  useEffect(() => {
    if (!showAssignee) return;
    function handleClick(e: MouseEvent) {
      if (assigneeDropdownRef.current && !assigneeDropdownRef.current.contains(e.target as Node)) {
        setShowAssignee(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showAssignee]);

  function startEditDesc() {
    if (!card) return;
    setDescDraft(card.description || '');
    setEditingDesc(true);
    setTimeout(() => descTextareaRef.current?.focus(), 0);
  }

  async function saveDesc() {
    if (!card) return;
    const description = descDraft.trim() || null;
    if (description === (card.description || null)) {
      setEditingDesc(false);
      return;
    }
    setSavingDesc(true);
    try {
      await api(`/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ description }),
      });
      setCard((prev) => prev ? { ...prev, description } : prev);
      onCardUpdated?.(cardId, { description });
      setEditingDesc(false);
    } catch (e) {
      if (e instanceof ApiError) toast.error(e.message);
      else toast.error('Failed to save description');
    } finally {
      setSavingDesc(false);
    }
  }

  return (
    <>
      {confirmDialog}
      <div className={styles.backdrop} onClick={onClose} />
      <div className={styles.panel}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.headerLabel}>Card Preview</span>
            {cardIds && cardIds.length > 1 && currentIndex >= 0 && (
              <span className={styles.navPosition}>{currentIndex + 1} / {cardIds.length}</span>
            )}
          </div>
          <div className={styles.headerActions}>
            {cardIds && cardIds.length > 1 && (
              <div className={styles.navButtons}>
                <Tooltip label="Previous (K)">
                  <button className={styles.navBtn} onClick={navigatePrev} disabled={!hasPrev} aria-label="Previous card">
                    <ChevronLeft size={16} />
                  </button>
                </Tooltip>
                <Tooltip label="Next (J)">
                  <button className={styles.navBtn} onClick={navigateNext} disabled={!hasNext} aria-label="Next card">
                    <ChevronRight size={16} />
                  </button>
                </Tooltip>
              </div>
            )}
            <Tooltip label={linkCopied ? 'Copied!' : 'Copy link'}>
              <button className={styles.navBtn} onClick={copyCardLink} aria-label="Copy card link">
                {linkCopied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </Tooltip>
            <Link
              to={`/cards/${cardId}`}
              state={boardId ? { fromBoardId: boardId, fromBoardName: boardName } : undefined}
              className={styles.openFullBtn}
            >
              <ExternalLink size={13} />
              Open
            </Link>
            <button className={styles.closeBtn} onClick={onClose} title="Close (Esc)">
              <X size={16} />
            </button>
          </div>
        </div>

        {loading ? (
          <div className={styles.loading}>Loading...</div>
        ) : !card ? (
          <div className={styles.loading}>Card not found</div>
        ) : (
          <div className={styles.body}>
            {/* Completion toggle + Title */}
            {(() => {
              const isCompleted = card.customFields?.completed === true;
              return (
                <div className={styles.titleArea}>
                  <button
                    className={`${styles.completeBtn}${isCompleted ? ` ${styles.completeBtnDone}` : ''}`}
                    onClick={() => void handleToggleComplete()}
                    disabled={togglingComplete}
                    title={isCompleted ? 'Mark as incomplete (D)' : 'Mark as complete (D)'}
                    aria-label={isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
                  >
                    {togglingComplete
                      ? <Loader2 size={18} className={styles.spinner} />
                      : isCompleted ? <CircleCheck size={18} /> : <Circle size={18} />}
                  </button>
                  {editingTitle ? (
                    <div className={styles.titleEditRow}>
                      <input
                        ref={titleInputRef}
                        className={styles.titleInput}
                        value={titleDraft}
                        onChange={(e) => setTitleDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { void saveTitle(); }
                          if (e.key === 'Escape') {
                            cancelTitleEditRef.current = true;
                            setEditingTitle(false);
                          }
                        }}
                        onBlur={saveTitle}
                        disabled={savingTitle}
                        maxLength={500}
                      />
                      <button
                        className={styles.titleSaveBtn}
                        onClick={saveTitle}
                        disabled={savingTitle || !titleDraft.trim()}
                        title="Save (Enter)"
                      >
                        <Check size={14} />
                      </button>
                    </div>
                  ) : (
                    <div className={styles.titleRow} onClick={startEditTitle} title="Click to rename">
                      <h2 className={`${styles.title}${isCompleted ? ` ${styles.titleCompleted}` : ''}`}>{card.name}</h2>
                      <span className={styles.titleEditHint}>
                        <Pencil size={12} />
                      </span>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Meta row */}
            <div className={styles.metaRow}>
              <div className={styles.assigneeWrapper} ref={assigneeDropdownRef}>
                {card.assignee ? (
                  <div className={styles.assignee} onClick={openAssigneePicker} title="Click to reassign">
                    {card.assignee.type === 'agent' ? (
                      <AgentAvatar
                        icon={card.assignee.avatarIcon || 'spark'}
                        bgColor={card.assignee.avatarBgColor || '#1a1a2e'}
                        logoColor={card.assignee.avatarLogoColor || '#e94560'}
                        size={20}
                      />
                    ) : (
                      <div className={styles.avatar}>
                        {ini(card.assignee.firstName, card.assignee.lastName)}
                      </div>
                    )}
                    <span className={styles.assigneeName}>
                      {card.assignee.firstName} {card.assignee.type !== 'agent' ? card.assignee.lastName : ''}
                    </span>
                    <Pencil size={10} className={styles.assigneeEditHint} />
                  </div>
                ) : (
                  <button className={styles.assignBtn} onClick={openAssigneePicker}>
                    <UserPlus size={12} /> Assign
                  </button>
                )}
                {showAssignee && (
                  <div className={styles.assigneeDropdown}>
                    {loadingAssignees ? (
                      <div className={styles.assigneeDropdownLoading}>
                        <Loader2 size={14} className={styles.spinner} /> Loading…
                      </div>
                    ) : assigneeUsers.length === 0 && assigneeAgents.length === 0 ? (
                      <div className={styles.assigneeDropdownEmpty}>No users or agents available</div>
                    ) : (
                      <>
                        {card.assignee && (
                          <button className={styles.assigneeOption} onClick={() => assignTo(null)}>
                            <X size={12} /> Unassign
                          </button>
                        )}
                        {assigneeAgents.length > 0 && (
                          <>
                            <div className={styles.assigneeDivider}>Agents</div>
                            {assigneeAgents.map((a) => (
                              <button
                                key={a.id}
                                className={`${styles.assigneeOption}${card.assigneeId === a.id ? ` ${styles.assigneeOptionActive}` : ''}`}
                                onClick={() => assignTo(a.id)}
                              >
                                <AgentAvatar icon={a.avatarIcon || 'spark'} bgColor={a.avatarBgColor || '#1a1a2e'} logoColor={a.avatarLogoColor || '#e94560'} size={16} />
                                {a.name}
                                {card.assigneeId === a.id && <Check size={12} className={styles.assigneeCheckIcon} />}
                              </button>
                            ))}
                          </>
                        )}
                        {assigneeUsers.length > 0 && (
                          <>
                            <div className={styles.assigneeDivider}>Users</div>
                            {assigneeUsers.map((u) => (
                              <button
                                key={u.id}
                                className={`${styles.assigneeOption}${card.assigneeId === u.id ? ` ${styles.assigneeOptionActive}` : ''}`}
                                onClick={() => assignTo(u.id)}
                              >
                                <User size={12} /> {u.firstName} {u.lastName}
                                {card.assigneeId === u.id && <Check size={12} className={styles.assigneeCheckIcon} />}
                              </button>
                            ))}
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
              <span className={styles.metaDate}>
                Updated <TimeAgo date={card.updatedAt} />
              </span>
            </div>

            {/* Tags */}
            {card.tags.length > 0 && (
              <div className={styles.tags}>
                {card.tags.map((tag) => (
                  <span key={tag.id} className={styles.tag} style={{ background: tag.color }}>
                    {tag.name}
                  </span>
                ))}
              </div>
            )}

            {/* Due date */}
            {(() => {
              const dueDate = card.customFields?.dueDate as string | undefined;
              const today = new Date();
              today.setHours(0, 0, 0, 0);
              const due = dueDate ? new Date(dueDate) : null;
              const isOverdue = due && due < today;
              const isSoon = due && !isOverdue && (due.getTime() - today.getTime()) <= 3 * 24 * 60 * 60 * 1000;
              return (
                <div className={styles.dueDateRow}>
                  <CalendarDays size={12} className={styles.dueDateIcon} />
                  <span className={styles.dueDateLabel}>Due date</span>
                  <div className={`${styles.dueDateField}${isOverdue ? ` ${styles.dueDateOverdue}` : isSoon ? ` ${styles.dueDateSoon}` : ''}`}>
                    <input
                      type="date"
                      className={styles.dueDateInput}
                      value={dueDate ?? ''}
                      disabled={savingDueDate}
                      onChange={(e) => saveDueDate(e.target.value)}
                      aria-label="Due date"
                    />
                    {dueDate && (
                      <button
                        className={styles.dueDateClear}
                        onClick={() => saveDueDate('')}
                        disabled={savingDueDate}
                        title="Clear due date"
                      >
                        <X size={10} />
                      </button>
                    )}
                  </div>
                  <QuickDateButtons
                    currentValue={dueDate}
                    onSelect={(v) => saveDueDate(v)}
                    disabled={savingDueDate}
                  />
                </div>
              );
            })()}

            {/* Priority */}
            <div className={styles.dueDateRow}>
              <span className={styles.dueDateLabel}>Priority</span>
              <PriorityBadge
                priority={(card.customFields?.priority as Priority) ?? null}
                editable
                onChange={savePriority}
                size="sm"
              />
            </div>

            {/* Checklist */}
            <div className={styles.section}>
              <div className={styles.sectionTitle}>
                <ListChecks size={12} />
                Checklist
                {checklist.length > 0 && (
                  <span className={styles.commentCount}>
                    {checklistDone}/{checklist.length}
                  </span>
                )}
              </div>

              {checklist.length > 0 && (
                <>
                  <div className={styles.checklistProgress}>
                    <div
                      className={`${styles.checklistProgressBar}${checklistProgress === 100 ? ` ${styles.checklistProgressComplete}` : ''}`}
                      style={{ width: `${checklistProgress}%` }}
                    />
                  </div>
                  <div className={styles.checklistItems}>
                    {checklist.map((item) => (
                      <div key={item.id} className={`${styles.checklistItem}${item.done ? ` ${styles.checklistItemDone}` : ''}`}>
                        <button
                          className={`${styles.checklistCheck}${item.done ? ` ${styles.checklistCheckDone}` : ''}`}
                          onClick={() => toggleChecklistItem(item.id)}
                          aria-label={item.done ? 'Mark as incomplete' : 'Mark as complete'}
                        >
                          {item.done ? <CircleCheck size={14} /> : <Circle size={14} />}
                        </button>
                        <span className={`${styles.checklistText}${item.done ? ` ${styles.checklistTextDone}` : ''}`}>
                          {item.text}
                        </span>
                        <button
                          className={styles.checklistRemove}
                          onClick={() => removeChecklistItem(item.id)}
                          title="Remove item"
                        >
                          <X size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {addingChecklist ? (
                <div className={styles.checklistAddForm}>
                  <input
                    ref={checklistInputRef}
                    className={styles.checklistAddInput}
                    value={newChecklistItem}
                    onChange={(e) => setNewChecklistItem(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newChecklistItem.trim()) {
                        addChecklistItem();
                        // Keep input focused for rapid entry
                      }
                      if (e.key === 'Escape') {
                        setAddingChecklist(false);
                        setNewChecklistItem('');
                      }
                    }}
                    placeholder="Add an item..."
                    autoFocus
                  />
                  <div className={styles.checklistAddActions}>
                    <button
                      className={styles.checklistAddSubmit}
                      onClick={() => {
                        addChecklistItem();
                        checklistInputRef.current?.focus();
                      }}
                      disabled={!newChecklistItem.trim()}
                    >
                      Add
                    </button>
                    <button
                      className={styles.checklistAddCancel}
                      onClick={() => {
                        setAddingChecklist(false);
                        setNewChecklistItem('');
                      }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className={styles.checklistAddBtn}
                  onClick={() => {
                    setAddingChecklist(true);
                    setTimeout(() => checklistInputRef.current?.focus(), 0);
                  }}
                >
                  <Plus size={12} />
                  Add item
                </button>
              )}
            </div>

            {/* Description */}
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Description</div>
              {editingDesc ? (
                <div className={styles.descEditWrap}>
                  <textarea
                    ref={descTextareaRef}
                    className={styles.descTextarea}
                    value={descDraft}
                    onChange={(e) => setDescDraft(e.target.value)}
                    placeholder="Write a description... (Markdown supported)"
                    disabled={savingDesc}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setEditingDesc(false);
                    }}
                    rows={4}
                  />
                  <div className={styles.descActions}>
                    <Button variant="ghost" size="sm" onClick={() => setEditingDesc(false)} disabled={savingDesc}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={saveDesc} disabled={savingDesc}>
                      <Check size={14} />
                      {savingDesc ? 'Saving...' : 'Save'}
                    </Button>
                  </div>
                </div>
              ) : card.description ? (
                <div className={styles.description} onClick={startEditDesc} style={{ cursor: 'pointer' }}>
                  <MarkdownContent compact>{card.description}</MarkdownContent>
                  <Pencil size={11} className={styles.descEditHint} />
                </div>
              ) : (
                <div className={styles.descPlaceholder} onClick={startEditDesc}>
                  <Pencil size={11} />
                  Click to add a description...
                </div>
              )}
            </div>

            {/* Boards */}
            {card.boards.length > 0 && (
              <div className={styles.section}>
                <div className={styles.sectionTitle}>
                  <Columns3 size={12} /> Boards
                </div>
                <div className={styles.boardsList}>
                  {card.boards.map((bp) => {
                    const columns = boardColumns.get(bp.boardId) || [];
                    return (
                      <div key={bp.boardId} className={styles.boardItem}>
                        <span className={styles.boardName}>{bp.boardName}</span>
                        {columns.length > 1 ? (
                          <div className={styles.columnSwitcher}>
                            <select
                              className={styles.columnSelect}
                              value={bp.columnId}
                              onChange={(e) => {
                                const col = columns.find((c) => c.id === e.target.value);
                                if (col) moveToColumn(bp.boardId, card.id, col.id, col.name);
                              }}
                              disabled={movingColumn !== null}
                            >
                              {columns.map((col) => (
                                <option key={col.id} value={col.id}>
                                  {col.name}
                                </option>
                              ))}
                            </select>
                            <ChevronDown size={10} className={styles.columnSelectIcon} />
                          </div>
                        ) : bp.columnName ? (
                          <span
                            className={styles.boardColumn}
                            style={bp.columnColor ? { background: bp.columnColor } : undefined}
                          >
                            {bp.columnName}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Linked Cards */}
            {card.linkedCards.length > 0 && (
              <div className={styles.section}>
                <div className={styles.sectionTitle}>
                  <Link2 size={12} /> Linked Cards
                </div>
                <div className={styles.linkedList}>
                  {card.linkedCards.map((lc) => (
                    <Link key={lc.linkId} to={`/cards/${lc.id}`} className={styles.linkedCard}>
                      <FileText size={12} />
                      {lc.name}
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* Comments */}
            <div className={styles.section}>
              <div className={styles.sectionTitle}>
                <MessageSquare size={12} />
                Comments
                {comments.length > 0 && (
                  <span className={styles.commentCount}>{comments.length}</span>
                )}
                <kbd className={styles.sectionShortcutHint}>C</kbd>
              </div>

              {comments.length > 0 && (
                <div className={styles.commentsList}>
                  {comments.map((c) => (
                    <div key={c.id} className={styles.comment}>
                      <div className={styles.commentAvatar}>
                        {c.author?.type === 'agent' ? (
                          <AgentAvatar
                            icon={c.author.avatarIcon || 'spark'}
                            bgColor={c.author.avatarBgColor || '#1a1a2e'}
                            logoColor={c.author.avatarLogoColor || '#e94560'}
                            size={22}
                          />
                        ) : (
                          <div className={styles.avatar}>
                            {c.author ? ini(c.author.firstName, c.author.lastName) : '??'}
                          </div>
                        )}
                      </div>
                      <div className={styles.commentBody}>
                        <div className={styles.commentMeta}>
                          <span className={styles.commentAuthor}>
                            {c.author
                              ? c.author.type === 'agent'
                                ? c.author.firstName
                                : `${c.author.firstName} ${c.author.lastName}`.trim()
                              : 'Unknown'}
                          </span>
                          <TimeAgo date={c.createdAt} className={styles.commentTime} />
                          {c.updatedAt && c.updatedAt !== c.createdAt && (
                            <span className={styles.commentEdited}>(edited)</span>
                          )}
                        </div>
                        {editingCommentId === c.id ? (
                          <div className={styles.commentEditForm}>
                            <textarea
                              className={styles.commentEditTextarea}
                              value={editCommentDraft}
                              onChange={(e) => setEditCommentDraft(e.target.value)}
                              autoFocus
                              rows={3}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') cancelEditComment();
                                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveEditComment(c.id);
                              }}
                            />
                            <div className={styles.commentEditActions}>
                              <Button variant="ghost" size="sm" onClick={cancelEditComment} disabled={savingEditComment}>
                                Cancel
                              </Button>
                              <Button
                                size="sm"
                                onClick={() => void saveEditComment(c.id)}
                                disabled={!editCommentDraft.trim() || savingEditComment}
                              >
                                {savingEditComment ? <Loader2 size={12} className={styles.spinner} /> : <Check size={12} />}
                                Save
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className={styles.commentContent}>
                            <MarkdownContent compact>{c.content}</MarkdownContent>
                          </div>
                        )}
                      </div>
                      {editingCommentId !== c.id && (
                        <div className={styles.commentActions}>
                          <Tooltip label="Edit">
                            <button
                              className={styles.commentActionBtn}
                              onClick={() => startEditComment(c.id, c.content)}
                              aria-label="Edit comment"
                            >
                              <Pencil size={11} />
                            </button>
                          </Tooltip>
                          <Tooltip label="Delete">
                            <button
                              className={`${styles.commentActionBtn} ${styles.commentActionBtnDanger}`}
                              onClick={() => deleteComment(c.id)}
                              aria-label="Delete comment"
                            >
                              <Trash2 size={11} />
                            </button>
                          </Tooltip>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className={styles.commentForm}>
                <textarea
                  ref={commentInputRef}
                  className={styles.commentInput}
                  placeholder="Write a comment..."
                  value={newComment}
                  onChange={(e) => {
                    setNewComment(e.target.value);
                    e.target.style.height = 'auto';
                    e.target.style.height = `${e.target.scrollHeight}px`;
                  }}
                  rows={1}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addComment();
                  }}
                />
                <Tooltip label="Send (Cmd+Enter)">
                  <button
                    className={styles.commentSend}
                    onClick={addComment}
                    disabled={!newComment.trim() || submitting}
                  >
                    <Send size={13} />
                  </button>
                </Tooltip>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
