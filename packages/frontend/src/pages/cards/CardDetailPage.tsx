import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import {
  Trash2, Plus, X, Link2, Columns3, FolderOpen,
  FileText, User, Send, Check, Pencil, Loader2, ChevronDown, Copy, CloudOff, Star, History,
  Bold, Italic, Code, List, Heading2, ChevronLeft, ChevronRight, Image,
} from 'lucide-react';
import { Breadcrumb, Button, MarkdownContent, PageLoader, Tooltip } from '../../ui';
import { ImageLightbox } from '../../ui/ImageLightbox';
import type { BreadcrumbItem } from '../../ui';
import { AgentAvatar } from '../../components/AgentAvatar';
import { api, apiUpload, ApiError } from '../../lib/api';
import { toast } from '../../stores/toast';
import { getImagesFromClipboardData, getImagesFromFileList, prepareImageForUpload } from '../../lib/image-upload';
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

interface CardCommentAttachment {
  type: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storagePath: string;
}

interface CardComment {
  id: string;
  cardId: string;
  authorId: string;
  content: string;
  attachments?: CardCommentAttachment[] | null;
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

interface DescriptionImageUploadResponse {
  images: Array<{
    fileName: string;
    mimeType: string;
    fileSize: number;
    storagePath: string;
    markdown: string;
  }>;
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

/* ── CommentImage component ──────────────────────────── */

function CommentImage({ storagePath, alt }: { storagePath: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => {
    let revoke: string | null = null;
    const token = localStorage.getItem('ws_access_token');
    fetch(`/api/storage/download?path=${encodeURIComponent(storagePath)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load image');
        return res.blob();
      })
      .then((blob) => {
        revoke = URL.createObjectURL(blob);
        setSrc(revoke);
      })
      .catch(() => setSrc(null));

    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [storagePath]);

  if (!src) return <div className={styles.commentImagePlaceholder}>Loading image…</div>;
  return (
    <>
      <img className={styles.commentImage} src={src} alt={alt} onClick={() => setLightboxOpen(true)} />
      {lightboxOpen && <ImageLightbox src={src} alt={alt} onClose={() => setLightboxOpen(false)} />}
    </>
  );
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
  const [stagedImages, setStagedImages] = useState<{ file: File; previewUrl: string }[]>([]);
  const [uploadingImages, setUploadingImages] = useState(false);
  const [stagedLightboxSrc, setStagedLightboxSrc] = useState<string | null>(null);
  const commentFileInputRef = useRef<HTMLInputElement>(null);
  const MAX_COMMENT_IMAGES = 10;

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
  const [uploadingDescImages, setUploadingDescImages] = useState(false);
  const descAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const descTextareaRef = useRef<HTMLTextAreaElement>(null);
  const descFileInputRef = useRef<HTMLInputElement>(null);
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
        ta.style.height = `${Math.max(220, ta.scrollHeight)}px`;
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

  function updateDescriptionDraft(nextText: string, selection?: { start: number; end: number }) {
    setDraftDesc(nextText);
    scheduleDescAutosave(nextText);
    requestAnimationFrame(() => {
      const ta = descTextareaRef.current;
      if (!ta) return;
      ta.style.height = 'auto';
      ta.style.height = `${Math.max(220, ta.scrollHeight)}px`;
      if (selection) {
        ta.focus();
        ta.setSelectionRange(selection.start, selection.end);
        descSelectionRef.current = selection;
      }
    });
  }

  function insertDescriptionText(textToInsert: string) {
    const start = descSelectionRef.current.start;
    const end = descSelectionRef.current.end;
    const currentText = descTextareaRef.current?.value ?? draftDesc;
    const nextText = `${currentText.slice(0, start)}${textToInsert}${currentText.slice(end)}`;
    const cursor = start + textToInsert.length;
    updateDescriptionDraft(nextText, { start: cursor, end: cursor });
  }

  async function uploadDescriptionImages(files: File[]) {
    if (!card || files.length === 0) return;
    setUploadingDescImages(true);
    try {
      const formData = new FormData();
      for (const file of files.slice(0, MAX_COMMENT_IMAGES)) {
        const prepared = await prepareImageForUpload(file);
        formData.append('files', prepared, prepared.name);
      }
      const response = await apiUpload<DescriptionImageUploadResponse>(`/cards/${card.id}/description/images/upload`, formData);
      const snippet = response.images.map((image) => image.markdown).join('\n\n');
      if (snippet) insertDescriptionText(snippet);
    } catch (e) {
      if (e instanceof ApiError) toast.error(e.message);
    } finally {
      setUploadingDescImages(false);
    }
  }

  function handleDescriptionPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = getImagesFromClipboardData(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    void uploadDescriptionImages(files);
  }

  function handleDescriptionFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = getImagesFromFileList(e.target.files);
    if (files.length > 0) void uploadDescriptionImages(files);
    e.target.value = '';
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

    updateDescriptionDraft(newText, { start: newStart, end: newEnd });
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

  // Cleanup autosave timer on unmount
  useEffect(() => {
    return () => {
      if (descAutosaveTimerRef.current) clearTimeout(descAutosaveTimerRef.current);
    };
  }, []);

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

  /* ── Custom fields ──────────────────────────────────── */

  const cfEntries = useMemo(
    () => Object.entries(card?.customFields || {}),
    [card?.customFields],
  );
  const tagIds = useMemo(() => new Set(card?.tags.map((t) => t.id) ?? []), [card?.tags]);

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

  /* ── Image staging for comments ──────────────────────── */

  function stageCommentImages(files: File[]) {
    setStagedImages((prev) => {
      const remaining = MAX_COMMENT_IMAGES - prev.length;
      const toAdd = files.slice(0, remaining).map((file) => ({
        file,
        previewUrl: URL.createObjectURL(file),
      }));
      return [...prev, ...toAdd];
    });
  }

  function removeStagedImage(index: number) {
    setStagedImages((prev) => {
      const next = [...prev];
      URL.revokeObjectURL(next[index].previewUrl);
      next.splice(index, 1);
      return next;
    });
  }

  function clearStagedImages() {
    setStagedImages((prev) => {
      for (const img of prev) URL.revokeObjectURL(img.previewUrl);
      return [];
    });
  }

  function handleCommentPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = getImagesFromClipboardData(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    stageCommentImages(files);
  }

  function handleCommentFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = getImagesFromFileList(e.target.files);
    if (files.length > 0) stageCommentImages(files);
    e.target.value = '';
  }

  /* ── Comment actions ────────────────────────────────── */

  async function addComment() {
    if (!card || (!newComment.trim() && stagedImages.length === 0)) return;
    setSubmittingComment(true);
    try {
      if (stagedImages.length > 0) {
        setUploadingImages(true);
        const fd = new FormData();
        if (newComment.trim()) fd.append('caption', newComment.trim());
        for (const staged of stagedImages) {
          const prepared = await prepareImageForUpload(staged.file);
          fd.append('files', prepared, prepared.name);
        }
        await apiUpload(`/cards/${card.id}/comments/upload`, fd);
        clearStagedImages();
      } else {
        await api(`/cards/${card.id}/comments`, { method: 'POST', body: JSON.stringify({ content: newComment.trim() }) });
      }
      setNewComment('');
      if (commentTextareaRef.current) commentTextareaRef.current.style.height = '';
      fetchComments();
    } catch (e) { if (e instanceof ApiError) toast.error(e.message); }
    finally { setSubmittingComment(false); setUploadingImages(false); }
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
            {/* Editable title */}
            <div className={styles.titleRow}>
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
                <h1 className={styles.titleDisplay} onClick={startEditName}>
                  {card.name}
                  <Pencil size={14} className={styles.editHint} />
                </h1>
              )}
            </div>

            {/* Editable description (markdown) */}
            <div className={styles.descriptionSection}>
              <div className={styles.descriptionHeader}>
                <span className={styles.descriptionLabel}>Description</span>
              </div>
              {editingDesc ? (
                <div className={styles.descriptionEditorWrapper}>
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
                    <span className={`${styles.saveStatus} ${styles[`saveStatus_${descSaveStatus}`] || ''}`}>
                      {descSaveStatus === 'saving' && <><Loader2 size={11} className={styles.spinner} /> Saving…</>}
                      {descSaveStatus === 'saved' && <><Check size={11} /> Saved</>}
                      {descSaveStatus === 'error' && <><CloudOff size={11} /> Save failed</>}
                    </span>
                  </div>
                  {!descPreview && (
                    <div className={styles.mdToolbar}>
                      <input
                        ref={descFileInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className={styles.commentHiddenFileInput}
                        onChange={handleDescriptionFileSelect}
                      />
                      <button type="button" className={styles.mdToolbarBtn} title="Bold" onClick={() => insertFormat('bold')}><Bold size={13} /></button>
                      <button type="button" className={styles.mdToolbarBtn} title="Italic" onClick={() => insertFormat('italic')}><Italic size={13} /></button>
                      <button type="button" className={styles.mdToolbarBtn} title="Inline code" onClick={() => insertFormat('code')}><Code size={13} /></button>
                      <button type="button" className={styles.mdToolbarBtn} title="Link" onClick={() => insertFormat('link')}><Link2 size={13} /></button>
                      <button
                        type="button"
                        className={styles.mdToolbarBtn}
                        title="Insert images"
                        onClick={() => descFileInputRef.current?.click()}
                        disabled={uploadingDescImages}
                      >
                        <Image size={13} />
                      </button>
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
                        descSelectionRef.current = {
                          start: e.currentTarget.selectionStart,
                          end: e.currentTarget.selectionEnd,
                        };
                        updateDescriptionDraft(e.target.value);
                      }}
                      onPaste={handleDescriptionPaste}
                      placeholder="Add a description..."
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
                      }}
                    />
                  )}
                  <div className={styles.descriptionActions}>
                    <span className={styles.descriptionHint}>
                      {uploadingDescImages ? 'Uploading images...' : 'Markdown supported · paste or attach images'}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => closeDescEditor()}>
                      Done
                    </Button>
                  </div>
                </div>
              ) : card.description ? (
                <div className={styles.descriptionDisplay} onClick={startEditDesc}>
                  <MarkdownContent>{card.description}</MarkdownContent>
                  <Pencil size={12} className={styles.editHint} />
                </div>
              ) : (
                <div className={styles.descriptionPlaceholder} onClick={startEditDesc}>
                  <FileText size={14} />
                  Add a description...
                </div>
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
                          <>
                            {c.attachments && c.attachments.length > 0 && (
                              <div className={styles.commentImages}>
                                {c.attachments.map((att, i) => (
                                  <CommentImage key={i} storagePath={att.storagePath} alt={att.fileName} />
                                ))}
                              </div>
                            )}
                            {c.content && (
                              <div className={styles.commentText}>
                                <MarkdownContent compact>{c.content}</MarkdownContent>
                              </div>
                            )}
                          </>
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
                  {uploadingImages && <div className={styles.commentUploadingIndicator}>Uploading images…</div>}
                  {stagedImages.length > 0 && (
                    <div className={styles.commentStagedImagesRow}>
                      {stagedImages.map((img, i) => (
                        <div key={img.previewUrl} className={styles.commentStagedImagePreview}>
                          <img src={img.previewUrl} alt="Preview" className={styles.commentStagedImageThumb} onClick={() => setStagedLightboxSrc(img.previewUrl)} style={{ cursor: 'zoom-in' }} />
                          <button className={styles.commentStagedImageRemove} onClick={() => removeStagedImage(i)} aria-label="Remove image">
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className={styles.commentInputRow}>
                    <input
                      ref={commentFileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      className={styles.commentHiddenFileInput}
                      onChange={handleCommentFileSelect}
                    />
                    <Tooltip label={stagedImages.length >= MAX_COMMENT_IMAGES ? `Max ${MAX_COMMENT_IMAGES} images` : 'Attach images'}>
                      <button
                        className={styles.commentAttachBtn}
                        onClick={() => commentFileInputRef.current?.click()}
                        disabled={uploadingImages || stagedImages.length >= MAX_COMMENT_IMAGES}
                        aria-label="Attach images"
                      >
                        <Image size={14} />
                      </button>
                    </Tooltip>
                    <textarea
                      ref={commentTextareaRef}
                      className={styles.commentTextarea}
                      placeholder={stagedImages.length > 0 ? 'Add a caption… (optional)' : 'Write a comment...'}
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
                      onPaste={handleCommentPaste}
                      disabled={uploadingImages}
                    />
                    <Tooltip label="Send">
                      <button
                        className={styles.commentSend}
                        onClick={addComment}
                        disabled={(!newComment.trim() && stagedImages.length === 0) || submittingComment}
                        aria-label="Send"
                      >
                        <Send size={14} />
                      </button>
                    </Tooltip>
                  </div>
                  {(newComment.trim() || stagedImages.length > 0) && (
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
          <div className={styles.sidebarCard}>
            {/* ── Collection & Assignee ── */}
            <div className={styles.sidebarSection} ref={collectionPickerRef}>
              <div className={styles.sectionRow}>
                <span className={styles.sectionLabel}>Collection</span>
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

              <div className={styles.sectionRow} ref={assigneeTriggerRef}>
                <span className={styles.sectionLabel}>Assignee</span>
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
            </div>

            <div className={styles.sidebarDivider} />

            {/* ── Boards ── */}
            <div className={styles.sidebarSection}>
              <div className={styles.sectionHeader}>
                <Columns3 size={12} className={styles.sectionIcon} />
                <span className={styles.sectionTitle}>Boards</span>
                <button className={styles.sectionAction} onClick={openBoardPicker}>
                  <Plus size={11} />
                </button>
              </div>
              {card.boards.length > 0 ? (
                <div className={styles.sectionItems}>
                  {card.boards.map((bp) => {
                    const columns = boardColumns.get(bp.boardId) || [];
                    return (
                      <div key={bp.boardId} className={styles.boardRow}>
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
                  })}
                </div>
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

            <div className={styles.sidebarDivider} />

            {/* ── Tags ── */}
            <div className={styles.sidebarSection}>
              <div className={styles.sectionHeader}>
                <span className={styles.sectionIconDot} />
                <span className={styles.sectionTitle}>Tags</span>
                <button className={styles.sectionAction} onClick={openTagMgr}>
                  <Plus size={11} />
                </button>
              </div>
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
                <span className={styles.panelEmpty}>No tags</span>
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
                    <button className={styles.sectionAction} onClick={createTag} disabled={!newTagName.trim() || creatingTag}>
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
                              className={styles.sectionAction}
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
                    className={styles.sectionAction}
                    onClick={() => setShowTagMgr(false)}
                    style={{ alignSelf: 'flex-end' }}
                  >
                    Close
                  </button>
                </div>
              )}
            </div>

            <div className={styles.sidebarDivider} />

            {/* ── Linked Cards ── */}
            <div className={styles.sidebarSection}>
              <div className={styles.sectionHeader}>
                <Link2 size={12} className={styles.sectionIcon} />
                <span className={styles.sectionTitle}>Linked Cards</span>
                <button className={styles.sectionAction} onClick={() => setShowLinkSearch(!showLinkSearch)}>
                  <Plus size={11} />
                </button>
              </div>
              {card.linkedCards.length > 0 ? (
                <div className={styles.sectionItems}>
                  {card.linkedCards.map((lc) => (
                    <div key={lc.linkId} className={styles.linkRow}>
                      <FileText size={12} className={styles.linkIcon} />
                      <Link to={`/cards/${lc.id}`} className={styles.linkName}>{lc.name}</Link>
                      <Tooltip label="Remove">
                        <button className={styles.linkRemove} onClick={() => unlinkCard(lc.linkId)} aria-label="Remove">
                          <X size={11} />
                        </button>
                      </Tooltip>
                    </div>
                  ))}
                </div>
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

            <div className={styles.sidebarDivider} />

            {/* ── Custom Fields ── */}
            <div className={styles.sidebarSection}>
              <div className={styles.sectionHeader}>
                <FileText size={12} className={styles.sectionIcon} />
                <span className={styles.sectionTitle}>Custom Fields</span>
                {!addingCf && (
                  <button
                    className={styles.sectionAction}
                    onClick={() => {
                      setAddingCf(true);
                      setEditingCfKey(null);
                      setTimeout(() => cfKeyInputRef.current?.focus(), 0);
                    }}
                  >
                    <Plus size={11} />
                  </button>
                )}
              </div>
              {cfEntries.length === 0 && !addingCf && (
                <span className={styles.panelEmpty}>No custom fields</span>
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

            {/* ── Dates ── */}
            <div className={styles.sidebarDivider} />
            <div className={styles.sidebarDates}>
              <div className={styles.dateRow}>
                <span className={styles.dateLabel}>Created</span>
                <TimeAgo date={card.createdAt} className={styles.dateValue} />
              </div>
              <div className={styles.dateRow}>
                <span className={styles.dateLabel}>Updated</span>
                <TimeAgo date={card.updatedAt} className={styles.dateValue} />
              </div>
            </div>
          </div>
        </div>
      </div>
      {stagedLightboxSrc && <ImageLightbox src={stagedLightboxSrc} alt="Preview" onClose={() => setStagedLightboxSrc(null)} />}
    </div>
  );
}
