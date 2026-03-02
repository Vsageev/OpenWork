import { useState, useEffect, useCallback } from 'react';
import { api, ApiError } from '../lib/api';
import { toast } from '../stores/toast';
import { Button } from '../ui';
import type { Workspace } from '../stores/WorkspaceContext';
import styles from './WorkspaceModal.module.css';

interface Board {
  id: string;
  name: string;
}

interface Collection {
  id: string;
  name: string;
}

interface AgentGroup {
  id: string;
  name: string;
}

interface WorkspaceModalProps {
  workspace: Workspace | null; // null = create mode
  onClose: () => void;
  onSaved: () => void;
}

export function WorkspaceModal({ workspace, onClose, onSaved }: WorkspaceModalProps) {
  const [name, setName] = useState(workspace?.name ?? '');
  const [selectedBoardIds, setSelectedBoardIds] = useState<Set<string>>(
    new Set(workspace?.boardIds ?? []),
  );
  const [selectedCollectionIds, setSelectedCollectionIds] = useState<Set<string>>(
    new Set(workspace?.collectionIds ?? []),
  );
  const [selectedAgentGroupIds, setSelectedAgentGroupIds] = useState<Set<string>>(
    new Set(workspace?.agentGroupIds ?? []),
  );
  const [saving, setSaving] = useState(false);

  const [boards, setBoards] = useState<Board[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [agentGroups, setAgentGroups] = useState<AgentGroup[]>([]);

  const fetchOptions = useCallback(async () => {
    try {
      const [boardsData, collectionsData, groupsData] = await Promise.all([
        api<{ entries: Board[] }>('/boards?limit=200'),
        api<{ entries: Collection[] }>('/collections?limit=200'),
        api<{ entries: AgentGroup[] }>('/agent-groups'),
      ]);
      setBoards(boardsData.entries);
      setCollections(collectionsData.entries);
      setAgentGroups(groupsData.entries);
    } catch {
      // silently fail
    }
  }, []);

  useEffect(() => {
    fetchOptions();
  }, [fetchOptions]);

  function toggleId(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        boardIds: [...selectedBoardIds],
        collectionIds: [...selectedCollectionIds],
        agentGroupIds: [...selectedAgentGroupIds],
      };

      if (workspace) {
        await api(`/workspaces/${workspace.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
      } else {
        await api('/workspaces', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Failed to save workspace');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalTitle}>
          {workspace ? 'Edit Workspace' : 'New Workspace'}
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Name</label>
          <input
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name"
            autoFocus
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Collections</label>
          <div className={styles.checkboxList}>
            {collections.map((c) => (
              <label key={c.id} className={styles.checkboxItem}>
                <input
                  type="checkbox"
                  checked={selectedCollectionIds.has(c.id)}
                  onChange={() =>
                    setSelectedCollectionIds(toggleId(selectedCollectionIds, c.id))
                  }
                />
                <span>{c.name}</span>
              </label>
            ))}
            {collections.length === 0 && (
              <span className={styles.emptyNote}>No collections found</span>
            )}
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Boards</label>
          <div className={styles.checkboxList}>
            {boards.map((b) => (
              <label key={b.id} className={styles.checkboxItem}>
                <input
                  type="checkbox"
                  checked={selectedBoardIds.has(b.id)}
                  onChange={() =>
                    setSelectedBoardIds(toggleId(selectedBoardIds, b.id))
                  }
                />
                <span>{b.name}</span>
              </label>
            ))}
            {boards.length === 0 && (
              <span className={styles.emptyNote}>No boards found</span>
            )}
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Agent Groups</label>
          <div className={styles.checkboxList}>
            {agentGroups.map((g) => (
              <label key={g.id} className={styles.checkboxItem}>
                <input
                  type="checkbox"
                  checked={selectedAgentGroupIds.has(g.id)}
                  onChange={() =>
                    setSelectedAgentGroupIds(toggleId(selectedAgentGroupIds, g.id))
                  }
                />
                <span>{g.name}</span>
              </label>
            ))}
            {agentGroups.length === 0 && (
              <span className={styles.emptyNote}>No agent groups found</span>
            )}
          </div>
        </div>

        <div className={styles.modalActions}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? 'Saving...' : workspace ? 'Save' : 'Create'}
          </Button>
        </div>
      </div>
    </div>
  );
}
