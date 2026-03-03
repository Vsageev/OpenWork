import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Pencil, Plus, Tag, Trash2, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../stores/toast';
import { useConfirm } from '../../hooks/useConfirm';
import styles from './TagsTab.module.css';

interface TagEntry {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  cardCount?: number;
}

const DEFAULT_COLORS = [
  '#EF4444', '#F97316', '#F59E0B', '#EAB308',
  '#84CC16', '#22C55E', '#10B981', '#14B8A6',
  '#06B6D4', '#3B82F6', '#6366F1', '#8B5CF6',
  '#A855F7', '#EC4899', '#6B7280', '#1a1a2e',
];

function ColorSwatch({ color, selected, onClick }: { color: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`${styles.colorSwatch}${selected ? ` ${styles.colorSwatchSelected}` : ''}`}
      style={{ background: color }}
      onClick={onClick}
      title={color}
      aria-label={`Color ${color}`}
    >
      {selected && <Check size={10} strokeWidth={3} color="#fff" />}
    </button>
  );
}

function TagForm({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial: { name: string; color: string };
  onSave: (name: string, color: string) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState(initial.color);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave(trimmed, color);
  }

  return (
    <form className={styles.tagForm} onSubmit={handleSubmit}>
      <div className={styles.tagFormPreview}>
        <span className={styles.tagPill} style={{ background: color }}>
          {name.trim() || 'Preview'}
        </span>
      </div>
      <input
        ref={nameRef}
        className={styles.tagFormInput}
        type="text"
        placeholder="Tag name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={100}
      />
      <div className={styles.colorGrid}>
        {DEFAULT_COLORS.map((c) => (
          <ColorSwatch key={c} color={c} selected={color === c} onClick={() => setColor(c)} />
        ))}
        <div className={styles.customColorWrap}>
          <input
            type="color"
            className={styles.customColorInput}
            value={color}
            onChange={(e) => setColor(e.target.value)}
            title="Custom color"
          />
          <span className={styles.customColorLabel}>Custom</span>
        </div>
      </div>
      <div className={styles.tagFormActions}>
        <button type="button" className={styles.cancelBtn} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={styles.saveBtn} disabled={!name.trim() || saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

export function TagsTab() {
  const [tags, setTags] = useState<TagEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();

  const fetchTags = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api<{ entries: TagEntry[] }>('/tags');
      setTags(data.entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load tags');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTags();
  }, [fetchTags]);

  async function handleCreate(name: string, color: string) {
    setSaving(true);
    try {
      const newTag = await api<TagEntry>('/tags', {
        method: 'POST',
        body: JSON.stringify({ name, color }),
      });
      setTags((prev) => [newTag, ...prev]);
      setCreating(false);
      toast.success(`Tag "${name}" created`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to create tag');
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdate(id: string, name: string, color: string) {
    setSaving(true);
    try {
      const updated = await api<TagEntry>(`/tags/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, color }),
      });
      setTags((prev) => prev.map((t) => (t.id === id ? updated : t)));
      setEditingId(null);
      toast.success(`Tag updated`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to update tag');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(tag: TagEntry) {
    const confirmed = await confirm({
      title: 'Delete tag',
      message: `Remove "${tag.name}" from all cards? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      await api(`/tags/${tag.id}`, { method: 'DELETE' });
      setTags((prev) => prev.filter((t) => t.id !== tag.id));
      toast.success(`Tag "${tag.name}" deleted`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to delete tag');
    }
  }

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loadingRows}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={styles.skeletonRow} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {confirmDialog}
      <div className={styles.header}>
        <div>
          <h3 className={styles.sectionTitle}>Tags</h3>
          <p className={styles.sectionDesc}>
            Manage labels used to categorize cards across collections and boards.
          </p>
        </div>
        {!creating && (
          <button
            className={styles.addBtn}
            onClick={() => { setCreating(true); setEditingId(null); }}
          >
            <Plus size={14} />
            New tag
          </button>
        )}
      </div>

      {error && <div className={styles.errorBanner}>{error}</div>}

      {creating && (
        <div className={styles.formCard}>
          <TagForm
            initial={{ name: '', color: DEFAULT_COLORS[5] }}
            onSave={handleCreate}
            onCancel={() => setCreating(false)}
            saving={saving}
          />
        </div>
      )}

      {tags.length === 0 && !creating ? (
        <div className={styles.emptyState}>
          <Tag size={32} className={styles.emptyIcon} />
          <p className={styles.emptyTitle}>No tags yet</p>
          <p className={styles.emptyDesc}>Create tags to organize cards by topic, type, or priority.</p>
          <button className={styles.addBtn} onClick={() => setCreating(true)}>
            <Plus size={14} />
            Create your first tag
          </button>
        </div>
      ) : (
        <div className={styles.tagList}>
          {tags.map((tag) => (
            <div key={tag.id} className={styles.tagRow}>
              {editingId === tag.id ? (
                <div className={styles.formCard}>
                  <TagForm
                    initial={{ name: tag.name, color: tag.color }}
                    onSave={(name, color) => void handleUpdate(tag.id, name, color)}
                    onCancel={() => setEditingId(null)}
                    saving={saving}
                  />
                </div>
              ) : (
                <div className={styles.tagItem}>
                  <span className={styles.tagPill} style={{ background: tag.color }}>
                    {tag.name}
                  </span>
                  <span
                    className={styles.tagCount}
                    title={`${tag.cardCount ?? 0} card${(tag.cardCount ?? 0) !== 1 ? 's' : ''}`}
                  >
                    {tag.cardCount ?? 0}
                  </span>
                  <div className={styles.tagItemActions}>
                    <button
                      className={styles.iconBtn}
                      onClick={() => { setEditingId(tag.id); setCreating(false); }}
                      title="Edit tag"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      onClick={() => void handleDelete(tag)}
                      title="Delete tag"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
