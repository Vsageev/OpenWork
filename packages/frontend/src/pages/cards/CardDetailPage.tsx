import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import {
  Trash2, Plus, X, Link2, Columns3, GripVertical, FolderOpen,
  FileText, User, Send, Check, Pencil, Loader2, ChevronDown, Copy, CalendarDays, CloudOff, Circle, CircleCheck, Star, Flag, ListChecks, History,
  Bold, Italic, Code, List, Heading2, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { Breadcrumb, Button, MarkdownContent, PageLoader, Tooltip } from '../../ui';
import type { BreadcrumbItem } from '../../ui';
import { AgentAvatar } from '../../components/AgentAvatar';
import { PriorityBadge } from '../../components/PriorityBadge';
import { QuickDateButtons } from '../../components/QuickDateButtons';
import type { Priority } from '../../components/PriorityBadge';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../stores/toast';
import { useConfirm } from '../../hooks/useConfirm';
import { addRecentVisit } from '../../lib/recent-visits';
import { useFavorites } from '../../hooks/useFavorites';
import { TimeAgo } from '../../components/TimeAgo';
import styles from './CardDetailPage.module.css';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';

/* ── Types ────────────────────────────────────────────── */

interface Tag { id: string; name: string; color: string }
interface Assignee {
  id: string; firstName: string; lastName: string; type?: 'user' | 'agent';
  avatarIcon?: string | null; avatarBgColor?: string | null; avatarLogoColor?: string | null;
}
interface LinkedCard { linkId: string; id: string; name: string; collectionId: string }
interface BoardPlacement { boardId: string; boardName: string; columnId: string; columnName: string | null; columnColor: string | null }

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

interface BoardListEntry { id: string; name: string }

interface AuditLogEntry {
  id: string;
  userId: string;
  action: string;
  entityType: string;
  entityId: string;
  changes: Record<string, unknown> | null;
  createdAt: string;
}

interface UserEntry { id: string; firstName: string; lastName: string }
interface AgentEntry {
  id: string; name: string; status: string;
  avatarIcon?: string; avatarBgColor?: string; avatarLogoColor?: string;
}

function ini(f: string, l: string) {
  return `${f[0] ?? ''}${l[0] ?? ''}`.toUpperCase();
}

/* ── Assignee picker (portal) ─────────────────────────── */

import { forwardRef } from 'react';

interface AssigneePickerProps {
  triggerRef: React.RefObject<HTMLDivElement | null>;
  loading: boolean;
  users: UserEntry[];
  agents: AgentEntry[];
  assigneeId: string | null;
  hasAssignee: boolean;
  onAssign: (id: string | null) => void;
}

const AssigneePicker = forwardRef<HTMLDivElement, AssigneePickerProps>(
  function AssigneePicker({ triggerRef, loading, users, agents, assigneeId, hasAssignee, onAssign }, ref) {
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

    useEffect(() => {
      function update() {
        const el = triggerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        setPos({ top: rect.bottom + 4, left: rect.right });
      }
      update();
      window.addEventListener('scroll', update, true);
      window.addEventListener('resize', update);
      return () => {
        window.removeEventListener('scroll', update, true);
        window.removeEventListener('resize', update);
      };
    }, [triggerRef]);

    if (!pos) return null;

    return (
      <div
        ref={ref}
        className={styles.assigneeOverlay}
        style={{ top: pos.top, left: pos.left }}
      >
        {loading ? (
          <div className={styles.pickerLoading}>
            <Loader2 size={14} className={styles.spinner} /> Loading…
          </div>
        ) : users.length === 0 && agents.length === 0 ? (
          <div className={styles.pickerEmpty}>No users or agents available</div>
        ) : (
          <>
            {hasAssignee && (
              <button className={styles.resultItem} onClick={() => onAssign(null)}>
                <X size={12} /> Unassign
              </button>
            )}
            {agents.length > 0 && (
              <>
                <div className={styles.pickerDivider}>Agents</div>
                {agents.map((a) => (
                  <button
                    key={a.id}
                    className={`${styles.resultItem}${assigneeId === a.id ? ` ${styles.resultItemActive}` : ''}`}
                    onClick={() => onAssign(a.id)}
                  >
                    <AgentAvatar icon={a.avatarIcon || 'spark'} bgColor={a.avatarBgColor || '#1a1a2e'} logoColor={a.avatarLogoColor || '#e94560'} size={16} /> {a.name}
                    {assigneeId === a.id && <Check size={12} className={styles.checkIcon} />}
                  </button>
                ))}
              </>
            )}
            {users.length > 0 && (
              <>
                <div className={styles.pickerDivider}>Users</div>
                {users.map((u) => (
                  <button
                    key={u.id}
                    className={`${styles.resultItem}${assigneeId === u.id ? ` ${styles.resultItemActive}` : ''}`}
                    onClick={() => onAssign(u.id)}
                  >
                    <User size={12} /> {u.firstName} {u.lastName}
                    {assigneeId === u.id && <Check size={12} className={styles.checkIcon} />}
                  </button>
                ))}
              </>
            )}
          </>
        )}
      </div>
    );
  },
);

/* ── Audit log helper ─────────────────────────────────── */

function formatAuditEntry(entry: AuditLogEntry): string {
  const { action, entityType, changes } = entry;
  if (entityType === 'card_comment') {
    if (action === 'create') return 'Comment added';
    if (action === 'update') return 'Comment edited';
    if (action === 'delete') return 'Comment deleted';
  }
  if (action === 'create') return 'Card created';
  if (action === 'delete') return 'Card deleted';
  if (action === 'update' && changes) {
    // customFields is a nested object — inspect its keys for meaningful changes
    if (changes.customFields && typeof changes.customFields === 'object') {
      const cf = changes.customFields as Record<string, unknown>;
      if ('completed' in cf) return cf.completed ? 'Marked as completed' : 'Reopened';
      if ('dueDate' in cf) {
        const d = cf.dueDate;
        return d ? `Due date set to ${new Date(String(d)).toLocaleDateString()}` : 'Due date removed';
      }
      if ('priority' in cf) return cf.priority ? `Priority set to ${cf.priority}` : 'Priority removed';
      if ('checklist' in cf) return 'Checklist updated';
      return 'Fields updated';
    }
    const keys = Object.keys(changes).filter((k) => k !== 'updatedAt');
    if (keys.includes('name')) return `Renamed to "${changes.name}"`;
    if (keys.includes('description')) return 'Description updated';
    if (keys.includes('assigneeId')) return changes.assigneeId ? 'Assignee updated' : 'Assignee removed';
    if (keys.length > 0) return `Updated: ${keys.join(', ')}`;
  }
  return `${action.charAt(0).toUpperCase()}${action.slice(1)}`;
}

/* ── Component ────────────────────────────────────────── */

export function CardDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const locState = location.state as { fromBoardId?: string; fromBoardName?: string; cardSiblings?: string[]; fromCollectionId?: string } | null;
  const fromBoard = locState;
  const cardSiblings = locState?.cardSiblings;
  const currentIndex = cardSiblings && id ? cardSiblings.indexOf(id) : -1;
  const prevCardId = cardSiblings && currentIndex > 0 ? cardSiblings[currentIndex - 1] : null;
  const nextCardId = cardSiblings && currentIndex >= 0 && currentIndex < cardSiblings.length - 1 ? cardSiblings[currentIndex + 1] : null;
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { isFavorite, toggleFavorite } = useFavorites();

  const [card, setCard] = useState<CardDetail | null>(null);
  const [collectionName, setCollectionName] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<'not_found' | 'error' | null>(null);
  useDocumentTitle(card?.name ?? 'Card');
  const [loading, setLoading] = useState(true);
  const [comments, setComments] = useState<CardComment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const commentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editCommentDraft, setEditCommentDraft] = useState('');
  const [savingEditComment, setSavingEditComment] = useState(false);

  // Activity view
  const [activityView, setActivityView] = useState<'comments' | 'history'>('comments');
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [auditLogsLoading, setAuditLogsLoading] = useState(false);

  // Inline editing
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [editingDesc, setEditingDesc] = useState(false);
  const [draftDesc, setDraftDesc] = useState('');
  const [descPreview, setDescPreview] = useState(false);
  const [descSaveStatus, setDescSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const descAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const descTextareaRef = useRef<HTMLTextAreaElement>(null);
  const descSelectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });

  // Tag management
  const [showTagMgr, setShowTagMgr] = useState(false);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#3B82F6');
  const [creatingTag, setCreatingTag] = useState(false);
  const [deletingTagId, setDeletingTagId] = useState<string | null>(null);

  // Linked cards
  const [showLinkSearch, setShowLinkSearch] = useState(false);
  const [linkTerm, setLinkTerm] = useState('');
  const [linkResults, setLinkResults] = useState<{ id: string; name: string }[]>([]);

  // Board management
  const [boardColumns, setBoardColumns] = useState<Map<string, BoardColumnInfo[]>>(new Map());
  const [movingColumn, setMovingColumn] = useState<string | null>(null);
  const [showBoardPicker, setShowBoardPicker] = useState(false);
  const [allBoards, setAllBoards] = useState<BoardListEntry[]>([]);
  const [loadingBoards, setLoadingBoards] = useState(false);

  // Assignee
  const [showAssignee, setShowAssignee] = useState(false);
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [loadingAssignees, setLoadingAssignees] = useState(false);
  const assigneeTriggerRef = useRef<HTMLDivElement>(null);
  const assigneeDropdownRef = useRef<HTMLDivElement>(null);

  // Collection picker
  const [showCollectionPicker, setShowCollectionPicker] = useState(false);
  const [allCollections, setAllCollections] = useState<{ id: string; name: string }[]>([]);
  const [loadingCollections, setLoadingCollections] = useState(false);
  const [movingCollection, setMovingCollection] = useState(false);
  const collectionPickerRef = useRef<HTMLDivElement>(null);

  // Due date
  const [savingDueDate, setSavingDueDate] = useState(false);

  // Priority
  const [savingPriority, setSavingPriority] = useState(false);

  // Custom fields editing
  const [editingCfKey, setEditingCfKey] = useState<string | null>(null);
  const [editingCfValue, setEditingCfValue] = useState('');
  const [addingCf, setAddingCf] = useState(false);
  const [newCfKey, setNewCfKey] = useState('');
  const [newCfValue, setNewCfValue] = useState('');
  const [savingCf, setSavingCf] = useState(false);
  const cfKeyInputRef = useRef<HTMLInputElement>(null);
  const cfValInputRef = useRef<HTMLInputElement>(null);

  /* ── Fetch ──────────────────────────────────────────── */

  const fetchCard = useCallback(async (opts?: { silent?: boolean }) => {
    if (!id) return;
    if (!opts?.silent) setLoading(true);
    setLoadError(null);
    try {
      const data = await api<CardDetail>(`/cards/${id}`);
      setCard(data);
      addRecentVisit({ type: 'card', id: data.id, name: data.name, path: `/cards/${data.id}` });
      // Fetch collection name for breadcrumb
      api<{ name: string }>(`/collections/${data.collectionId}`)
        .then((col) => setCollectionName(col.name))
        .catch(() => {});
    }
    catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setLoadError('not_found');
      } else {
        setLoadError('error');
      }
    }
    finally { if (!opts?.silent) setLoading(false); }
  }, [id]);

  const fetchComments = useCallback(async () => {
    if (!id) return;
    try {
      const d = await api<{ entries: CardComment[] }>(`/cards/${id}/comments`);
      setComments(d.entries);
    } catch { /* best-effort */ }
  }, [id]);

  const fetchTags = useCallback(async () => {
    try {
      const d = await api<{ entries: Tag[] }>('/tags');
      setAllTags(d.entries);
    } catch { /* ignore */ }
  }, []);

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

  const fetchAuditLogs = useCallback(async () => {
    if (!id) return;
    setAuditLogsLoading(true);
    try {
      const res = await api<{ entries: AuditLogEntry[] }>(`/audit-logs?entityType=card&entityId=${id}&limit=50`);
      setAuditLogs(res.entries);
    } catch { /* best-effort */ }
    finally { setAuditLogsLoading(false); }
  }, [id]);

  useEffect(() => { fetchCard(); fetchComments(); }, [fetchCard, fetchComments]);

  useEffect(() => {
    if (activityView === 'history' && auditLogs.length === 0 && !auditLogsLoading) {
      void fetchAuditLogs();
    }
  }, [activityView, auditLogs.length, auditLogsLoading, fetchAuditLogs]);

  useEffect(() => {
    if (card?.boards.length) fetchBoardColumns(card.boards);
  }, [card?.boards, fetchBoardColumns]);

  // Close assignee picker on outside click
  useEffect(() => {
    if (!showAssignee) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        assigneeTriggerRef.current?.contains(target) ||
        assigneeDropdownRef.current?.contains(target)
      ) return;
      setShowAssignee(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showAssignee]);

  /* ── Inline editing ─────────────────────────────────── */

  function startEditName() {
    if (!card) return;
    setDraftName(card.name);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 0);
  }

  async function saveName() {
    if (!card) return;
    const name = draftName.trim();
    if (!name || name === card.name) { setEditingName(false); return; }
    const prevName = card.name;
    setCard({ ...card, name });
    setEditingName(false);
    try {
      await api(`/cards/${card.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
    } catch (e) {
      setCard({ ...card, name: prevName });
      if (e instanceof ApiError) toast.error(e.message);
    }
  }

  function startEditDesc() {
    if (!card) return;
    setDraftDesc(card.description || '');
    setDescPreview(false);
    setDescSaveStatus('idle');
    setEditingDesc(true);
    setTimeout(() => {
      const ta = descTextareaRef.current;
      if (ta) {
        ta.focus();
        ta.style.height = 'auto';
        ta.style.height = `${Math.max(160, ta.scrollHeight)}px`;
      }
    }, 0);
  }

  const saveDescNow = useCallback(async (text: string) => {
    if (!card) return;
    const description = text.trim() || null;
    if (description === (card.description || null)) {
      setDescSaveStatus('saved');
      return;
    }
    setDescSaveStatus('saving');
    const prevDesc = card.description;
    setCard((prev) => prev ? { ...prev, description } : prev);
    try {
      await api(`/cards/${card.id}`, { method: 'PATCH', body: JSON.stringify({ description }) });
      setDescSaveStatus('saved');
    } catch (e) {
      setCard((prev) => prev ? { ...prev, description: prevDesc } : prev);
      setDescSaveStatus('error');
      if (e instanceof ApiError) toast.error(e.message);
    }
  }, [card]);

  function scheduleDescAutosave(text: string) {
    if (descAutosaveTimerRef.current) clearTimeout(descAutosaveTimerRef.current);
    setDescSaveStatus('idle');
    descAutosaveTimerRef.current = setTimeout(() => {
      void saveDescNow(text);
    }, 1500);
  }

  function closeDescEditor(discard?: boolean) {
    if (descAutosaveTimerRef.current) {
      clearTimeout(descAutosaveTimerRef.current);
      descAutosaveTimerRef.current = null;
    }
    if (!discard && card) {
      // Save immediately on close
      void saveDescNow(draftDesc);
    }
    setEditingDesc(false);
    setDescSaveStatus('idle');
  }

  /* ── Markdown toolbar ─────────────────────────────────── */

  function insertFormat(type: 'bold' | 'italic' | 'code' | 'link' | 'bullet' | 'heading') {
    const ta = descTextareaRef.current;
    if (!ta) return;
    // Use saved selection (textarea loses focus when toolbar button is clicked)
    const start = descSelectionRef.current.start;
    const end = descSelectionRef.current.end;
    const selected = draftDesc.slice(start, end);
    const before = draftDesc.slice(0, start);
    const after = draftDesc.slice(end);

    let newText = draftDesc;
    let newStart = start;
    let newEnd = end;

    switch (type) {
      case 'bold': {
        newText = `${before}**${selected || 'bold text'}**${after}`;
        newStart = selected ? start + 2 : start + 2;
        newEnd = selected ? end + 2 : start + 2 + (selected || 'bold text').length;
        break;
      }
      case 'italic': {
        newText = `${before}_${selected || 'italic text'}_${after}`;
        newStart = selected ? start + 1 : start + 1;
        newEnd = selected ? end + 1 : start + 1 + (selected || 'italic text').length;
        break;
      }
      case 'code': {
        if (selected.includes('\n')) {
          newText = `${before}\`\`\`\n${selected || 'code'}\n\`\`\`${after}`;
          newStart = start + 4;
          newEnd = newStart + (selected || 'code').length;
        } else {
          newText = `${before}\`${selected || 'code'}\`${after}`;
          newStart = start + 1;
          newEnd = selected ? end + 1 : start + 1 + (selected || 'code').length;
        }
        break;
      }
      case 'link': {
        const linkText = selected || 'link text';
        newText = `${before}[${linkText}](url)${after}`;
        // Select the "url" part so user can type it immediately
        newStart = start + 1 + linkText.length + 2;
        newEnd = newStart + 3;
        break;
      }
      case 'bullet': {
        // Find the start of the current line
        const lineStart = before.lastIndexOf('\n') + 1;
        const linePrefix = draftDesc.slice(lineStart, start);
        if (linePrefix.startsWith('- ')) {
          // Toggle off: remove "- " prefix
          newText = draftDesc.slice(0, lineStart) + draftDesc.slice(lineStart + 2);
          newStart = Math.max(lineStart, start - 2);
          newEnd = Math.max(lineStart, end - 2);
        } else {
          newText = draftDesc.slice(0, lineStart) + '- ' + draftDesc.slice(lineStart);
          newStart = start + 2;
          newEnd = end + 2;
        }
        break;
      }
      case 'heading': {
        const lineStart = before.lastIndexOf('\n') + 1;
        const linePrefix = draftDesc.slice(lineStart, start);
        if (linePrefix.startsWith('## ')) {
          newText = draftDesc.slice(0, lineStart) + draftDesc.slice(lineStart + 3);
          newStart = Math.max(lineStart, start - 3);
          newEnd = Math.max(lineStart, end - 3);
        } else {
          newText = draftDesc.slice(0, lineStart) + '## ' + draftDesc.slice(lineStart);
          newStart = start + 3;
          newEnd = end + 3;
        }
        break;
      }
    }

    setDraftDesc(newText);
    scheduleDescAutosave(newText);
    // Restore focus and selection after state update
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(newStart, newEnd);
      ta.style.height = 'auto';
      ta.style.height = `${Math.max(160, ta.scrollHeight)}px`;
    });
  }

  // Warn before closing tab with unsaved description changes
  useEffect(() => {
    if (!editingDesc) return;
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      const unsaved = card && (draftDesc.trim() || null) !== (card.description || null);
      if (unsaved) {
        e.preventDefault();
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [editingDesc, draftDesc, card]);

  // Keyboard shortcut: Alt+Left / Alt+Right for prev/next card navigation
  useEffect(() => {
    function handleSiblingNav(e: KeyboardEvent) {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const target = e.target as HTMLElement;
        const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
        if (isInput) return;
        if (e.key === 'ArrowLeft' && prevCardId) {
          e.preventDefault();
          navigate(`/cards/${prevCardId}`, { state: locState });
        } else if (e.key === 'ArrowRight' && nextCardId) {
          e.preventDefault();
          navigate(`/cards/${nextCardId}`, { state: locState });
        }
      }
    }
    window.addEventListener('keydown', handleSiblingNav);
    return () => window.removeEventListener('keydown', handleSiblingNav);
  }, [prevCardId, nextCardId, navigate, locState]);

  // Cleanup autosave timer on unmount
  useEffect(() => {
    return () => {
      if (descAutosaveTimerRef.current) clearTimeout(descAutosaveTimerRef.current);
    };
  }, []);

  /* ── Due date ───────────────────────────────────────── */

  async function saveDueDate(value: string) {
    if (!card) return;
    const dueDate = value || null;
    const prevCustomFields = card.customFields;
    const newCustomFields = { ...card.customFields, dueDate };
    setCard({ ...card, customFields: newCustomFields });
    setSavingDueDate(true);
    try {
      await api(`/cards/${card.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
    } catch (e) {
      setCard({ ...card, customFields: prevCustomFields });
      if (e instanceof ApiError) toast.error(e.message);
    } finally {
      setSavingDueDate(false);
    }
  }

  /* ── Priority ───────────────────────────────────────── */

  async function savePriority(value: Priority | null) {
    if (!card) return;
    const prevCustomFields = card.customFields;
    const newCustomFields = { ...card.customFields, priority: value ?? undefined };
    if (!value) delete newCustomFields.priority;
    setCard({ ...card, customFields: newCustomFields });
    setSavingPriority(true);
    try {
      await api(`/cards/${card.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
    } catch (e) {
      setCard({ ...card, customFields: prevCustomFields });
      if (e instanceof ApiError) toast.error(e.message);
    } finally {
      setSavingPriority(false);
    }
  }

  /* ── Collection ─────────────────────────────────────── */

  async function openCollectionPicker() {
    if (showCollectionPicker) { setShowCollectionPicker(false); return; }
    setShowCollectionPicker(true);
    if (allCollections.length === 0) {
      setLoadingCollections(true);
      try {
        const res = await api<{ entries: { id: string; name: string }[] }>('/collections?limit=100');
        setAllCollections(res.entries);
      } catch { /* best-effort */ }
      finally { setLoadingCollections(false); }
    }
  }

  async function moveToCollection(targetCollectionId: string) {
    if (!card || movingCollection || targetCollectionId === card.collectionId) return;
    const prevCollectionId = card.collectionId;
    const targetCol = allCollections.find((c) => c.id === targetCollectionId);
    setCard({ ...card, collectionId: targetCollectionId });
    setCollectionName(targetCol?.name ?? null);
    setShowCollectionPicker(false);
    setMovingCollection(true);
    try {
      await api(`/cards/${card.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ collectionId: targetCollectionId }),
      });
      toast.success(`Moved to ${targetCol?.name ?? 'collection'}`);
    } catch (e) {
      setCard((prev) => prev ? { ...prev, collectionId: prevCollectionId } : prev);
      // Restore previous collection name
      api<{ name: string }>(`/collections/${prevCollectionId}`)
        .then((col) => setCollectionName(col.name))
        .catch(() => {});
      if (e instanceof ApiError) toast.error(e.message);
      else toast.error('Failed to move card');
    } finally {
      setMovingCollection(false);
    }
  }

  // Close collection picker on outside click
  useEffect(() => {
    if (!showCollectionPicker) return;
    function handleClick(e: MouseEvent) {
      if (collectionPickerRef.current && !collectionPickerRef.current.contains(e.target as Node)) {
        setShowCollectionPicker(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showCollectionPicker]);

  /* ── Checklist ────────────────────────────────────────── */

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
  const [dragChecklistId, setDragChecklistId] = useState<string | null>(null);
  const [dragOverChecklistId, setDragOverChecklistId] = useState<string | null>(null);
  const [editingChecklistId, setEditingChecklistId] = useState<string | null>(null);
  const [editChecklistDraft, setEditChecklistDraft] = useState('');
  const editChecklistInputRef = useRef<HTMLInputElement>(null);

  async function saveChecklist(items: ChecklistItem[]) {
    if (!card) return;
    const prevCustomFields = card.customFields;
    const newCustomFields = { ...card.customFields, checklist: items };
    setCard({ ...card, customFields: newCustomFields });
    try {
      await api(`/cards/${card.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
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
        action: { label: 'Mark card complete', onClick: () => void handleToggleComplete() },
      });
    }
  }

  function removeChecklistItem(itemId: string) {
    void saveChecklist(checklist.filter((i) => i.id !== itemId));
  }

  function clearCompletedChecklist() {
    const remaining = checklist.filter((i) => !i.done);
    if (remaining.length === checklist.length) return;
    void saveChecklist(remaining);
  }

  function startEditChecklistItem(itemId: string) {
    const item = checklist.find((i) => i.id === itemId);
    if (!item) return;
    setEditingChecklistId(itemId);
    setEditChecklistDraft(item.text);
    setTimeout(() => editChecklistInputRef.current?.focus(), 0);
  }

  function saveChecklistItemEdit() {
    if (!editingChecklistId) return;
    const text = editChecklistDraft.trim();
    if (!text) {
      // Empty text = remove the item
      removeChecklistItem(editingChecklistId);
    } else {
      const item = checklist.find((i) => i.id === editingChecklistId);
      if (item && text !== item.text) {
        void saveChecklist(checklist.map((i) => (i.id === editingChecklistId ? { ...i, text } : i)));
      }
    }
    setEditingChecklistId(null);
    setEditChecklistDraft('');
  }

  function cancelChecklistItemEdit() {
    setEditingChecklistId(null);
    setEditChecklistDraft('');
  }

  function onChecklistDragStart(e: React.DragEvent, itemId: string) {
    setDragChecklistId(itemId);
    e.dataTransfer.effectAllowed = 'move';
  }

  function onChecklistDragOver(e: React.DragEvent, itemId: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (itemId !== dragOverChecklistId) setDragOverChecklistId(itemId);
  }

  function onChecklistDrop(e: React.DragEvent, targetId: string) {
    e.preventDefault();
    if (!dragChecklistId || dragChecklistId === targetId) {
      setDragChecklistId(null);
      setDragOverChecklistId(null);
      return;
    }
    const fromIdx = checklist.findIndex((i) => i.id === dragChecklistId);
    const toIdx = checklist.findIndex((i) => i.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const reordered = [...checklist];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    setDragChecklistId(null);
    setDragOverChecklistId(null);
    void saveChecklist(reordered);
  }

  function onChecklistDragEnd() {
    setDragChecklistId(null);
    setDragOverChecklistId(null);
  }

  /* ── Custom fields ──────────────────────────────────── */

  const SYSTEM_CF_KEYS = useMemo(() => new Set(['dueDate', 'completed', 'priority', 'checklist']), []);

  async function saveCustomField(key: string, value: string) {
    if (!card || savingCf) return;
    const trimmedKey = key.trim();
    const trimmedVal = value.trim();
    if (!trimmedKey) return;
    setSavingCf(true);
    const prevCustomFields = card.customFields;
    const newCustomFields = { ...card.customFields, [trimmedKey]: trimmedVal };
    setCard({ ...card, customFields: newCustomFields });
    try {
      await api(`/cards/${card.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
    } catch (e) {
      setCard({ ...card, customFields: prevCustomFields });
      if (e instanceof ApiError) toast.error(e.message);
    } finally {
      setSavingCf(false);
    }
  }

  async function deleteCustomField(key: string) {
    if (!card || savingCf) return;
    setSavingCf(true);
    const prevCustomFields = card.customFields;
    const newCustomFields = { ...card.customFields };
    delete newCustomFields[key];
    setCard({ ...card, customFields: newCustomFields });
    try {
      await api(`/cards/${card.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
    } catch (e) {
      setCard({ ...card, customFields: prevCustomFields });
      if (e instanceof ApiError) toast.error(e.message);
    } finally {
      setSavingCf(false);
    }
  }

  function startEditCf(key: string, currentValue: unknown) {
    setEditingCfKey(key);
    setEditingCfValue(String(currentValue ?? ''));
    setAddingCf(false);
  }

  async function commitEditCf() {
    if (!editingCfKey) return;
    await saveCustomField(editingCfKey, editingCfValue);
    setEditingCfKey(null);
  }

  async function commitAddCf() {
    if (!newCfKey.trim()) return;
    await saveCustomField(newCfKey, newCfValue);
    setNewCfKey('');
    setNewCfValue('');
    setAddingCf(false);
  }

  /* ── Card actions ───────────────────────────────────── */

  async function handleDelete() {
    if (!card) return;
    const confirmed = await confirm({
      title: 'Delete card',
      message: 'Delete this card? This cannot be undone.',
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await api(`/cards/${card.id}`, { method: 'DELETE' });
      navigate(`/collections/${card.collectionId}`);
    } catch (e) { if (e instanceof ApiError) toast.error(e.message); }
  }

  async function handleDuplicate() {
    if (!card) return;
    try {
      const newCard = await api<{ id: string }>('/cards', {
        method: 'POST',
        body: JSON.stringify({
          collectionId: card.collectionId,
          name: `Copy of ${card.name}`,
          description: card.description ?? undefined,
          customFields: card.customFields,
          assigneeId: card.assigneeId ?? undefined,
        }),
      });
      // Copy tags in parallel
      await Promise.allSettled(
        card.tags.map((t) =>
          api(`/cards/${newCard.id}/tags`, { method: 'POST', body: JSON.stringify({ tagId: t.id }) }),
        ),
      );
      toast.success('Card duplicated');
      navigate(`/cards/${newCard.id}`);
    } catch (e) { if (e instanceof ApiError) toast.error(e.message); }
  }

  /* ── Completion toggle ─────────────────────────────── */

  async function handleToggleComplete() {
    if (!card) return;
    const currentCompleted = card.customFields?.completed === true;
    const newCompleted = !currentCompleted;
    const prevCustomFields = card.customFields;
    const newCustomFields = { ...card.customFields, completed: newCompleted };
    setCard({ ...card, customFields: newCustomFields });
    try {
      await api(`/cards/${card.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ customFields: newCustomFields }),
      });
      const shortName = card.name.length > 30 ? card.name.slice(0, 30) + '...' : card.name;
      toast.success(
        newCompleted ? `"${shortName}" completed` : `"${shortName}" reopened`,
        {
          action: {
            label: 'Undo',
            onClick: () => void handleToggleComplete(),
          },
        },
      );
    } catch (e) {
      setCard((prev) => prev ? { ...prev, customFields: prevCustomFields } : prev);
      if (e instanceof ApiError) toast.error(e.message);
    }
  }

  /* ── Keyboard shortcuts ────────────────────────────── */

  const toggleCompleteRef = useRef(handleToggleComplete);
  toggleCompleteRef.current = handleToggleComplete;

  const editingDescRef = useRef(editingDesc);
  editingDescRef.current = editingDesc;

  const startEditDescRef = useRef(startEditDesc);
  startEditDescRef.current = startEditDesc;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.target as HTMLElement).isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'x') {
        e.preventDefault();
        void toggleCompleteRef.current();
      } else if (key === 'm') {
        // Focus comment input
        e.preventDefault();
        setActivityView('comments');
        setTimeout(() => {
          commentTextareaRef.current?.focus();
        }, 0);
      } else if (key === 'e') {
        // Open description editor
        e.preventDefault();
        if (!editingDescRef.current) {
          startEditDescRef.current();
        }
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  /* ── Tag actions ────────────────────────────────────── */

  function openTagMgr() { setShowTagMgr(true); fetchTags(); }

  async function addTag(tagId: string) {
    if (!card) return;
    try {
      await api(`/cards/${card.id}/tags`, { method: 'POST', body: JSON.stringify({ tagId }) });
      fetchCard({ silent: true }); fetchTags();
    } catch (e) { if (e instanceof ApiError) toast.error(e.message); }
  }

  async function removeTag(tagId: string) {
    if (!card) return;
    const prevTags = card.tags;
    setCard({ ...card, tags: card.tags.filter((t) => t.id !== tagId) });
    try {
      await api(`/cards/${card.id}/tags/${tagId}`, { method: 'DELETE' });
    } catch (e) {
      setCard({ ...card, tags: prevTags });
      if (e instanceof ApiError) toast.error(e.message);
    }
  }

  async function createTag() {
    const name = newTagName.trim();
    if (!name) return;
    setCreatingTag(true);
    try {
      const t = await api<Tag>('/tags', { method: 'POST', body: JSON.stringify({ name, color: newTagColor }) });
      setNewTagName('');
      await addTag(t.id);
    } catch (e) { if (e instanceof ApiError) toast.error(e.message); }
    finally { setCreatingTag(false); }
  }

  async function deleteTag(tagId: string) {
    const confirmed = await confirm({
      title: 'Delete tag',
      message: 'Delete this tag from the workspace?',
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;
    setDeletingTagId(tagId);
    try {
      await api(`/tags/${tagId}`, { method: 'DELETE' });
      fetchCard({ silent: true }); fetchTags();
    } catch (e) { if (e instanceof ApiError) toast.error(e.message); }
    finally { setDeletingTagId(null); }
  }

  /* ── Link actions ───────────────────────────────────── */

  async function searchCards(term: string) {
    setLinkTerm(term);
    if (term.length < 2) { setLinkResults([]); return; }
    try {
      const d = await api<{ entries: { id: string; name: string }[] }>(
        `/cards?search=${encodeURIComponent(term)}&limit=10`,
      );
      const linked = new Set(card?.linkedCards.map((lc) => lc.id) ?? []);
      setLinkResults(d.entries.filter((c) => c.id !== id && !linked.has(c.id)));
    } catch { setLinkResults([]); }
  }

  async function linkCard(targetCardId: string) {
    if (!card) return;
    try {
      await api(`/cards/${card.id}/links`, { method: 'POST', body: JSON.stringify({ targetCardId }) });
      setShowLinkSearch(false); setLinkTerm(''); setLinkResults([]); fetchCard({ silent: true });
    } catch (e) { if (e instanceof ApiError) toast.error(e.message); }
  }

  async function unlinkCard(linkId: string) {
    if (!card) return;
    const prevLinked = card.linkedCards;
    setCard({ ...card, linkedCards: card.linkedCards.filter((lc) => lc.linkId !== linkId) });
    try {
      await api(`/cards/${card.id}/links/${linkId}`, { method: 'DELETE' });
    } catch (e) {
      setCard({ ...card, linkedCards: prevLinked });
      if (e instanceof ApiError) toast.error(e.message);
    }
  }

  /* ── Comment actions ────────────────────────────────── */

  async function addComment() {
    if (!card || !newComment.trim()) return;
    setSubmittingComment(true);
    try {
      await api(`/cards/${card.id}/comments`, { method: 'POST', body: JSON.stringify({ content: newComment.trim() }) });
      setNewComment('');
      if (commentTextareaRef.current) commentTextareaRef.current.style.height = '';
      fetchComments();
    } catch (e) { if (e instanceof ApiError) toast.error(e.message); }
    finally { setSubmittingComment(false); }
  }

  async function deleteComment(cid: string) {
    if (!card) return;
    const confirmed = await confirm({
      title: 'Delete comment',
      message: 'Delete this comment? This cannot be undone.',
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await api(`/cards/${card.id}/comments/${cid}`, { method: 'DELETE' });
      fetchComments();
    } catch (e) { if (e instanceof ApiError) toast.error(e.message); }
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
    if (!card || !editCommentDraft.trim()) return;
    setSavingEditComment(true);
    try {
      await api(`/cards/${card.id}/comments/${cid}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: editCommentDraft.trim() }),
      });
      setEditingCommentId(null);
      setEditCommentDraft('');
      fetchComments();
    } catch (e) { if (e instanceof ApiError) toast.error(e.message); }
    finally { setSavingEditComment(false); }
  }

  /* ── Assignee actions ───────────────────────────────── */

  async function openAssignee() {
    if (showAssignee) { setShowAssignee(false); return; }
    setShowAssignee(true);
    setLoadingAssignees(true);
    try {
      const [usersRes, agentsRes] = await Promise.allSettled([
        api<{ entries: UserEntry[] }>('/users'),
        api<{ entries: AgentEntry[] }>('/agents'),
      ]);
      setUsers(usersRes.status === 'fulfilled' ? usersRes.value.entries : []);
      setAgents(
        agentsRes.status === 'fulfilled'
          ? agentsRes.value.entries.filter(a => a.status === 'active')
          : [],
      );
    } catch { /* ignore */ }
    finally { setLoadingAssignees(false); }
  }

  async function assign(uid: string | null) {
    if (!card) return;
    try {
      await api(`/cards/${card.id}`, { method: 'PATCH', body: JSON.stringify({ assigneeId: uid }) });
      setShowAssignee(false); fetchCard({ silent: true });
    } catch (e) { if (e instanceof ApiError) toast.error(e.message); }
  }

  /* ── Board actions ─────────────────────────────────── */

  async function moveToColumn(boardId: string, targetColumnId: string, columnName: string) {
    if (!card) return;
    setMovingColumn(targetColumnId);
    try {
      await api(`/boards/${boardId}/cards/${card.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ columnId: targetColumnId }),
      });
      toast.success(`Moved to ${columnName}`);
      fetchCard({ silent: true });
    } catch (e) {
      if (e instanceof ApiError) toast.error(e.message);
    } finally {
      setMovingColumn(null);
    }
  }

  async function openBoardPicker() {
    if (showBoardPicker) { setShowBoardPicker(false); return; }
    setShowBoardPicker(true);
    setLoadingBoards(true);
    try {
      const d = await api<{ entries: BoardListEntry[] }>('/boards');
      setAllBoards(d.entries);
    } catch { /* ignore */ }
    finally { setLoadingBoards(false); }
  }

  async function addToBoard(boardId: string) {
    if (!card) return;
    try {
      // Fetch board to get first column
      const board = await api<{ columns: BoardColumnInfo[] }>(`/boards/${boardId}`);
      const cols = board.columns.sort((a, b) => a.position - b.position);
      if (cols.length === 0) { toast.error('Board has no columns'); return; }
      await api(`/boards/${boardId}/cards`, {
        method: 'POST',
        body: JSON.stringify({ cardId: card.id, columnId: cols[0].id }),
      });
      toast.success('Added to board');
      setShowBoardPicker(false);
      fetchCard({ silent: true });
    } catch (e) {
      if (e instanceof ApiError) toast.error(e.message);
    }
  }

  async function removeFromBoard(boardId: string) {
    if (!card) return;
    const confirmed = await confirm({
      title: 'Remove from board',
      message: 'Remove this card from the board?',
      confirmLabel: 'Remove',
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await api(`/boards/${boardId}/cards/${card.id}`, { method: 'DELETE' });
      toast.success('Removed from board');
      fetchCard({ silent: true });
    } catch (e) {
      if (e instanceof ApiError) toast.error(e.message);
    }
  }

  /* ── Render ─────────────────────────────────────────── */

  if (loading) return <PageLoader />;
  if (loadError === 'not_found') {
    return (
      <div className={styles.emptyState}>
        <CloudOff size={32} strokeWidth={1.5} />
        <p>Card not found</p>
        <p style={{ fontSize: '0.85rem', opacity: 0.7 }}>This card may have been deleted or you don't have access.</p>
        <Button size="sm" variant="secondary" onClick={() => navigate(-1)}>Go back</Button>
      </div>
    );
  }
  if (loadError === 'error' || !card) {
    return (
      <div className={styles.emptyState}>
        <CloudOff size={32} strokeWidth={1.5} />
        <p>Failed to load card</p>
        <Button size="sm" onClick={() => fetchCard()}>Try again</Button>
      </div>
    );
  }

  const cfEntries = useMemo(
    () => Object.entries(card.customFields || {}).filter(([key]) => !SYSTEM_CF_KEYS.has(key)),
    [card.customFields, SYSTEM_CF_KEYS],
  );
  const tagIds = useMemo(() => new Set(card.tags.map((t) => t.id)), [card.tags]);

  return (
    <div className={styles.page}>
      {confirmDialog}
      {/* Top bar */}
      <div className={styles.topBar}>
        <Breadcrumb
          items={
            fromBoard?.fromBoardId
              ? [
                  { label: 'Boards', to: '/boards' },
                  { label: fromBoard.fromBoardName ?? 'Board', to: `/boards/${fromBoard.fromBoardId}` },
                  { label: card.name },
                ]
              : [
                  { label: 'Collections', to: '/collections' },
                  ...(collectionName
                    ? [{ label: collectionName, to: `/collections/${card.collectionId}` } as BreadcrumbItem]
                    : []),
                  { label: card.name },
                ]
          }
        />
        {cardSiblings && cardSiblings.length > 1 && (
          <div className={styles.siblingNav}>
            <Tooltip label="Previous card (Alt+←)">
              <button
                className={styles.siblingNavBtn}
                disabled={!prevCardId}
                onClick={() => prevCardId && navigate(`/cards/${prevCardId}`, { state: locState })}
              >
                <ChevronLeft size={16} />
              </button>
            </Tooltip>
            <span className={styles.siblingNavCount}>
              {currentIndex + 1} / {cardSiblings.length}
            </span>
            <Tooltip label="Next card (Alt+→)">
              <button
                className={styles.siblingNavBtn}
                disabled={!nextCardId}
                onClick={() => nextCardId && navigate(`/cards/${nextCardId}`, { state: locState })}
              >
                <ChevronRight size={16} />
              </button>
            </Tooltip>
          </div>
        )}
        <div className={styles.topBarSpacer} />
        {card && (
          <Tooltip label={isFavorite(card.id) ? 'Remove from favorites' : 'Add to favorites'}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => toggleFavorite({ id: card.id, type: 'card', name: card.name })}
              style={isFavorite(card.id) ? { color: '#f59e0b' } : undefined}
            >
              <Star size={14} fill={isFavorite(card.id) ? 'currentColor' : 'none'} />
            </Button>
          </Tooltip>
        )}
        <Tooltip label="Copy link to clipboard">
          <Button variant="ghost" size="sm" onClick={() => {
            void navigator.clipboard.writeText(window.location.href).then(() => {
              toast.success('Link copied to clipboard');
            });
          }}>
            <Link2 size={14} />
            Copy link
          </Button>
        </Tooltip>
        <Button variant="ghost" size="sm" onClick={() => { void handleDuplicate(); }}>
          <Copy size={14} />
          Duplicate
        </Button>
        <Button variant="ghost" size="sm" onClick={handleDelete}>
          <Trash2 size={14} />
          Delete
        </Button>
      </div>

      <div className={styles.grid}>
        {/* ── Left: name, description, activity ───────── */}
        <div className={styles.main}>
          {/* Name + Description card */}
          <div className={styles.card}>
            {/* Editable title with completion toggle */}
            <div className={styles.titleRow}>
              <button
                className={`${styles.completeBtn}${card.customFields?.completed === true ? ` ${styles.completeBtnDone}` : ''}`}
                onClick={handleToggleComplete}
                title={card.customFields?.completed === true ? 'Mark as incomplete (X)' : 'Mark as complete (X)'}
                aria-label={card.customFields?.completed === true ? 'Mark as incomplete' : 'Mark as complete'}
              >
                {card.customFields?.completed === true ? <CircleCheck size={22} /> : <Circle size={22} />}
              </button>
              {editingName ? (
                <input
                  ref={nameInputRef}
                  className={styles.titleInput}
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={saveName}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveName();
                    if (e.key === 'Escape') setEditingName(false);
                  }}
                />
              ) : (
                <h1 className={`${styles.titleDisplay}${card.customFields?.completed === true ? ` ${styles.titleCompleted}` : ''}`} onClick={startEditName}>
                  {card.name}
                  <Pencil size={14} className={styles.editHint} />
                </h1>
              )}
            </div>

            {/* Editable description (markdown) */}
            <div className={styles.descriptionSection}>
              <div className={styles.descriptionHeader}>
                <span className={styles.descriptionLabel}>Description</span>
                {editingDesc && (
                  <span className={`${styles.saveStatus} ${styles[`saveStatus_${descSaveStatus}`] || ''}`}>
                    {descSaveStatus === 'saving' && <><Loader2 size={11} className={styles.spinner} /> Saving…</>}
                    {descSaveStatus === 'saved' && <><Check size={11} /> Saved</>}
                    {descSaveStatus === 'error' && <><CloudOff size={11} /> Save failed</>}
                  </span>
                )}
              </div>
              {editingDesc ? (
                <>
                  <div className={styles.descriptionTabs}>
                    <button
                      type="button"
                      className={`${styles.descriptionTab}${!descPreview ? ` ${styles.descriptionTabActive}` : ''}`}
                      onClick={() => { setDescPreview(false); setTimeout(() => descTextareaRef.current?.focus(), 0); }}
                    >
                      Write
                    </button>
                    <button
                      type="button"
                      className={`${styles.descriptionTab}${descPreview ? ` ${styles.descriptionTabActive}` : ''}`}
                      onClick={() => setDescPreview(true)}
                    >
                      Preview
                    </button>
                  </div>
                  {!descPreview && (
                    <div className={styles.mdToolbar}>
                      <button type="button" className={styles.mdToolbarBtn} title="Bold (Ctrl+B)" onClick={() => insertFormat('bold')}><Bold size={13} /></button>
                      <button type="button" className={styles.mdToolbarBtn} title="Italic (Ctrl+I)" onClick={() => insertFormat('italic')}><Italic size={13} /></button>
                      <button type="button" className={styles.mdToolbarBtn} title="Inline code" onClick={() => insertFormat('code')}><Code size={13} /></button>
                      <button type="button" className={styles.mdToolbarBtn} title="Link" onClick={() => insertFormat('link')}><Link2 size={13} /></button>
                      <span className={styles.mdToolbarSep} />
                      <button type="button" className={styles.mdToolbarBtn} title="Bullet list" onClick={() => insertFormat('bullet')}><List size={13} /></button>
                      <button type="button" className={styles.mdToolbarBtn} title="Heading" onClick={() => insertFormat('heading')}><Heading2 size={13} /></button>
                    </div>
                  )}
                  {descPreview ? (
                    <div className={styles.descriptionPreview}>
                      {draftDesc.trim() ? (
                        <MarkdownContent>{draftDesc}</MarkdownContent>
                      ) : (
                        <span className={styles.descriptionPreviewEmpty}>Nothing to preview</span>
                      )}
                    </div>
                  ) : (
                    <textarea
                      ref={descTextareaRef}
                      className={styles.descriptionTextarea}
                      value={draftDesc}
                      onChange={(e) => {
                        setDraftDesc(e.target.value);
                        scheduleDescAutosave(e.target.value);
                        // Auto-grow
                        e.target.style.height = 'auto';
                        e.target.style.height = `${Math.max(160, e.target.scrollHeight)}px`;
                      }}
                      placeholder="Write a description… (Markdown supported)"
                      onSelect={(e) => {
                        const t = e.currentTarget;
                        descSelectionRef.current = { start: t.selectionStart, end: t.selectionEnd };
                      }}
                      onBlur={(e) => {
                        descSelectionRef.current = { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd };
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          const unsaved = card && (draftDesc.trim() || null) !== (card.description || null);
                          if (unsaved && descSaveStatus !== 'saved') {
                            closeDescEditor();
                          } else {
                            closeDescEditor(true);
                          }
                        }
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          if (descAutosaveTimerRef.current) {
                            clearTimeout(descAutosaveTimerRef.current);
                            descAutosaveTimerRef.current = null;
                          }
                          void saveDescNow(draftDesc);
                        }
                        if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
                          e.preventDefault();
                          insertFormat('bold');
                        }
                        if ((e.metaKey || e.ctrlKey) && e.key === 'i') {
                          e.preventDefault();
                          insertFormat('italic');
                        }
                      }}
                    />
                  )}
                  <div className={styles.descriptionActions}>
                    <span className={styles.descriptionHint}>Auto-saves as you type</span>
                    <Button variant="ghost" size="sm" onClick={() => closeDescEditor()}>
                      Done
                    </Button>
                  </div>
                </>
              ) : card.description ? (
                <div className={styles.descriptionDisplay} onClick={startEditDesc}>
                  <MarkdownContent>{card.description}</MarkdownContent>
                  <Pencil size={12} className={styles.editHint} />
                </div>
              ) : (
                <div className={styles.descriptionPlaceholder} onClick={startEditDesc}>
                  <Pencil size={12} />
                  Click to add a description...
                </div>
              )}
            </div>

            {/* Checklist */}
            <div className={styles.checklistSection}>
              <div className={styles.checklistHeader}>
                <ListChecks size={13} />
                <span className={styles.checklistTitle}>Checklist</span>
                {checklist.length > 0 && (
                  <span className={styles.checklistCount}>{checklistDone}/{checklist.length}</span>
                )}
                {checklistDone > 0 && (
                  <button
                    className={styles.checklistClearBtn}
                    onClick={clearCompletedChecklist}
                    title="Clear completed items"
                  >
                    Clear completed
                  </button>
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
                      <div
                        key={item.id}
                        className={`${styles.checklistItem}${item.done ? ` ${styles.checklistItemDone}` : ''}${dragOverChecklistId === item.id && dragChecklistId !== item.id ? ` ${styles.checklistItemDropTarget}` : ''}${dragChecklistId === item.id ? ` ${styles.checklistItemDragging}` : ''}`}
                        draggable
                        onDragStart={(e) => onChecklistDragStart(e, item.id)}
                        onDragOver={(e) => onChecklistDragOver(e, item.id)}
                        onDrop={(e) => onChecklistDrop(e, item.id)}
                        onDragEnd={onChecklistDragEnd}
                      >
                        <span className={styles.checklistDragHandle} title="Drag to reorder">
                          <GripVertical size={14} />
                        </span>
                        <button
                          className={`${styles.checklistCheck}${item.done ? ` ${styles.checklistCheckDone}` : ''}`}
                          onClick={() => toggleChecklistItem(item.id)}
                          aria-label={item.done ? 'Mark as incomplete' : 'Mark as complete'}
                        >
                          {item.done ? <CircleCheck size={16} /> : <Circle size={16} />}
                        </button>
                        {editingChecklistId === item.id ? (
                          <input
                            ref={editChecklistInputRef}
                            className={styles.checklistEditInput}
                            value={editChecklistDraft}
                            onChange={(e) => setEditChecklistDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveChecklistItemEdit();
                              if (e.key === 'Escape') cancelChecklistItemEdit();
                            }}
                            onBlur={saveChecklistItemEdit}
                          />
                        ) : (
                          <span
                            className={`${styles.checklistText}${item.done ? ` ${styles.checklistTextDone}` : ''}`}
                            onDoubleClick={() => startEditChecklistItem(item.id)}
                            title="Double-click to edit"
                          >
                            {item.text}
                          </span>
                        )}
                        {editingChecklistId !== item.id && (
                          <button
                            className={styles.checklistEditBtn}
                            onClick={() => startEditChecklistItem(item.id)}
                            title="Edit item"
                          >
                            <Pencil size={12} />
                          </button>
                        )}
                        <button
                          className={styles.checklistRemove}
                          onClick={() => removeChecklistItem(item.id)}
                          title="Remove item"
                        >
                          <X size={12} />
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
                      }
                      if (e.key === 'Escape') {
                        setAddingChecklist(false);
                        setNewChecklistItem('');
                      }
                    }}
                    placeholder="Add a checklist item..."
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
                      Cancel
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
                  <Plus size={13} />
                  Add checklist item
                </button>
              )}
            </div>
          </div>

          {/* Activity card */}
          <div className={styles.card}>
            <div className={styles.activitySection}>
              <div className={styles.activityHeader}>
                <span className={styles.activityTitle}>Activity</span>
                <div className={styles.activityTabs}>
                  <button
                    className={`${styles.activityTab}${activityView === 'comments' ? ` ${styles.activityTabActive}` : ''}`}
                    onClick={() => setActivityView('comments')}
                  >
                    Comments {comments.length > 0 && <span className={styles.activityTabBadge}>{comments.length}</span>}
                  </button>
                  <button
                    className={`${styles.activityTab}${activityView === 'history' ? ` ${styles.activityTabActive}` : ''}`}
                    onClick={() => setActivityView('history')}
                  >
                    <History size={12} />
                    History
                  </button>
                </div>
              </div>

              {activityView === 'history' && (
                <div className={styles.historyList}>
                  {auditLogsLoading ? (
                    <div className={styles.historyLoading}><Loader2 size={14} className={styles.spinner} /> Loading history…</div>
                  ) : auditLogs.length === 0 ? (
                    <div className={styles.historyEmpty}>No history found for this card.</div>
                  ) : (
                    auditLogs.map((entry) => {
                      const label = formatAuditEntry(entry);
                      return (
                        <div key={entry.id} className={styles.historyEntry}>
                          <div className={`${styles.historyDot} ${styles[`historyDot_${entry.action}`] ?? ''}`} />
                          <div className={styles.historyContent}>
                            <span className={styles.historyLabel}>{label}</span>
                            <TimeAgo date={entry.createdAt} className={styles.historyTime} />
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {activityView === 'comments' && comments.length > 0 && (
                <div className={styles.commentsList}>
                  {comments.map((c) => (
                    <div key={c.id} className={styles.comment}>
                      <div className={`${styles.avatar} ${styles.avatarLg}${c.author?.type === 'agent' ? ` ${styles.avatarAgent}` : ''}`}>
                        {c.author?.type === 'agent' ? (
                          <AgentAvatar
                            icon={c.author.avatarIcon || 'spark'}
                            bgColor={c.author.avatarBgColor || '#1a1a2e'}
                            logoColor={c.author.avatarLogoColor || '#e94560'}
                            size={30}
                          />
                        ) : (
                          c.author ? ini(c.author.firstName, c.author.lastName) : '??'
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
                            <span className={styles.commentEdited} title={new Date(c.updatedAt).toLocaleString()}>
                              (edited)
                            </span>
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
                              <Button variant="ghost" size="sm" onClick={cancelEditComment}>Cancel</Button>
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
                          <div className={styles.commentText}>
                            <MarkdownContent compact>{c.content}</MarkdownContent>
                          </div>
                        )}
                      </div>
                      <div className={styles.commentActions}>
                        {editingCommentId !== c.id && (
                          <Tooltip label="Edit">
                            <button className={styles.commentX} onClick={() => startEditComment(c.id, c.content)} aria-label="Edit">
                              <Pencil size={11} />
                            </button>
                          </Tooltip>
                        )}
                        <Tooltip label="Delete">
                          <button className={styles.commentX} onClick={() => deleteComment(c.id)} aria-label="Delete">
                            <X size={11} />
                          </button>
                        </Tooltip>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {activityView === 'comments' && (
                <div className={styles.commentForm}>
                  <textarea
                    ref={commentTextareaRef}
                    className={styles.commentTextarea}
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
                  <Tooltip label="Send">
                    <button
                      className={styles.commentSend}
                      onClick={addComment}
                      disabled={!newComment.trim() || submittingComment}
                      aria-label="Send"
                    >
                      <Send size={14} />
                    </button>
                  </Tooltip>
                  {newComment.trim() && (
                    <span className={styles.commentHint}>
                      {navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl+'}Enter to send
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Right sidebar: metadata ─────────────────── */}
        <div className={styles.sidebar}>
          {/* Details */}
          <div className={styles.sidePanel}>
            <div className={styles.sidePanelHeader}>
              <span className={styles.sidePanelTitle}>Details</span>
            </div>
            <div className={styles.sidePanelBody}>
              {/* Status */}
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>Status</span>
                <button
                  className={`${styles.statusToggle}${card.customFields?.completed === true ? ` ${styles.statusToggleDone}` : ''}`}
                  onClick={handleToggleComplete}
                >
                  {card.customFields?.completed === true
                    ? <><CircleCheck size={13} /> Completed</>
                    : <><Circle size={13} /> Open</>}
                </button>
              </div>

              {/* Collection */}
              <div className={styles.collectionRow} ref={collectionPickerRef}>
                <div className={styles.detailRow} style={{ borderTop: 'none', paddingTop: 0 }}>
                  <span className={styles.detailLabel}>Collection</span>
                  <button className={styles.collectionBtn} onClick={openCollectionPicker}>
                    <FolderOpen size={11} />
                    <span className={styles.detailValue}>{collectionName ?? 'Unknown'}</span>
                    <ChevronDown size={10} />
                  </button>
                </div>
                {showCollectionPicker && (
                  <div className={styles.collectionDropdown}>
                    {loadingCollections ? (
                      <div className={styles.resultsEmpty}>
                        <Loader2 size={14} className={styles.spinner} /> Loading…
                      </div>
                    ) : allCollections.length > 0 ? (
                      <div className={styles.resultsList}>
                        {allCollections.map((col) => (
                          <button
                            key={col.id}
                            className={`${styles.resultItem}${col.id === card.collectionId ? ` ${styles.resultItemActive}` : ''}`}
                            onClick={() => moveToCollection(col.id)}
                            disabled={col.id === card.collectionId || movingCollection}
                          >
                            <FolderOpen size={12} /> {col.name}
                            {col.id === card.collectionId && <Check size={12} className={styles.checkIcon} />}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className={styles.resultsEmpty}>No collections found</div>
                    )}
                  </div>
                )}
              </div>

              {/* Assignee */}
              <div className={styles.detailRow} ref={assigneeTriggerRef}>
                <span className={styles.detailLabel}>Assignee</span>
                {card.assignee ? (
                  <div className={styles.assigneeRow} onClick={openAssignee} style={{ cursor: 'pointer' }}>
                    <div className={`${styles.avatar}${card.assignee.type === 'agent' ? ` ${styles.avatarAgent}` : ''}`}>
                      {card.assignee.type === 'agent'
                        ? <AgentAvatar icon={card.assignee.avatarIcon || 'spark'} bgColor={card.assignee.avatarBgColor || '#1a1a2e'} logoColor={card.assignee.avatarLogoColor || '#e94560'} size={24} />
                        : ini(card.assignee.firstName, card.assignee.lastName)}
                    </div>
                    <span className={styles.detailValue}>
                      {card.assignee.firstName} {card.assignee.type !== 'agent' ? card.assignee.lastName : ''}
                    </span>
                  </div>
                ) : (
                  <button className={styles.assignBtn} onClick={openAssignee}>
                    <User size={11} /> Assign
                  </button>
                )}
              </div>
              {showAssignee && createPortal(
                <AssigneePicker
                  ref={assigneeDropdownRef}
                  triggerRef={assigneeTriggerRef}
                  loading={loadingAssignees}
                  users={users}
                  agents={agents}
                  assigneeId={card.assigneeId}
                  hasAssignee={!!card.assignee}
                  onAssign={assign}
                />,
                document.body,
              )}

              {/* Due date */}
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>Due date</span>
                <div className={styles.dueDateWrapper}>
                  {(() => {
                    const dueDate = card.customFields?.dueDate as string | undefined;
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const due = dueDate ? new Date(dueDate) : null;
                    const isOverdue = due && due < today;
                    const diffDays = due ? Math.ceil((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)) : null;
                    const isSoon = due && !isOverdue && diffDays !== null && diffDays <= 3;
                    const relativeLabel = (() => {
                      if (!due || diffDays === null) return null;
                      if (diffDays < 0) return `${Math.abs(diffDays)}d overdue`;
                      if (diffDays === 0) return 'Due today';
                      if (diffDays === 1) return 'Due tomorrow';
                      if (diffDays <= 7) return `Due in ${diffDays}d`;
                      return null;
                    })();
                    return (
                      <>
                        <div className={`${styles.dueDateField}${isOverdue ? ` ${styles.dueDateOverdue}` : isSoon ? ` ${styles.dueDateSoon}` : ''}`}>
                          <CalendarDays size={11} />
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
                              aria-label="Clear due date"
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
                        {relativeLabel && (
                          <span className={`${styles.dueDateRelative}${isOverdue ? ` ${styles.dueDateRelativeOverdue}` : isSoon ? ` ${styles.dueDateRelativeSoon}` : ''}`}>
                            {relativeLabel}
                          </span>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>

              {/* Priority */}
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>
                  <Flag size={11} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
                  Priority
                </span>
                <PriorityBadge
                  priority={(card.customFields?.priority as Priority) ?? null}
                  editable
                  onChange={savePriority}
                  size="sm"
                />
                {savingPriority && <Loader2 size={11} className={styles.spinner} style={{ marginLeft: 4 }} />}
              </div>

              {/* Created */}
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>Created</span>
                <TimeAgo date={card.createdAt} className={styles.detailValue} />
              </div>

              {/* Updated */}
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>Updated</span>
                <TimeAgo date={card.updatedAt} className={styles.detailValue} />
              </div>
            </div>
          </div>

          {/* Boards */}
          <div className={styles.sidePanel}>
            <div className={styles.sidePanelHeader}>
              <span className={styles.sidePanelTitle}>Boards</span>
              <button className={styles.sidePanelAction} onClick={openBoardPicker}>
                <Plus size={11} /> Add
              </button>
            </div>
            <div className={styles.sidePanelBody}>
              {card.boards.length > 0 ? (
                card.boards.map((bp) => {
                  const columns = boardColumns.get(bp.boardId) || [];
                  return (
                    <div key={bp.boardId} className={styles.boardRow}>
                      <Columns3 size={13} className={styles.linkIcon} />
                      <Link to={`/boards/${bp.boardId}`} className={styles.linkName}>
                        {bp.boardName}
                      </Link>
                      {columns.length > 1 ? (
                        <div className={styles.columnSwitcher}>
                          <select
                            className={styles.columnSelect}
                            value={bp.columnId}
                            onChange={(e) => {
                              const col = columns.find((c) => c.id === e.target.value);
                              if (col) moveToColumn(bp.boardId, col.id, col.name);
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
                        <span className={styles.boardColumn} style={bp.columnColor ? { background: bp.columnColor } : undefined}>
                          {bp.columnName}
                        </span>
                      ) : null}
                      <Tooltip label="Remove from board">
                        <button className={styles.linkRemove} onClick={() => removeFromBoard(bp.boardId)} aria-label="Remove">
                          <X size={11} />
                        </button>
                      </Tooltip>
                    </div>
                  );
                })
              ) : (
                <span className={styles.panelEmpty}>Not on any board</span>
              )}
              {showBoardPicker && (
                <div className={styles.inlineDropdown}>
                  {loadingBoards ? (
                    <div className={styles.resultsEmpty}>
                      <Loader2 size={14} className={styles.spinner} /> Loading…
                    </div>
                  ) : (() => {
                    const onBoardIds = new Set(card.boards.map((b) => b.boardId));
                    const available = allBoards.filter((b) => !onBoardIds.has(b.id));
                    return available.length > 0 ? (
                      <div className={styles.resultsList}>
                        {available.map((b) => (
                          <button key={b.id} className={styles.resultItem} onClick={() => addToBoard(b.id)}>
                            <Columns3 size={12} /> {b.name}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className={styles.resultsEmpty}>No more boards available</div>
                    );
                  })()}
                </div>
              )}
            </div>
          </div>

          {/* Tags */}
          <div className={styles.sidePanel}>
            <div className={styles.sidePanelHeader}>
              <span className={styles.sidePanelTitle}>Tags</span>
              <button className={styles.sidePanelAction} onClick={openTagMgr}>
                <Plus size={11} /> Manage
              </button>
            </div>
            <div className={styles.sidePanelBody}>
              {card.tags.length > 0 ? (
                <div className={styles.tags}>
                  {card.tags.map((tag) => (
                    <span key={tag.id} className={styles.tag} style={{ background: tag.color }}>
                      {tag.name}
                      <Tooltip label="Remove">
                        <button className={styles.tagX} onClick={() => removeTag(tag.id)} aria-label="Remove">
                          <X size={7} />
                        </button>
                      </Tooltip>
                    </span>
                  ))}
                </div>
              ) : (
                <span className={styles.noTags}>No tags</span>
              )}

              {showTagMgr && (
                <div className={styles.tagMgr}>
                  <div className={styles.tagMgrCreateRow}>
                    <input
                      className={styles.inlineInput}
                      placeholder="New tag name"
                      value={newTagName}
                      onChange={(e) => setNewTagName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createTag(); } }}
                      style={{ flex: 1 }}
                    />
                    <input
                      type="color"
                      className={styles.tagMgrColorInput}
                      value={newTagColor}
                      onChange={(e) => setNewTagColor(e.target.value)}
                      aria-label="Tag color"
                    />
                    <button className={styles.sidePanelAction} onClick={createTag} disabled={!newTagName.trim() || creatingTag}>
                      {creatingTag ? '...' : 'Create'}
                    </button>
                  </div>
                  {allTags.length > 0 ? (
                    <div className={styles.tagMgrList}>
                      {allTags.map((tag) => (
                        <div key={tag.id} className={styles.tagMgrItem}>
                          <div className={styles.tagMgrInfo}>
                            <span className={styles.tagMgrDot} style={{ background: tag.color }} />
                            <span>{tag.name}</span>
                          </div>
                          <div className={styles.tagMgrActions}>
                            <button
                              className={styles.sidePanelAction}
                              onClick={() => addTag(tag.id)}
                              disabled={tagIds.has(tag.id)}
                            >
                              {tagIds.has(tag.id) ? 'Added' : 'Add'}
                            </button>
                            <Tooltip label="Delete tag">
                              <button
                                className={styles.tagMgrDelete}
                                onClick={() => deleteTag(tag.id)}
                                disabled={deletingTagId === tag.id}
                                aria-label="Delete tag"
                              >
                                <Trash2 size={11} />
                              </button>
                            </Tooltip>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.tagMgrEmpty}>No tags yet. Create one above.</div>
                  )}
                  <button
                    className={styles.sidePanelAction}
                    onClick={() => setShowTagMgr(false)}
                    style={{ alignSelf: 'flex-end' }}
                  >
                    Close
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Linked Cards */}
          <div className={styles.sidePanel}>
            <div className={styles.sidePanelHeader}>
              <span className={styles.sidePanelTitle}>Linked Cards</span>
              <button className={styles.sidePanelAction} onClick={() => setShowLinkSearch(!showLinkSearch)}>
                <Link2 size={11} /> Link
              </button>
            </div>
            <div className={styles.sidePanelBody}>
              {card.linkedCards.length > 0 ? (
                card.linkedCards.map((lc) => (
                  <div key={lc.linkId} className={styles.linkRow}>
                    <FileText size={13} className={styles.linkIcon} />
                    <Link to={`/cards/${lc.id}`} className={styles.linkName}>{lc.name}</Link>
                    <Tooltip label="Remove">
                      <button className={styles.linkRemove} onClick={() => unlinkCard(lc.linkId)} aria-label="Remove">
                        <X size={11} />
                      </button>
                    </Tooltip>
                  </div>
                ))
              ) : (
                <span className={styles.panelEmpty}>No linked cards</span>
              )}
              {showLinkSearch && (
                <div className={styles.inlineDropdown}>
                  <input
                    className={styles.inlineInput}
                    placeholder="Search cards..."
                    value={linkTerm}
                    onChange={(e) => searchCards(e.target.value)}
                    autoFocus
                  />
                  {linkResults.length > 0 && (
                    <div className={styles.resultsList}>
                      {linkResults.map((c) => (
                        <button key={c.id} className={styles.resultItem} onClick={() => linkCard(c.id)}>
                          {c.name}
                        </button>
                      ))}
                    </div>
                  )}
                  {linkTerm.length >= 2 && linkResults.length === 0 && (
                    <div className={styles.resultsEmpty}>No cards found</div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Custom Fields */}
          <div className={styles.sidePanel}>
            <div className={styles.sidePanelHeader}>
              <span className={styles.sidePanelTitle}>Custom Fields</span>
              {!addingCf && (
                <button
                  className={styles.sidePanelAction}
                  onClick={() => {
                    setAddingCf(true);
                    setEditingCfKey(null);
                    setTimeout(() => cfKeyInputRef.current?.focus(), 0);
                  }}
                >
                  <Plus size={11} /> Add
                </button>
              )}
            </div>
            <div className={styles.sidePanelBody}>
              {cfEntries.length === 0 && !addingCf && (
                <span className={styles.cfEmpty}>No custom fields</span>
              )}
              {cfEntries.map(([key, value]) => (
                <div key={key} className={styles.fieldRow}>
                  <span className={styles.fieldKey}>{key}</span>
                  {editingCfKey === key ? (
                    <div className={styles.cfEditRow}>
                      <input
                        ref={cfValInputRef}
                        className={styles.cfValueInput}
                        value={editingCfValue}
                        autoFocus
                        onChange={(e) => setEditingCfValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); void commitEditCf(); }
                          if (e.key === 'Escape') setEditingCfKey(null);
                        }}
                        onBlur={() => void commitEditCf()}
                      />
                    </div>
                  ) : (
                    <div className={styles.cfValueRow}>
                      <span
                        className={`${styles.fieldVal} ${styles.cfValueEditable}`}
                        onClick={() => startEditCf(key, value)}
                        title="Click to edit"
                      >
                        {String(value) || <em className={styles.cfEmpty}>empty</em>}
                      </span>
                      <button
                        className={styles.cfDeleteBtn}
                        onClick={() => void deleteCustomField(key)}
                        title={`Remove "${key}"`}
                        disabled={savingCf}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {addingCf && (
                <div className={styles.cfAddForm}>
                  <input
                    ref={cfKeyInputRef}
                    className={styles.cfKeyInput}
                    placeholder="Field name"
                    value={newCfKey}
                    onChange={(e) => setNewCfKey(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); cfValInputRef.current?.focus(); }
                      if (e.key === 'Escape') { setAddingCf(false); setNewCfKey(''); setNewCfValue(''); }
                    }}
                  />
                  <input
                    ref={cfValInputRef}
                    className={styles.cfValueInput}
                    placeholder="Value"
                    value={newCfValue}
                    onChange={(e) => setNewCfValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); void commitAddCf(); }
                      if (e.key === 'Escape') { setAddingCf(false); setNewCfKey(''); setNewCfValue(''); }
                    }}
                  />
                  <div className={styles.cfAddActions}>
                    <button
                      className={styles.cfSaveBtn}
                      onClick={() => void commitAddCf()}
                      disabled={!newCfKey.trim() || savingCf}
                    >
                      <Check size={11} /> Add
                    </button>
                    <button
                      className={styles.cfCancelBtn}
                      onClick={() => { setAddingCf(false); setNewCfKey(''); setNewCfValue(''); }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
