import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  X, ExternalLink, User, Send, Columns3, FileText,
  Link2, MessageSquare, ChevronDown, Pencil, Check, Trash2, Loader2, UserPlus,
  ChevronLeft, ChevronRight, Copy, Image,
} from 'lucide-react';
import { Button, MarkdownContent, Tooltip } from '../../ui';
import { AgentAvatar } from '../../components/AgentAvatar';
import { api, apiUpload, ApiError } from '../../lib/api';
import { toast } from '../../stores/toast';
import { getImagesFromClipboardData, getImagesFromFileList, prepareImageForUpload } from '../../lib/image-upload';
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

function CommentImage({ storagePath, alt }: { storagePath: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);

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
  return <img className={styles.commentImage} src={src} alt={alt} />;
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
  const [uploadingDescImages, setUploadingDescImages] = useState(false);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editCommentDraft, setEditCommentDraft] = useState('');
  const [savingEditComment, setSavingEditComment] = useState(false);
  const [showAssignee, setShowAssignee] = useState(false);
  const [assigneeUsers, setAssigneeUsers] = useState<UserEntry[]>([]);
  const [assigneeAgents, setAssigneeAgents] = useState<AgentListEntry[]>([]);
  const [loadingAssignees, setLoadingAssignees] = useState(false);
  const [stagedImages, setStagedImages] = useState<{ file: File; previewUrl: string }[]>([]);
  const [uploadingImages, setUploadingImages] = useState(false);
  const commentFileInputRef = useRef<HTMLInputElement>(null);
  const MAX_COMMENT_IMAGES = 10;
  const cancelTitleEditRef = useRef(false);
  const assigneeDropdownRef = useRef<HTMLDivElement>(null);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const descTextareaRef = useRef<HTMLTextAreaElement>(null);
  const descFileInputRef = useRef<HTMLInputElement>(null);
  const descSelectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });

  const [linkCopied, setLinkCopied] = useState(false);

  function copyCardLink() {
    const url = `${window.location.origin}/cards/${cardId}`;
    navigator.clipboard.writeText(url).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    });
  }

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
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, editingTitle, editingDesc, editingCommentId, showAssignee, hasNext, hasPrev, navigateNext, navigatePrev]);

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

  async function addComment() {
    if (!newComment.trim() && stagedImages.length === 0) return;
    setSubmitting(true);
    try {
      if (stagedImages.length > 0) {
        setUploadingImages(true);
        const fd = new FormData();
        if (newComment.trim()) fd.append('caption', newComment.trim());
        for (const staged of stagedImages) {
          const prepared = await prepareImageForUpload(staged.file);
          fd.append('files', prepared, prepared.name);
        }
        await apiUpload(`/cards/${cardId}/comments/upload`, fd);
        clearStagedImages();
      } else {
        await api(`/cards/${cardId}/comments`, {
          method: 'POST',
          body: JSON.stringify({ content: newComment.trim() }),
        });
      }
      setNewComment('');
      if (commentInputRef.current) commentInputRef.current.style.height = '';
      fetchComments();
    } catch (e) {
      if (e instanceof ApiError) toast.error(e.message);
    } finally {
      setSubmitting(false);
      setUploadingImages(false);
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
    setTimeout(() => {
      const ta = descTextareaRef.current;
      if (!ta) return;
      ta.focus();
      descSelectionRef.current = { start: ta.selectionStart, end: ta.selectionEnd };
    }, 0);
  }

  function updateDescriptionDraft(nextText: string, selection?: { start: number; end: number }) {
    setDescDraft(nextText);
    requestAnimationFrame(() => {
      const ta = descTextareaRef.current;
      if (!ta || !selection) return;
      ta.focus();
      ta.setSelectionRange(selection.start, selection.end);
      descSelectionRef.current = selection;
    });
  }

  function insertDescriptionText(textToInsert: string) {
    const start = descSelectionRef.current.start;
    const end = descSelectionRef.current.end;
    const currentText = descTextareaRef.current?.value ?? descDraft;
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
      else toast.error('Failed to upload images');
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
            {/* Title */}
            <div className={styles.titleArea}>
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
                      <h2 className={styles.title}>{card.name}</h2>
                      <span className={styles.titleEditHint}>
                        <Pencil size={12} />
                      </span>
                    </div>
                  )}
                </div>

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
            {/* Description */}
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Description</div>
              {editingDesc ? (
                <div className={styles.descEditWrap}>
                  <input
                    ref={descFileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className={styles.commentHiddenFileInput}
                    onChange={handleDescriptionFileSelect}
                  />
                  <textarea
                    ref={descTextareaRef}
                    className={styles.descTextarea}
                    value={descDraft}
                    onChange={(e) => {
                      descSelectionRef.current = {
                        start: e.currentTarget.selectionStart,
                        end: e.currentTarget.selectionEnd,
                      };
                      setDescDraft(e.target.value);
                    }}
                    onPaste={handleDescriptionPaste}
                    placeholder="Write a description... (Markdown supported)"
                    disabled={savingDesc || uploadingDescImages}
                    onSelect={(e) => {
                      descSelectionRef.current = {
                        start: e.currentTarget.selectionStart,
                        end: e.currentTarget.selectionEnd,
                      };
                    }}
                    onBlur={(e) => {
                      descSelectionRef.current = {
                        start: e.currentTarget.selectionStart,
                        end: e.currentTarget.selectionEnd,
                      };
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setEditingDesc(false);
                    }}
                    rows={4}
                  />
                  <div className={styles.descActions}>
                    <Tooltip label={uploadingDescImages ? 'Uploading images...' : 'Insert images'}>
                      <button
                        type="button"
                        className={styles.commentAttachBtn}
                        onClick={() => descFileInputRef.current?.click()}
                        disabled={savingDesc || uploadingDescImages}
                        aria-label="Insert images"
                      >
                        <Image size={14} />
                      </button>
                    </Tooltip>
                    <Button variant="ghost" size="sm" onClick={() => setEditingDesc(false)} disabled={savingDesc || uploadingDescImages}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={saveDesc} disabled={savingDesc || uploadingDescImages}>
                      <Check size={14} />
                      {uploadingDescImages ? 'Uploading...' : savingDesc ? 'Saving...' : 'Save'}
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
                          <>
                            {c.attachments && c.attachments.length > 0 && (
                              <div className={styles.commentImages}>
                                {c.attachments.map((att, i) => (
                                  <CommentImage key={i} storagePath={att.storagePath} alt={att.fileName} />
                                ))}
                              </div>
                            )}
                            {c.content && (
                              <div className={styles.commentContent}>
                                <MarkdownContent compact>{c.content}</MarkdownContent>
                              </div>
                            )}
                          </>
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
                {uploadingImages && <div className={styles.commentUploadingIndicator}>Uploading images…</div>}
                {stagedImages.length > 0 && (
                  <div className={styles.commentStagedImagesRow}>
                    {stagedImages.map((img, i) => (
                      <div key={img.previewUrl} className={styles.commentStagedImagePreview}>
                        <img src={img.previewUrl} alt="Preview" className={styles.commentStagedImageThumb} />
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
                      <Image size={13} />
                    </button>
                  </Tooltip>
                  <textarea
                    ref={commentInputRef}
                    className={styles.commentInput}
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
                  <Tooltip label="Send (Cmd+Enter)">
                    <button
                      className={styles.commentSend}
                      onClick={addComment}
                      disabled={(!newComment.trim() && stagedImages.length === 0) || submitting}
                    >
                      <Send size={13} />
                    </button>
                  </Tooltip>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
