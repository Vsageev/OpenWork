import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Upload, Download, RotateCcw, Trash2 } from 'lucide-react';
import { Button, Card, Tooltip } from '../../ui';
import { api, getAccessToken, ApiError } from '../../lib/api';
import { formatBytes, formatDate } from 'shared';
import styles from './SettingsPage.module.css';

interface BackupEntry {
  filename: string;
  sizeBytes: number;
  createdAt: string;
}

interface BackupsResponse {
  count: number;
  backups: BackupEntry[];
}

export function BackupsTab() {
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [restoringName, setRestoringName] = useState<string | null>(null);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchBackups = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api<BackupsResponse>('/backups');
      setBackups(data.backups);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load backups');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBackups();
  }, [fetchBackups]);

  async function handleCreate() {
    setCreating(true);
    setError('');
    setSuccess('');
    try {
      await api('/backups', { method: 'POST' });
      setSuccess('Backup created successfully');
      await fetchBackups();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create backup');
    } finally {
      setCreating(false);
    }
  }

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset so the same file can be re-selected
    e.target.value = '';

    setImporting(true);
    setError('');
    setSuccess('');
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      if (!json.collections || typeof json.collections !== 'object') {
        throw new Error('Invalid backup file — expected a "collections" field');
      }
      await api('/backups/import', {
        method: 'POST',
        body: JSON.stringify({ collections: json.collections, filename: file.name }),
      });
      setSuccess('Backup imported successfully');
      await fetchBackups();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else if (err instanceof SyntaxError) {
        setError('Invalid file — could not parse as JSON');
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Failed to import backup');
      }
    } finally {
      setImporting(false);
    }
  }

  function handleDownload(name: string) {
    const token = getAccessToken();
    const url = `/api/backups/${encodeURIComponent(name)}/download`;
    fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => {
        if (!res.ok) throw new Error('Download failed');
        return res.blob();
      })
      .then((blob) => {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `${name}.json`;
        a.click();
        URL.revokeObjectURL(blobUrl);
      })
      .catch(() => {
        setError('Failed to download backup');
      });
  }

  async function handleRestore(name: string) {
    setRestoreLoading(true);
    setError('');
    setSuccess('');
    try {
      await api(`/backups/${encodeURIComponent(name)}/restore`, { method: 'POST' });
      setSuccess(`Backup restored: ${name}`);
      setRestoringName(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to restore backup');
    } finally {
      setRestoreLoading(false);
    }
  }

  async function handleDelete(name: string) {
    setDeleteLoading(true);
    setError('');
    setSuccess('');
    try {
      await api(`/backups/${encodeURIComponent(name)}`, { method: 'DELETE' });
      setSuccess(`Backup deleted: ${name}`);
      setDeletingName(null);
      setBackups((prev) => prev.filter((b) => b.filename !== name));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete backup');
    } finally {
      setDeleteLoading(false);
    }
  }

  return (
    <div>
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <h2 className={styles.sectionTitle}>Backups</h2>
            <p className={styles.sectionDescription}>
              Create, download, import, and restore data backups.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />
            <Button size="sm" variant="secondary" onClick={handleImportClick} disabled={importing}>
              <Upload size={14} />
              {importing ? 'Importing...' : 'Import'}
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={creating}>
              <Plus size={14} />
              {creating ? 'Creating...' : 'Create Backup'}
            </Button>
          </div>
        </div>

        {success && <div className={styles.success}>{success}</div>}
        {error && <div className={styles.alert}>{error}</div>}

        <Card>
          <div className={styles.toolbarRight} style={{ padding: 'var(--space-3) var(--space-4)' }}>
            <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
              {backups.length} backup{backups.length !== 1 ? 's' : ''}
            </span>
          </div>

          {loading ? (
            <div className={styles.loadingState}>Loading backups...</div>
          ) : backups.length === 0 ? (
            <div className={styles.emptyState}>
              <p>No backups yet.</p>
              <Button size="sm" onClick={handleCreate} disabled={creating}>
                <Plus size={14} />
                Create your first backup
              </Button>
            </div>
          ) : (
            <div className={styles.templateList}>
              {backups.map((backup) => (
                <div key={backup.filename} className={styles.templateRow}>
                  <div className={styles.templateInfo}>
                    <div className={styles.templateName}>{backup.filename}</div>
                    <div className={styles.templateContent}>
                      {formatBytes(backup.sizeBytes)} &middot; {formatDate(backup.createdAt)}
                    </div>
                  </div>
                  <div className={styles.templateActions}>
                    <Tooltip label="Download backup">
                      <button
                        className={styles.iconBtn}
                        onClick={() => handleDownload(backup.filename)}
                        aria-label="Download backup"
                      >
                        <Download size={15} />
                      </button>
                    </Tooltip>

                    {restoringName === backup.filename ? (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setRestoringName(null)}
                          disabled={restoreLoading}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleRestore(backup.filename)}
                          disabled={restoreLoading}
                        >
                          {restoreLoading ? 'Restoring...' : 'Confirm Restore'}
                        </Button>
                      </>
                    ) : (
                      <Tooltip label="Restore backup">
                        <button
                          className={styles.iconBtn}
                          onClick={() => { setRestoringName(backup.filename); setDeletingName(null); }}
                          aria-label="Restore backup"
                        >
                          <RotateCcw size={15} />
                        </button>
                      </Tooltip>
                    )}

                    {deletingName === backup.filename ? (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setDeletingName(null)}
                          disabled={deleteLoading}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleDelete(backup.filename)}
                          disabled={deleteLoading}
                        >
                          {deleteLoading ? 'Deleting...' : 'Delete'}
                        </Button>
                      </>
                    ) : (
                      <Tooltip label="Delete backup">
                        <button
                          className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                          onClick={() => { setDeletingName(backup.filename); setRestoringName(null); }}
                          aria-label="Delete backup"
                        >
                          <Trash2 size={15} />
                        </button>
                      </Tooltip>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
