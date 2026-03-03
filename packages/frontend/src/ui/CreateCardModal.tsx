import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Check, Search, FileText, FolderOpen, ChevronDown, CalendarDays, CheckCircle2, AlertCircle, Bookmark, BookmarkPlus, Trash2 } from 'lucide-react';
import { Button } from './Button';
import { Input } from './Input';
import { Textarea } from './Textarea';
import { Modal } from './Modal';
import { AgentAvatar } from '../components/AgentAvatar';
import { PriorityBadge } from '../components/PriorityBadge';
import { QuickDateButtons } from '../components/QuickDateButtons';
import type { Priority } from '../components/PriorityBadge';
import { api } from '../lib/api';
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

export interface CreateCardData {
  name: string;
  description: string | null;
  assigneeId: string | null;
  tagIds: string[];
  linkedCardIds: string[];
  collectionId?: string;
  dueDate?: string;
  priority?: Priority;
}

/* ── Card Templates ────────────────────────────────── */

interface CardTemplate {
  id: string;
  name: string;
  description: string;
  tagIds: string[];
  priority: Priority | null;
  assignToSelf: boolean;
}

const TEMPLATES_STORAGE_KEY = 'card-templates';

function loadTemplates(): CardTemplate[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveTemplates(templates: CardTemplate[]) {
  try { localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(templates)); } catch { /* ignore */ }
}

/* ── Component ─────────────────────────────────────── */

interface CreateCardModalProps {
  onClose: () => void;
  onSubmit: (data: CreateCardData) => Promise<void>;
  /** When true, shows a collection picker (for global quick-create) */
  showCollectionPicker?: boolean;
  /** When true, enables the "Create & Add Another" button */
  allowCreateAnother?: boolean;
  /** Pre-fill the due date field (YYYY-MM-DD) */
  defaultDueDate?: string;
  /** Pre-fill the card name */
  defaultName?: string;
  /** Pre-fill the card description */
  defaultDescription?: string;
}

export function CreateCardModal({ onClose, onSubmit, showCollectionPicker, allowCreateAnother = true, defaultDueDate, defaultName, defaultDescription }: CreateCardModalProps) {
  const { user: currentUser } = useAuth();
  const [name, setName] = useState(defaultName ?? '');
  const [description, setDescription] = useState(defaultDescription ?? '');
  const [dueDate, setDueDate] = useState(defaultDueDate ?? '');
  const [priority, setPriority] = useState<Priority | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Assignee
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [showAssigneeDropdown, setShowAssigneeDropdown] = useState(false);
  const assigneeRef = useRef<HTMLDivElement>(null);

  // Tags
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());

  // Collection (for global quick-create)
  const [collections, setCollections] = useState<CollectionEntry[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [showCollectionDropdown, setShowCollectionDropdown] = useState(false);
  const collectionRef = useRef<HTMLDivElement>(null);

  // Related cards
  const [linkSearch, setLinkSearch] = useState('');
  const [linkResults, setLinkResults] = useState<CardResult[]>([]);
  const [linkedCards, setLinkedCards] = useState<CardResult[]>([]);

  // Templates
  const [templates, setTemplates] = useState<CardTemplate[]>(loadTemplates);
  const [showTemplateDropdown, setShowTemplateDropdown] = useState(false);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const templateDropdownRef = useRef<HTMLDivElement>(null);
  const templateNameRef = useRef<HTMLInputElement>(null);

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
      if (assigneeRef.current && !assigneeRef.current.contains(e.target as Node)) {
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
      if (collectionRef.current && !collectionRef.current.contains(e.target as Node)) {
        setShowCollectionDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showCollectionDropdown]);

  // Close template dropdown on outside click
  useEffect(() => {
    if (!showTemplateDropdown) return;
    function handleClick(e: MouseEvent) {
      if (templateDropdownRef.current && !templateDropdownRef.current.contains(e.target as Node)) {
        setShowTemplateDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showTemplateDropdown]);

  // Focus template name input when shown
  useEffect(() => {
    if (showSaveTemplate) setTimeout(() => templateNameRef.current?.focus(), 0);
  }, [showSaveTemplate]);

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
    setDueDate('');
    setPriority(null);
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
        ...(dueDate ? { dueDate } : {}),
        ...(priority ? { priority } : {}),
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
  }, [name, description, dueDate, priority, submitting, onSubmit, assigneeId, selectedTagIds, linkedCards, showCollectionPicker, selectedCollectionId, resetForm]);

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

  /* ── Template handlers ────────────────────────────── */

  function handleApplyTemplate(template: CardTemplate) {
    setDescription(template.description);
    setPriority(template.priority);
    setSelectedTagIds(new Set(template.tagIds));
    if (template.assignToSelf && currentUser) {
      setAssigneeId(currentUser.id);
    }
    setShowTemplateDropdown(false);
    // Keep focus on name field so user can start typing
    nameRef.current?.focus();
  }

  function handleSaveTemplate() {
    const trimmedName = templateName.trim();
    if (!trimmedName) return;
    const template: CardTemplate = {
      id: Date.now().toString(36),
      name: trimmedName,
      description,
      tagIds: Array.from(selectedTagIds),
      priority,
      assignToSelf: assigneeId === currentUser?.id,
    };
    const updated = [...templates, template];
    setTemplates(updated);
    saveTemplates(updated);
    setTemplateName('');
    setShowSaveTemplate(false);
  }

  function handleDeleteTemplate(templateId: string) {
    const updated = templates.filter((t) => t.id !== templateId);
    setTemplates(updated);
    saveTemplates(updated);
  }

  // Resolve assignee display
  const selectedUser = users.find((u) => u.id === assigneeId);
  const selectedAgent = agents.find((a) => a.id === assigneeId);

  // Template summary for display
  function getTemplateSummary(template: CardTemplate): string {
    const parts: string[] = [];
    if (template.priority) parts.push(template.priority);
    if (template.tagIds.length > 0) {
      const tagNames = template.tagIds
        .map((id) => allTags.find((t) => t.id === id)?.name)
        .filter(Boolean);
      if (tagNames.length > 0) parts.push(tagNames.join(', '));
    }
    if (template.assignToSelf) parts.push('assign to me');
    if (template.description) parts.push('with description');
    return parts.length > 0 ? parts.join(' · ') : 'Empty template';
  }

  return (
    <Modal onClose={onClose} size="md" ariaLabel="New Card">
      <div className={styles.modal} onKeyDown={handleKeyDown}>
        <div className={styles.header}>
          <span className={styles.title}>New Card</span>
          <div className={styles.headerActions}>
            {/* Template buttons */}
            <div className={styles.templateContainer} ref={templateDropdownRef}>
              {templates.length > 0 && (
                <button
                  type="button"
                  className={styles.templateTrigger}
                  onClick={() => { setShowTemplateDropdown(!showTemplateDropdown); setShowSaveTemplate(false); }}
                  title="Use a template"
                >
                  <Bookmark size={14} />
                  <span>Templates</span>
                  <ChevronDown size={12} />
                </button>
              )}
              {templates.length === 0 && (
                <button
                  type="button"
                  className={styles.templateTrigger}
                  onClick={() => setShowSaveTemplate(!showSaveTemplate)}
                  title="Save current settings as template"
                >
                  <BookmarkPlus size={14} />
                  <span>Save template</span>
                </button>
              )}
              {showTemplateDropdown && (
                <div className={styles.templateDropdown}>
                  <div className={styles.templateDropdownHeader}>Templates</div>
                  {templates.map((tpl) => (
                    <div key={tpl.id} className={styles.templateItem}>
                      <button
                        type="button"
                        className={styles.templateItemBtn}
                        onClick={() => handleApplyTemplate(tpl)}
                      >
                        <Bookmark size={12} />
                        <div className={styles.templateItemContent}>
                          <span className={styles.templateItemName}>{tpl.name}</span>
                          <span className={styles.templateItemHint}>{getTemplateSummary(tpl)}</span>
                        </div>
                      </button>
                      <button
                        type="button"
                        className={styles.templateItemDelete}
                        onClick={() => handleDeleteTemplate(tpl.id)}
                        title="Delete template"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}
                  <div className={styles.templateDropdownDivider} />
                  {showSaveTemplate ? (
                    <div className={styles.templateSaveInline}>
                      <input
                        ref={templateNameRef}
                        className={styles.templateSaveInput}
                        value={templateName}
                        onChange={(e) => setTemplateName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleSaveTemplate(); if (e.key === 'Escape') setShowSaveTemplate(false); }}
                        placeholder="Template name..."
                      />
                      <button
                        type="button"
                        className={styles.templateSaveSubmit}
                        onClick={handleSaveTemplate}
                        disabled={!templateName.trim()}
                      >
                        Save
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={styles.templateAddBtn}
                      onClick={() => setShowSaveTemplate(true)}
                    >
                      <BookmarkPlus size={12} />
                      Save current as template
                    </button>
                  )}
                </div>
              )}
            </div>
            {templates.length > 0 && (
              <button
                type="button"
                className={styles.templateSaveIconBtn}
                onClick={() => {
                  setShowSaveTemplate(!showSaveTemplate);
                  setShowTemplateDropdown(false);
                }}
                title="Save current settings as template"
              >
                <BookmarkPlus size={14} />
              </button>
            )}
            <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Save template inline (when no dropdown is open) */}
        {showSaveTemplate && !showTemplateDropdown && (
          <div className={styles.templateSaveBanner}>
            <BookmarkPlus size={13} />
            <input
              ref={templateNameRef}
              className={styles.templateSaveBannerInput}
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveTemplate(); if (e.key === 'Escape') setShowSaveTemplate(false); }}
              placeholder="Template name..."
            />
            <button
              type="button"
              className={styles.templateSaveBannerBtn}
              onClick={handleSaveTemplate}
              disabled={!templateName.trim()}
            >
              Save
            </button>
            <button
              type="button"
              className={styles.templateSaveBannerCancel}
              onClick={() => { setShowSaveTemplate(false); setTemplateName(''); }}
            >
              <X size={12} />
            </button>
          </div>
        )}

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
                  <div className={styles.assigneeDropdown}>
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
                  </div>
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
          <Textarea
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add a brief description (optional)"
            rows={3}
          />

          {/* Due date */}
          <div className={styles.section}>
            <span className={styles.sectionLabel}>Due date</span>
            <div className={styles.dueDateField}>
              <CalendarDays size={14} className={styles.dueDateIcon} />
              <input
                type="date"
                className={styles.dueDateInput}
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                aria-label="Due date"
              />
              {dueDate && (
                <button
                  type="button"
                  className={styles.dueDateClear}
                  onClick={() => setDueDate('')}
                  aria-label="Clear due date"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <QuickDateButtons
              currentValue={dueDate}
              onSelect={setDueDate}
              size="md"
            />
          </div>

          {/* Priority */}
          <div className={styles.section}>
            <span className={styles.sectionLabel}>Priority</span>
            <PriorityBadge priority={priority} editable onChange={setPriority} size="md" />
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
                <div className={styles.assigneeDropdown}>
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
                </div>
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
