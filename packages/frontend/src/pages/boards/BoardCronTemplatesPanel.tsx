import { useState, useEffect, useCallback } from 'react';
import { X, Plus, Pencil, Trash2, Clock, Check } from 'lucide-react';
import { formatDate } from 'shared';
import { Button } from '../../ui';
import { Input } from '../../ui/Input';
import { Textarea } from '../../ui/Textarea';
import { CronEditor } from '../../ui/CronEditor';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../stores/toast';
import styles from './BoardCronTemplatesPanel.module.css';

interface BoardColumn {
  id: string;
  name: string;
  color: string;
  position: number;
}

interface Tag {
  id: string;
  name: string;
  color: string;
}

interface CronTemplate {
  id: string;
  boardId: string;
  columnId: string;
  name: string;
  description: string | null;
  assigneeId: string | null;
  tagIds: string[];
  cron: string;
  enabled: boolean;
  nextRunAt?: string | null;
  createdAt: string;
}

interface UserEntry { id: string; firstName: string; lastName: string }
interface AgentEntry {
  id: string; name: string; status: string;
  avatarIcon?: string; avatarBgColor?: string; avatarLogoColor?: string;
}

interface BoardCronTemplatesPanelProps {
  boardId: string;
  columns: BoardColumn[];
  onClose: () => void;
}

function describeTemplateNextRun(template: Pick<CronTemplate, 'enabled' | 'nextRunAt'>): string {
  if (!template.enabled) return 'Next trigger disabled';
  if (!template.nextRunAt) return 'Next trigger unavailable';
  return `Next trigger ${formatDate(template.nextRunAt)}`;
}

export function BoardCronTemplatesPanel({ boardId, columns, onClose }: BoardCronTemplatesPanelProps) {
  const [templates, setTemplates] = useState<CronTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formColumnId, setFormColumnId] = useState(columns[0]?.id ?? '');
  const [formAssigneeId, setFormAssigneeId] = useState<string | null>(null);
  const [formTagIds, setFormTagIds] = useState<Set<string>>(new Set());
  const [formCron, setFormCron] = useState('0 9 * * 1');
  const [formEnabled, setFormEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Lookups
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [agents, setAgents] = useState<AgentEntry[]>([]);

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await api<{ entries: CronTemplate[] }>(`/boards/${boardId}/cron-templates`);
      setTemplates(res.entries);
    } catch {
      toast.error('Failed to load cron templates');
    } finally {
      setLoading(false);
    }
  }, [boardId]);

  useEffect(() => {
    fetchTemplates();
    Promise.allSettled([
      api<{ entries: Tag[] }>('/tags'),
      api<{ entries: UserEntry[] }>('/users'),
      api<{ entries: AgentEntry[] }>('/agents?limit=100'),
    ]).then(([tagsRes, usersRes, agentsRes]) => {
      if (tagsRes.status === 'fulfilled') setAllTags(tagsRes.value.entries);
      if (usersRes.status === 'fulfilled') setUsers(usersRes.value.entries);
      if (agentsRes.status === 'fulfilled') setAgents(agentsRes.value.entries.filter((a) => a.status === 'active'));
    });
  }, [fetchTemplates]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function resetForm() {
    setFormName('');
    setFormDescription('');
    setFormColumnId(columns[0]?.id ?? '');
    setFormAssigneeId(null);
    setFormTagIds(new Set());
    setFormCron('0 9 * * 1');
    setFormEnabled(true);
    setEditingId(null);
    setShowForm(false);
  }

  function startEdit(t: CronTemplate) {
    setFormName(t.name);
    setFormDescription(t.description ?? '');
    setFormColumnId(t.columnId);
    setFormAssigneeId(t.assigneeId);
    setFormTagIds(new Set(t.tagIds));
    setFormCron(t.cron);
    setFormEnabled(t.enabled);
    setEditingId(t.id);
    setShowForm(true);
  }

  async function handleSubmit() {
    const trimmed = formName.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);

    try {
      const body = {
        columnId: formColumnId,
        name: trimmed,
        description: formDescription.trim() || null,
        assigneeId: formAssigneeId,
        tagIds: Array.from(formTagIds),
        cron: formCron,
        enabled: formEnabled,
      };

      if (editingId) {
        await api(`/boards/${boardId}/cron-templates/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        toast.success('Template updated');
      } else {
        await api(`/boards/${boardId}/cron-templates`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        toast.success('Template created');
      }

      resetForm();
      fetchTemplates();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to save template');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggle(t: CronTemplate) {
    try {
      const updated = await api<CronTemplate>(`/boards/${boardId}/cron-templates/${t.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !t.enabled }),
      });
      setTemplates((prev) =>
        prev.map((item) => (item.id === t.id ? updated : item)),
      );
    } catch {
      toast.error('Failed to toggle template');
    }
  }

  async function handleDelete(t: CronTemplate) {
    try {
      await api(`/boards/${boardId}/cron-templates/${t.id}`, { method: 'DELETE' });
      setTemplates((prev) => prev.filter((item) => item.id !== t.id));
      if (editingId === t.id) resetForm();
      toast.success('Template deleted');
    } catch {
      toast.error('Failed to delete template');
    }
  }

  function toggleTag(tagId: string) {
    setFormTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }

  const sortedColumns = [...columns].sort((a, b) => a.position - b.position);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>Scheduled Cards</span>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className={styles.body}>
          {!showForm && (
            <Button onClick={() => { resetForm(); setShowForm(true); }}>
              <Plus size={14} />
              Add Template
            </Button>
          )}

          {showForm && (
            <div className={styles.form}>
              <span className={styles.formTitle}>{editingId ? 'Edit Template' : 'New Template'}</span>

              <div className={styles.formField}>
                <span className={styles.formLabel}>Name</span>
                <Input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="Card name"
                />
              </div>

              <div className={styles.formField}>
                <span className={styles.formLabel}>Description</span>
                <Textarea
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="Optional description"
                  rows={2}
                />
              </div>

              <div className={styles.formField}>
                <span className={styles.formLabel}>Column</span>
                <select
                  className={styles.selectInput}
                  value={formColumnId}
                  onChange={(e) => setFormColumnId(e.target.value)}
                >
                  {sortedColumns.map((col) => (
                    <option key={col.id} value={col.id}>{col.name}</option>
                  ))}
                </select>
              </div>

              <div className={styles.formField}>
                <span className={styles.formLabel}>Assignee</span>
                <select
                  className={styles.selectInput}
                  value={formAssigneeId ?? ''}
                  onChange={(e) => setFormAssigneeId(e.target.value || null)}
                >
                  <option value="">None</option>
                  {agents.length > 0 && (
                    <optgroup label="Agents">
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </optgroup>
                  )}
                  {users.length > 0 && (
                    <optgroup label="Users">
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>

              {allTags.length > 0 && (
                <div className={styles.formField}>
                  <span className={styles.formLabel}>Tags</span>
                  <div className={styles.tagsList}>
                    {allTags.map((tag) => {
                      const selected = formTagIds.has(tag.id);
                      return (
                        <button
                          key={tag.id}
                          type="button"
                          className={`${styles.tagPill}${selected ? ` ${styles.tagPillSelected}` : ''}`}
                          style={{ '--tag-color': tag.color } as React.CSSProperties}
                          onClick={() => toggleTag(tag.id)}
                        >
                          {selected && <Check size={11} />}
                          {tag.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className={styles.formField}>
                <span className={styles.formLabel}>Schedule</span>
                <CronEditor value={formCron} onChange={setFormCron} />
              </div>

              <div className={styles.formField}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <button
                    type="button"
                    className={`${styles.toggle}${formEnabled ? ` ${styles.toggleOn}` : ''}`}
                    onClick={() => setFormEnabled(!formEnabled)}
                  >
                    <span className={styles.toggleKnob} />
                  </button>
                  <span className={styles.formLabel} style={{ margin: 0 }}>Enabled</span>
                </label>
              </div>

              <div className={styles.formActions}>
                <Button variant="ghost" onClick={resetForm}>Cancel</Button>
                <Button onClick={() => void handleSubmit()} disabled={submitting || !formName.trim()}>
                  {submitting ? 'Saving...' : editingId ? 'Update' : 'Create'}
                </Button>
              </div>
            </div>
          )}

          {loading ? (
            <div className={styles.empty}>Loading...</div>
          ) : templates.length === 0 && !showForm ? (
            <div className={styles.empty}>
              <Clock size={24} />
              No scheduled card templates yet.
              <br />
              Create one to auto-generate cards on a schedule.
            </div>
          ) : (
            templates.map((t) => {
              const col = columns.find((c) => c.id === t.columnId);
              return (
                <div key={t.id} className={styles.templateItem}>
                  <div className={styles.templateInfo}>
                    <div className={styles.templateName}>{t.name}</div>
                    <div className={styles.templateMeta}>
                      {t.cron} &middot; {col?.name ?? 'Unknown column'}
                    </div>
                    <div className={styles.templateNextRun}>{describeTemplateNextRun(t)}</div>
                  </div>
                  <div className={styles.templateActions}>
                    <button
                      type="button"
                      className={`${styles.toggle}${t.enabled ? ` ${styles.toggleOn}` : ''}`}
                      onClick={() => void handleToggle(t)}
                      title={t.enabled ? 'Disable' : 'Enable'}
                    >
                      <span className={styles.toggleKnob} />
                    </button>
                    <button
                      className={styles.iconBtn}
                      onClick={() => startEdit(t)}
                      title="Edit"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      onClick={() => void handleDelete(t)}
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
