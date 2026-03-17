import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Check, Search, FileText, FolderOpen, ChevronDown, CheckCircle2, AlertCircle, Image } from 'lucide-react';
import { AnchoredOverlay } from './AnchoredOverlay';
import { Button } from './Button';
import { Input } from './Input';
import { Modal } from './Modal';
import { MarkdownContent } from './MarkdownContent';
import { AgentAvatar } from '../components/AgentAvatar';
import { ApiError, api, apiUpload } from '../lib/api';
import { getImagesFromClipboardData, getImagesFromFileList, prepareImageForUpload } from '../lib/image-upload';
import { useAuth } from '../stores/useAuth';
import styles from './CreateCardModal.module.css';

interface UserEntry { id: string; firstName: string; lastName: string }
interface AgentEntry {
  id: string; name: string; status: string;
  avatarIcon?: string; avatarBgColor?: string; avatarLogoColor?: string;
}
interface Tag { id: string; name: string; color: string }
interface CardResult { id: string; name: string }
interface CollectionEntry { id: string; name: string }
interface DescriptionImageUploadResponse {
  images: Array<{
    fileName: string;
    mimeType: string;
    fileSize: number;
    storagePath: string;
    markdown: string;
  }>;
}

export interface CreateCardData {
  name: string;
  description: string | null;
  assigneeId: string | null;
  tagIds: string[];
  linkedCardIds: string[];
  collectionId?: string;
}

/* ── Component ─────────────────────────────────────── */

interface CreateCardModalProps {
  onClose: () => void;
  onSubmit: (data: CreateCardData) => Promise<void>;
  /** When true, shows a collection picker (for global quick-create) */
  showCollectionPicker?: boolean;
  /** When true, enables the "Create & Add Another" button */
  allowCreateAnother?: boolean;
  /** Pre-fill the card name */
  defaultName?: string;
  /** Pre-fill the card description */
  defaultDescription?: string;
}

export function CreateCardModal({ onClose, onSubmit, showCollectionPicker, allowCreateAnother = true, defaultName, defaultDescription }: CreateCardModalProps) {
  const MAX_DESCRIPTION_IMAGES = 10;
  const { user: currentUser } = useAuth();
  const [name, setName] = useState(defaultName ?? '');
  const [description, setDescription] = useState(defaultDescription ?? '');
  const [descriptionPreview, setDescriptionPreview] = useState(false);
  const [uploadingDescriptionImages, setUploadingDescriptionImages] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const descriptionFileInputRef = useRef<HTMLInputElement>(null);
  const descriptionSelectionRef = useRef({ start: 0, end: 0 });

  // Assignee
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [showAssigneeDropdown, setShowAssigneeDropdown] = useState(false);
  const assigneeRef = useRef<HTMLDivElement>(null);
  const assigneeDropdownRef = useRef<HTMLDivElement>(null);

  // Tags
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());

  // Collection (for global quick-create)
  const [collections, setCollections] = useState<CollectionEntry[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [showCollectionDropdown, setShowCollectionDropdown] = useState(false);
  const collectionRef = useRef<HTMLDivElement>(null);
  const collectionDropdownRef = useRef<HTMLDivElement>(null);

  // Related cards
  const [linkSearch, setLinkSearch] = useState('');
  const [linkResults, setLinkResults] = useState<CardResult[]>([]);
  const [linkedCards, setLinkedCards] = useState<CardResult[]>([]);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Fetch users, agents, tags, and optionally collections on mount
  useEffect(() => {
    const fetches: Promise<unknown>[] = [
      api<{ entries: UserEntry[] }>('/users'),
      api<{ entries: AgentEntry[] }>('/agents?limit=100'),
      api<{ entries: Tag[] }>('/tags'),
    ];
    if (showCollectionPicker) {
      fetches.push(api<{ entries: CollectionEntry[] }>('/collections?limit=100'));
    }
    Promise.allSettled(fetches).then((results) => {
      const [usersRes, agentsRes, tagsRes, collectionsRes] = results;
      if (usersRes.status === 'fulfilled') {
        const fetchedUsers = (usersRes.value as { entries: UserEntry[] }).entries;
        setUsers(fetchedUsers);
        // Default assignee to the current user if they're in the list
        if (currentUser && fetchedUsers.some((u) => u.id === currentUser.id)) {
          setAssigneeId(currentUser.id);
        }
      }
      if (agentsRes.status === 'fulfilled')
        setAgents((agentsRes.value as { entries: AgentEntry[] }).entries.filter((a) => a.status === 'active'));
      if (tagsRes.status === 'fulfilled') setAllTags((tagsRes.value as { entries: Tag[] }).entries);
      if (collectionsRes?.status === 'fulfilled') {
        const cols = (collectionsRes.value as { entries: CollectionEntry[] }).entries;
        setCollections(cols);
        if (cols.length > 0) setSelectedCollectionId(cols[0].id);
      }
    });
  }, [showCollectionPicker, currentUser]);

  // Close assignee dropdown on outside click
  useEffect(() => {
    if (!showAssigneeDropdown) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        assigneeRef.current &&
        !assigneeRef.current.contains(target) &&
        !assigneeDropdownRef.current?.contains(target)
      ) {
        setShowAssigneeDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showAssigneeDropdown]);

  // Close collection dropdown on outside click
  useEffect(() => {
    if (!showCollectionDropdown) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        collectionRef.current &&
        !collectionRef.current.contains(target) &&
        !collectionDropdownRef.current?.contains(target)
      ) {
        setShowCollectionDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showCollectionDropdown]);

  // Search cards for linking
  useEffect(() => {
    if (linkSearch.length < 2) {
      setLinkResults([]);
      return;
    }
    const controller = new AbortController();
    api<{ entries: CardResult[] }>(
      `/cards?search=${encodeURIComponent(linkSearch)}&limit=10`,
      { signal: controller.signal },
    )
      .then((d) => {
        const linkedIds = new Set(linkedCards.map((c) => c.id));
        setLinkResults(d.entries.filter((c) => !linkedIds.has(c.id)));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [linkSearch, linkedCards]);

  const canSubmit = name.trim() && !submitting && (!showCollectionPicker || selectedCollectionId);

  const resetForm = useCallback(() => {
    setName('');
    setDescription('');
    setDescriptionPreview(false);
    setSelectedTagIds(new Set());
    setLinkedCards([]);
    setLinkSearch('');
    setLinkResults([]);
    // Keep assigneeId and selectedCollectionId so the user doesn't have to re-pick them
    nameRef.current?.focus();
  }, []);

  const doSubmit = useCallback(async (keepOpen: boolean) => {
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    if (showCollectionPicker && !selectedCollectionId) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit({
        name: trimmed,
        description: description.trim() || null,
        assigneeId,
        tagIds: Array.from(selectedTagIds),
        linkedCardIds: linkedCards.map((c) => c.id),
        ...(showCollectionPicker && selectedCollectionId ? { collectionId: selectedCollectionId } : {}),
      });
      if (keepOpen) {
        setJustCreated(trimmed);
        resetForm();
        setTimeout(() => setJustCreated(null), 2500);
      } else {
        onClose();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create card';
      setSubmitError(message);
    } finally {
      setSubmitting(false);
    }
  }, [name, description, submitting, onSubmit, assigneeId, selectedTagIds, linkedCards, showCollectionPicker, selectedCollectionId, resetForm]);

  const handleSubmit = useCallback(() => doSubmit(false), [doSubmit]);
  const handleSubmitAndNew = useCallback(() => doSubmit(true), [doSubmit]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (e.shiftKey && allowCreateAnother) {
        void handleSubmitAndNew();
      } else {
        void handleSubmit();
      }
    }
  }

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }

  function addLinkedCard(card: CardResult) {
    setLinkedCards((prev) => [...prev, card]);
    setLinkSearch('');
    setLinkResults([]);
  }

  function removeLinkedCard(cardId: string) {
    setLinkedCards((prev) => prev.filter((c) => c.id !== cardId));
  }

  function updateDescriptionDraft(nextText: string, selection?: { start: number; end: number }) {
    setDescription(nextText);
    if (!selection) return;
    requestAnimationFrame(() => {
      const textarea = descriptionRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(selection.start, selection.end);
      descriptionSelectionRef.current = selection;
    });
  }

  function insertDescriptionText(textToInsert: string) {
    const start = descriptionSelectionRef.current.start;
    const end = descriptionSelectionRef.current.end;
    const currentText = descriptionRef.current?.value ?? description;
    const nextText = `${currentText.slice(0, start)}${textToInsert}${currentText.slice(end)}`;
    const cursor = start + textToInsert.length;
    updateDescriptionDraft(nextText, { start: cursor, end: cursor });
  }

  async function uploadDescriptionImages(files: File[]) {
    if (files.length === 0) return;
    setUploadingDescriptionImages(true);
    setSubmitError(null);
    try {
      const formData = new FormData();
      for (const file of files.slice(0, MAX_DESCRIPTION_IMAGES)) {
        const prepared = await prepareImageForUpload(file);
        formData.append('files', prepared, prepared.name);
      }
      const response = await apiUpload<DescriptionImageUploadResponse>('/cards/description/images/upload', formData);
      const snippet = response.images.map((image) => image.markdown).join('\n\n');
      if (snippet) insertDescriptionText(snippet);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to upload images';
      setSubmitError(message);
    } finally {
      setUploadingDescriptionImages(false);
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

  // Resolve assignee display
  const selectedUser = users.find((u) => u.id === assigneeId);
  const selectedAgent = agents.find((a) => a.id === assigneeId);

  return (
    <Modal onClose={onClose} size="md" ariaLabel="New Card">
      <div className={styles.modal} onKeyDown={handleKeyDown}>
        <div className={styles.header}>
          <span className={styles.title}>New Card</span>
          <div className={styles.headerActions}>
            <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className={styles.fields}>
          {showCollectionPicker && (
            <div className={styles.section}>
              <span className={styles.sectionLabel}>Collection</span>
              <div className={styles.assigneeSelect} ref={collectionRef}>
                <button
                  type="button"
                  className={styles.assigneeTrigger}
                  onClick={() => setShowCollectionDropdown(!showCollectionDropdown)}
                >
                  {selectedCollectionId ? (
                    <>
                      <FolderOpen size={14} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
                      {collections.find((c) => c.id === selectedCollectionId)?.name ?? 'Select...'}
                    </>
                  ) : (
                    <span className={styles.assigneePlaceholder}>Select collection...</span>
                  )}
                  <ChevronDown size={14} style={{ marginLeft: 'auto', color: 'var(--color-text-tertiary)' }} />
                </button>
                {showCollectionDropdown && (
                  <AnchoredOverlay
                    ref={collectionDropdownRef}
                    anchorRef={collectionRef}
                    className={styles.assigneeDropdown}
                    matchAnchorWidth
                  >
                    {collections.map((col) => (
                      <button
                        key={col.id}
                        className={`${styles.assigneeOption}${selectedCollectionId === col.id ? ` ${styles.assigneeOptionActive}` : ''}`}
                        onClick={() => { setSelectedCollectionId(col.id); setShowCollectionDropdown(false); }}
                      >
                        <FolderOpen size={14} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
                        {col.name}
                        {selectedCollectionId === col.id && <Check size={12} className={styles.assigneeCheck} />}
                      </button>
                    ))}
                    {collections.length === 0 && (
                      <div className={styles.searchEmpty}>No collections found</div>
                    )}
                  </AnchoredOverlay>
                )}
              </div>
            </div>
          )}

          <Input
            ref={nameRef}
            label="Name"
            value={name}
            onChange={(e) => { setName(e.target.value); setSubmitError(null); }}
            placeholder="Card name"
          />
          <div className={styles.section}>
            <div className={styles.descriptionHeader}>
              <span className={styles.sectionLabel}>Description</span>
              <div className={styles.descriptionTabs}>
                <button
                  type="button"
                  className={`${styles.descriptionTab}${!descriptionPreview ? ` ${styles.descriptionTabActive}` : ''}`}
                  onClick={() => setDescriptionPreview(false)}
                >
                  Write
                </button>
                <button
                  type="button"
                  className={`${styles.descriptionTab}${descriptionPreview ? ` ${styles.descriptionTabActive}` : ''}`}
                  onClick={() => setDescriptionPreview(true)}
                >
                  Preview
                </button>
              </div>
            </div>
            <input
              ref={descriptionFileInputRef}
              type="file"
              accept="image/*"
              multiple
              className={styles.hiddenFileInput}
              onChange={handleDescriptionFileSelect}
            />
            {descriptionPreview ? (
              <div className={styles.descriptionPreview}>
                {description.trim() ? (
                  <MarkdownContent>{description}</MarkdownContent>
                ) : (
                  <span className={styles.descriptionPreviewEmpty}>Nothing to preview</span>
                )}
              </div>
            ) : (
              <textarea
                ref={descriptionRef}
                className={styles.descriptionTextarea}
                value={description}
                onChange={(e) => {
                  descriptionSelectionRef.current = {
                    start: e.currentTarget.selectionStart,
                    end: e.currentTarget.selectionEnd,
                  };
                  setDescription(e.target.value);
                  setSubmitError(null);
                }}
                onPaste={handleDescriptionPaste}
                onSelect={(e) => {
                  descriptionSelectionRef.current = {
                    start: e.currentTarget.selectionStart,
                    end: e.currentTarget.selectionEnd,
                  };
                }}
                onBlur={(e) => {
                  descriptionSelectionRef.current = {
                    start: e.currentTarget.selectionStart,
                    end: e.currentTarget.selectionEnd,
                  };
                }}
                placeholder="Add a description... Markdown supported."
                rows={6}
                disabled={uploadingDescriptionImages}
              />
            )}
            <div className={styles.descriptionActions}>
              <span className={styles.descriptionHint}>
                {uploadingDescriptionImages ? 'Uploading images...' : 'Paste or attach images. Markdown preview is live.'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => descriptionFileInputRef.current?.click()}
                disabled={uploadingDescriptionImages}
              >
                <Image size={14} />
                {uploadingDescriptionImages ? 'Uploading...' : 'Insert images'}
              </Button>
            </div>
          </div>

          {/* Assignee */}
          <div className={styles.section}>
            <span className={styles.sectionLabel}>Assignee</span>
            <div className={styles.assigneeSelect} ref={assigneeRef}>
              <button
                type="button"
                className={styles.assigneeTrigger}
                onClick={() => setShowAssigneeDropdown(!showAssigneeDropdown)}
              >
                {selectedUser ? (
                  <>
                    <span className={styles.assigneeAvatar}>
                      {selectedUser.firstName[0]}{selectedUser.lastName[0]}
                    </span>
                    {selectedUser.firstName} {selectedUser.lastName}
                    {selectedUser.id === currentUser?.id && (
                      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginLeft: 2 }}>(you)</span>
                    )}
                  </>
                ) : selectedAgent ? (
                  <>
                    <AgentAvatar
                      icon={selectedAgent.avatarIcon || 'spark'}
                      bgColor={selectedAgent.avatarBgColor || '#1a1a2e'}
                      logoColor={selectedAgent.avatarLogoColor || '#e94560'}
                      size={20}
                    />
                    {selectedAgent.name}
                  </>
                ) : (
                  <span className={styles.assigneePlaceholder}>Select assignee...</span>
                )}
              </button>
              {showAssigneeDropdown && (
                <AnchoredOverlay
                  ref={assigneeDropdownRef}
                  anchorRef={assigneeRef}
                  className={styles.assigneeDropdown}
                  matchAnchorWidth
                >
                  {assigneeId && (
                    <button
                      className={styles.assigneeOption}
                      onClick={() => { setAssigneeId(null); setShowAssigneeDropdown(false); }}
                    >
                      <X size={12} /> Unassign
                    </button>
                  )}
                  {agents.length > 0 && (
                    <>
                      <div className={styles.assigneeDivider}>Agents</div>
                      {agents.map((a) => (
                        <button
                          key={a.id}
                          className={`${styles.assigneeOption}${assigneeId === a.id ? ` ${styles.assigneeOptionActive}` : ''}`}
                          onClick={() => { setAssigneeId(a.id); setShowAssigneeDropdown(false); }}
                        >
                          <AgentAvatar
                            icon={a.avatarIcon || 'spark'}
                            bgColor={a.avatarBgColor || '#1a1a2e'}
                            logoColor={a.avatarLogoColor || '#e94560'}
                            size={20}
                          />
                          {a.name}
                          {assigneeId === a.id && <Check size={12} className={styles.assigneeCheck} />}
                        </button>
                      ))}
                    </>
                  )}
                  {users.length > 0 && (
                    <>
                      <div className={styles.assigneeDivider}>Users</div>
                      {[
                        // Current user first, then everyone else
                        ...users.filter((u) => u.id === currentUser?.id),
                        ...users.filter((u) => u.id !== currentUser?.id),
                      ].map((u) => (
                        <button
                          key={u.id}
                          className={`${styles.assigneeOption}${assigneeId === u.id ? ` ${styles.assigneeOptionActive}` : ''}`}
                          onClick={() => { setAssigneeId(u.id); setShowAssigneeDropdown(false); }}
                        >
                          <span className={styles.assigneeAvatar}>
                            {u.firstName[0]}{u.lastName[0]}
                          </span>
                          {u.firstName} {u.lastName}
                          {u.id === currentUser?.id && (
                            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginLeft: 2 }}>(you)</span>
                          )}
                          {assigneeId === u.id && <Check size={12} className={styles.assigneeCheck} />}
                        </button>
                      ))}
                    </>
                  )}
                </AnchoredOverlay>
              )}
            </div>
          </div>

          {/* Tags */}
          {allTags.length > 0 && (
            <div className={styles.section}>
              <span className={styles.sectionLabel}>Tags</span>
              <div className={styles.tagsList}>
                {allTags.map((tag) => {
                  const selected = selectedTagIds.has(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      className={`${styles.tagPill}${selected ? ` ${styles.tagPillSelected}` : ''}`}
                      style={{ '--tag-color': tag.color } as React.CSSProperties}
                      onClick={() => toggleTag(tag.id)}
                    >
                      {selected && <Check size={11} className={styles.tagPillCheck} />}
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Related Cards */}
          <div className={styles.section}>
            <span className={styles.sectionLabel}>Related Cards</span>
            <div style={{ position: 'relative' }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--color-text-tertiary)', pointerEvents: 'none' }} />
              <input
                className={styles.searchInput}
                style={{ paddingLeft: 30 }}
                placeholder="Search cards..."
                value={linkSearch}
                onChange={(e) => setLinkSearch(e.target.value)}
              />
            </div>
            {linkResults.length > 0 && (
              <div className={styles.searchResults}>
                {linkResults.map((c) => (
                  <button
                    key={c.id}
                    className={styles.searchResultItem}
                    onClick={() => addLinkedCard(c)}
                  >
                    <FileText size={13} />
                    {c.name}
                  </button>
                ))}
              </div>
            )}
            {linkSearch.length >= 2 && linkResults.length === 0 && (
              <div className={styles.searchEmpty}>No cards found</div>
            )}
            {linkedCards.length > 0 && (
              <div className={styles.selectedCards}>
                {linkedCards.map((c) => (
                  <div key={c.id} className={styles.selectedCard}>
                    <FileText size={13} style={{ flexShrink: 0, color: 'var(--color-text-tertiary)' }} />
                    <span className={styles.selectedCardName}>{c.name}</span>
                    <button
                      type="button"
                      className={styles.selectedCardRemove}
                      onClick={() => removeLinkedCard(c.id)}
                      aria-label="Remove"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {submitError && (
          <div className={styles.errorBanner}>
            <AlertCircle size={14} />
            <span>{submitError}</span>
            <button
              type="button"
              className={styles.errorBannerDismiss}
              onClick={() => setSubmitError(null)}
              aria-label="Dismiss"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {justCreated && (
          <div className={styles.justCreatedBanner}>
            <CheckCircle2 size={14} />
            <span>Created &ldquo;{justCreated}&rdquo;</span>
          </div>
        )}

        <div className={styles.actions}>
          <span className={styles.hint}>
            <kbd className={styles.kbd}>{navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}</kbd>
            <kbd className={styles.kbd}>Enter</kbd>
          </span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {allowCreateAnother && (
            <Button variant="secondary" onClick={() => void handleSubmitAndNew()} disabled={!canSubmit}>
              {submitting ? 'Creating...' : 'Create & New'}
            </Button>
          )}
          <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {submitting ? 'Creating...' : 'Create'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
