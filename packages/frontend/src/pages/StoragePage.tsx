import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import {
  HardDrive,
  Folder,
  File,
  Upload,
  FolderPlus,
  Trash2,
  Download,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  CornerLeftUp,
  Eye,
  FileText,
  Image,
  Link2,
  Search,
  X,
  CheckSquare,
  Square,
  Minus,
  Pencil,
  Check,
  FolderOpen,
} from 'lucide-react';
import { PageHeader } from '../layout';
import { Button, Input, Tooltip } from '../ui';
import { api, apiUpload, ApiError } from '../lib/api';
import { toast } from '../stores/toast';
import { useConfirm } from '../hooks/useConfirm';
import { formatFileSize, formatFileDate, isTextPreviewable, isImagePreviewable, isPreviewable } from '../lib/file-utils';
import { FilePreviewModal } from '../components/FilePreviewModal';
import { FileSystemBrowserModal } from '../components/FileSystemBrowserModal';
import styles from './StoragePage.module.css';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

interface StorageEntry {
  name: string;
  path: string;
  type: 'file' | 'folder';
  size: number;
  mimeType: string | null;
  createdAt: string;
  isReference?: boolean;
  target?: string;
}

function getFileIcon(entry: StorageEntry) {
  if (isImagePreviewable(entry.name)) return <Image size={18} className={styles.iconFile} />;
  if (isTextPreviewable(entry.name)) return <FileText size={18} className={styles.iconFile} />;
  return <File size={18} className={styles.iconFile} />;
}

function getEntryIcon(entry: StorageEntry) {
  const baseIcon = entry.type === 'folder'
    ? <Folder size={18} className={styles.iconFolder} />
    : getFileIcon(entry);

  if (!entry.isReference) return baseIcon;

  return (
    <Tooltip label={`Reference → ${entry.target}`}>
      <span className={styles.iconWithBadge}>
        {baseIcon}
        <Link2 size={10} className={styles.iconBadge} />
      </span>
    </Tooltip>
  );
}

export function StoragePage() {
  useDocumentTitle('Storage');
  const [currentPath, setCurrentPath] = useState('/');
  const [entries, setEntries] = useState<StorageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();

  // New folder
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);

  // Reference browser
  const [showFsBrowser, setShowFsBrowser] = useState(false);

  // Search filter
  const [searchFilter, setSearchFilter] = useState('');

  // Sorting
  type SortKey = 'name' | 'size' | 'date';
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortAsc, setSortAsc] = useState(true);

  // Multi-select
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  // Rename
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Preview
  const [previewEntry, setPreviewEntry] = useState<StorageEntry | null>(null);

  // Upload / drag-and-drop
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);

  const fetchEntries = useCallback(async (dirPath: string) => {
    setLoading(true);
    setLoadError(false);
    try {
      const data = await api<{ entries: StorageEntry[] }>(
        `/storage?path=${encodeURIComponent(dirPath)}`,
      );
      setEntries(data.entries);
    } catch (err) {
      setLoadError(true);
      toast.error(err instanceof ApiError ? err.message : 'Failed to load storage');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEntries(currentPath);
  }, [currentPath, fetchEntries]);

  function navigateTo(dirPath: string) {
    setCurrentPath(dirPath);
    setShowNewFolder(false);
    setSearchFilter('');
    setSelectedPaths(new Set());
  }

  // Breadcrumb segments
  const pathSegments = currentPath === '/' ? [] : currentPath.split('/').filter(Boolean);

  async function handleCreateFolder() {
    if (!folderName.trim()) return;
    setCreatingFolder(true);
    try {
      await api('/storage/folders', {
        method: 'POST',
        body: JSON.stringify({ path: currentPath, name: folderName.trim() }),
      });
      setShowNewFolder(false);
      setFolderName('');
      toast.success('Folder created');
      await fetchEntries(currentPath);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to create folder');
    } finally {
      setCreatingFolder(false);
    }
  }

  async function handleCreateReference(targetPath: string) {
    const name = targetPath.split('/').filter(Boolean).pop();
    if (!name) return;
    setShowFsBrowser(false);
    try {
      await api('/storage/references', {
        method: 'POST',
        body: JSON.stringify({ path: currentPath, name, target: targetPath }),
      });
      toast.success('Reference created');
      await fetchEntries(currentPath);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to create reference');
    }
  }

  async function uploadFiles(files: globalThis.File[]) {
    if (files.length === 0) return;
    setUploading(true);
    const total = files.length;
    let done = 0;
    let failCount = 0;
    if (total > 1) setUploadProgress({ done: 0, total });

    for (const file of files) {
      try {
        const formData = new FormData();
        formData.append('path', currentPath);
        formData.append('file', file);
        await apiUpload('/storage/upload', formData);
        done++;
        if (total > 1) setUploadProgress({ done, total });
      } catch {
        failCount++;
        done++;
        if (total > 1) setUploadProgress({ done, total });
      }
    }

    await fetchEntries(currentPath);

    if (failCount === 0) {
      toast.success(total === 1 ? 'File uploaded' : `${total} files uploaded`);
    } else if (failCount < total) {
      toast.warning(`${total - failCount} of ${total} files uploaded — ${failCount} failed`);
    } else {
      toast.error('Failed to upload files');
    }

    setUploading(false);
    setUploadProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) uploadFiles(Array.from(files));
  }

  // Reset drag state if drag ends outside the window (e.g. tab switch mid-drag)
  useEffect(() => {
    function resetDrag() {
      dragCounter.current = 0;
      setDragOver(false);
    }
    window.addEventListener('dragend', resetDrag);
    window.addEventListener('drop', resetDrag);
    return () => {
      window.removeEventListener('dragend', resetDrag);
      window.removeEventListener('drop', resetDrag);
    };
  }, []);

  // Main area drag-and-drop (uploads to current path)
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) uploadFiles(Array.from(files));
  }

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current++;
    setDragOver(true);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setDragOver(false);
    }
  }

  async function handleDelete(entry: StorageEntry) {
    const ok = await confirm({
      title: `Delete ${entry.type}`,
      message: entry.type === 'folder'
        ? `Are you sure you want to delete the folder "${entry.name}" and all its contents?`
        : `Are you sure you want to delete "${entry.name}"?`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await api(`/storage?path=${encodeURIComponent(entry.path)}`, { method: 'DELETE' });
      toast.success('Item deleted');
      await fetchEntries(currentPath);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to delete item');
    }
  }

  function handleDownload(filePath: string) {
    const token = localStorage.getItem('ws_access_token');
    const url = `/api/storage/download?path=${encodeURIComponent(filePath)}`;
    const a = document.createElement('a');
    // Use fetch to handle auth
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => res.blob())
      .then((blob) => {
        const objUrl = URL.createObjectURL(blob);
        a.href = objUrl;
        a.download = filePath.split('/').pop() || 'file';
        document.body.appendChild(a);
        a.click();
        URL.revokeObjectURL(objUrl);
        a.remove();
      })
      .catch(() => toast.error('Failed to download file'));
  }

  async function handleReveal(entryPath: string) {
    try {
      await api('/storage/reveal', {
        method: 'POST',
        body: JSON.stringify({ path: entryPath }),
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to open location');
    }
  }

  function handleEntryClick(entry: StorageEntry) {
    if (entry.type === 'folder') {
      navigateTo(entry.path);
    } else if (entry.type === 'file' && isPreviewable(entry.name)) {
      setPreviewEntry(entry);
    } else {
      handleDownload(entry.path);
    }
  }

  function startRename(entry: StorageEntry) {
    setRenamingPath(entry.path);
    setRenameValue(entry.name);
    // Focus the input after render
    setTimeout(() => renameInputRef.current?.focus(), 0);
  }

  async function handleRename() {
    if (!renamingPath || !renameValue.trim() || renaming) return;
    const entry = entries.find((e) => e.path === renamingPath);
    if (!entry || entry.name === renameValue.trim()) {
      setRenamingPath(null);
      return;
    }
    setRenaming(true);
    try {
      await api('/storage/rename', {
        method: 'PATCH',
        body: JSON.stringify({ path: renamingPath, newName: renameValue.trim() }),
      });
      toast.success('Renamed successfully');
      await fetchEntries(currentPath);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to rename');
    } finally {
      setRenaming(false);
      setRenamingPath(null);
    }
  }

  function cancelRename() {
    setRenamingPath(null);
    setRenameValue('');
  }

  // Filter and sort
  const filtered = searchFilter
    ? entries.filter((e) => e.name.toLowerCase().includes(searchFilter.toLowerCase()))
    : entries;
  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      // Folders always first
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      let cmp = 0;
      if (sortKey === 'name') {
        cmp = a.name.localeCompare(b.name);
      } else if (sortKey === 'size') {
        cmp = a.size - b.size;
      } else {
        cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      }
      return sortAsc ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sortKey, sortAsc]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortAsc((prev) => !prev);
    } else {
      setSortKey(key);
      setSortAsc(key === 'name');
    }
  }

  function toggleSelect(path: string) {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedPaths.size === sorted.length) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(sorted.map((e) => e.path)));
    }
  }

  const selectedFiles = useMemo(
    () => sorted.filter((e) => e.type === 'file' && selectedPaths.has(e.path)),
    [sorted, selectedPaths],
  );

  async function handleBulkDelete() {
    if (selectedPaths.size === 0) return;
    const count = selectedPaths.size;
    const ok = await confirm({
      title: `Delete ${count} item${count !== 1 ? 's' : ''}`,
      message: `Are you sure you want to delete ${count} selected item${count !== 1 ? 's' : ''}? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!ok) return;
    setBulkDeleting(true);
    let deleted = 0;
    let failed = 0;
    for (const path of selectedPaths) {
      try {
        await api(`/storage?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
        deleted++;
      } catch {
        failed++;
      }
    }
    setSelectedPaths(new Set());
    await fetchEntries(currentPath);
    if (failed === 0) {
      toast.success(`${deleted} item${deleted !== 1 ? 's' : ''} deleted`);
    } else {
      toast.warning(`Deleted ${deleted}, failed ${failed}`);
    }
    setBulkDeleting(false);
  }

  function handleBulkDownload() {
    for (const entry of selectedFiles) {
      handleDownload(entry.path);
    }
  }

  // Keyboard shortcuts: Delete to delete selected, Ctrl/Cmd+A to select all, Escape to deselect
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const active = document.activeElement;
      const inInput = active instanceof HTMLInputElement
        || active instanceof HTMLTextAreaElement
        || active instanceof HTMLSelectElement;
      if (inInput) return;

      // Delete / Backspace to bulk-delete selected items
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPaths.size > 0 && !bulkDeleting) {
        e.preventDefault();
        void handleBulkDelete();
        return;
      }
      // Ctrl/Cmd+A to select all
      if (e.key === 'a' && (e.metaKey || e.ctrlKey) && sorted.length > 0) {
        e.preventDefault();
        toggleSelectAll();
        return;
      }
      // Escape to clear selection
      if (e.key === 'Escape' && selectedPaths.size > 0) {
        e.preventDefault();
        setSelectedPaths(new Set());
        return;
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedPaths, bulkDeleting, sorted.length]);

  const parentPath = currentPath === '/'
    ? null
    : '/' + currentPath.split('/').filter(Boolean).slice(0, -1).join('/');

  return (
    <>
      <PageHeader
        title="Storage"
        description="Browse, upload, and manage files"
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className={styles.hiddenInput}
        onChange={handleUpload}
      />

      {/* Breadcrumb */}
      <nav className={styles.breadcrumb}>
        <button
          className={`${styles.breadcrumbItem} ${currentPath === '/' ? styles.breadcrumbActive : ''}`}
          onClick={() => navigateTo('/')}
        >
          <HardDrive size={14} />
          Storage
        </button>
        {pathSegments.map((segment, i) => {
          const segPath = '/' + pathSegments.slice(0, i + 1).join('/');
          const isLast = i === pathSegments.length - 1;
          return (
            <span key={segPath} className={styles.breadcrumbSep}>
              <ChevronRight size={14} />
              <button
                className={`${styles.breadcrumbItem} ${isLast ? styles.breadcrumbActive : ''}`}
                onClick={() => navigateTo(segPath)}
              >
                {segment}
              </button>
            </span>
          );
        })}
      </nav>

      {/* Search filter */}
      <div className={styles.searchRow}>
        <div className={styles.searchInputWrapper}>
          <Search size={14} className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            placeholder="Filter files and folders..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
          />
          {searchFilter && (
            <button
              className={styles.searchClear}
              onClick={() => setSearchFilter('')}
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
        {searchFilter && (
          <span className={styles.searchCount}>
            {filtered.length} of {entries.length} items
          </span>
        )}
      </div>

      {uploadProgress && (
        <div className={styles.uploadProgress}>
          <div className={styles.uploadProgressBar}>
            <div
              className={styles.uploadProgressFill}
              style={{ width: `${Math.round((uploadProgress.done / uploadProgress.total) * 100)}%` }}
            />
          </div>
          <span className={styles.uploadProgressText}>
            Uploading {uploadProgress.done} of {uploadProgress.total} files...
          </span>
        </div>
      )}
      {/* File list */}
      {loading ? (
        <div className={styles.loadingState}>Loading...</div>
      ) : loadError ? (
        <div className={styles.emptyState}>
          <HardDrive size={32} strokeWidth={1.5} />
          <p>Failed to load storage</p>
          <Button size="sm" onClick={() => fetchEntries(currentPath)}>Try again</Button>
        </div>
      ) : (
        <div className={styles.fileList}>
          {selectedPaths.size > 0 && (
            <div className={styles.bulkBar}>
              <span className={styles.bulkCount}>{selectedPaths.size} selected</span>
              {selectedFiles.length > 0 && (
                <Button size="sm" variant="ghost" onClick={handleBulkDownload}>
                  <Download size={14} />
                  Download{selectedFiles.length > 1 ? ` (${selectedFiles.length})` : ''}
                </Button>
              )}
              <Button size="sm" variant="danger" onClick={handleBulkDelete} disabled={bulkDeleting}>
                <Trash2 size={14} />
                {bulkDeleting ? 'Deleting...' : `Delete (${selectedPaths.size})`}
              </Button>
              <button className={styles.bulkClear} onClick={() => setSelectedPaths(new Set())}>
                <X size={14} />
              </button>
            </div>
          )}
          <div className={styles.fileHeader}>
            <span className={styles.colCheck}>
              <button
                className={styles.checkBtn}
                onClick={toggleSelectAll}
                aria-label={selectedPaths.size === sorted.length ? 'Deselect all' : 'Select all'}
              >
                {sorted.length > 0 && selectedPaths.size === sorted.length
                  ? <CheckSquare size={16} />
                  : selectedPaths.size > 0
                    ? <Minus size={16} />
                    : <Square size={16} />}
              </button>
            </span>
            <button className={`${styles.colName} ${styles.sortHeader}`} onClick={() => handleSort('name')}>
              Name
              {sortKey === 'name' && (sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
            </button>
            <button className={`${styles.colSize} ${styles.sortHeader}`} onClick={() => handleSort('size')}>
              Size
              {sortKey === 'size' && (sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
            </button>
            <button className={`${styles.colDate} ${styles.sortHeader}`} onClick={() => handleSort('date')}>
              Modified
              {sortKey === 'date' && (sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
            </button>
            <span className={styles.colActions}>
              <Button size="sm" variant="ghost" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                <Upload size={14} />
                {uploading
                  ? (uploadProgress ? `${uploadProgress.done}/${uploadProgress.total}` : 'Uploading...')
                  : 'Upload'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setShowNewFolder(!showNewFolder);
                  setFolderName('');
                }}
              >
                <FolderPlus size={14} />
                Folder
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowFsBrowser(true)}
              >
                <Link2 size={14} />
                Reference
              </Button>
            </span>
          </div>
          {showNewFolder && (
            <div className={styles.newFolderRow}>
              <div className={styles.newFolderIcon}>
                <Folder size={18} className={styles.iconFolder} />
              </div>
              <Input
                label=""
                placeholder="Folder name"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateFolder();
                  if (e.key === 'Escape') setShowNewFolder(false);
                }}
              />
              <Button size="sm" onClick={handleCreateFolder} disabled={creatingFolder || !folderName.trim()}>
                {creatingFolder ? 'Creating...' : 'Create'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowNewFolder(false)}>
                Cancel
              </Button>
            </div>
          )}
          {parentPath !== null && (
            <div className={styles.fileRow}>
              <span className={styles.colCheck} />
              <button className={styles.colName} onClick={() => navigateTo(parentPath === '/' ? '/' : parentPath)}>
                <CornerLeftUp size={18} className={styles.iconFile} />
                <span className={styles.fileName}>..</span>
              </button>
              <span className={styles.colSize}>—</span>
              <span className={styles.colDate}>—</span>
              <span className={styles.colActions} />
            </div>
          )}
          {sorted.length === 0 && searchFilter ? (
            <div className={styles.emptyState}>
              <Search size={32} strokeWidth={1.5} />
              <p>No files or folders match &ldquo;{searchFilter}&rdquo;</p>
            </div>
          ) : sorted.length === 0 ? (
            <div
              className={`${styles.emptyState} ${dragOver ? styles.emptyStateDragOver : ''}`}
              onDrop={handleDrop}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
            >
              <Upload size={32} strokeWidth={1.5} />
              <p>Drop files here or use the upload button — multiple files supported</p>
            </div>
          ) : (
            <div
              className={`${styles.dropTarget} ${dragOver ? styles.dropTargetActive : ''}`}
              onDrop={handleDrop}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
            >
              {sorted.map((entry) => (
                <div
                  key={entry.path}
                  className={`${styles.fileRow} ${selectedPaths.has(entry.path) ? styles.fileRowSelected : ''}`}
                >
                  <span className={styles.colCheck}>
                    <button
                      className={styles.checkBtn}
                      onClick={() => toggleSelect(entry.path)}
                      aria-label={selectedPaths.has(entry.path) ? 'Deselect' : 'Select'}
                    >
                      {selectedPaths.has(entry.path) ? <CheckSquare size={16} /> : <Square size={16} />}
                    </button>
                  </span>
                  {renamingPath === entry.path ? (
                    <div className={styles.colName}>
                      {getEntryIcon(entry)}
                      <input
                        ref={renameInputRef}
                        className={styles.renameInput}
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRename();
                          if (e.key === 'Escape') cancelRename();
                        }}
                        onBlur={() => {
                          // Small delay so the confirm button click can fire first
                          setTimeout(() => { if (renamingPath === entry.path) cancelRename(); }, 150);
                        }}
                        disabled={renaming}
                      />
                      <button
                        className={styles.renameConfirmBtn}
                        onClick={handleRename}
                        disabled={renaming || !renameValue.trim()}
                        aria-label="Confirm rename"
                      >
                        <Check size={14} />
                      </button>
                    </div>
                  ) : (
                    <button className={styles.colName} onClick={() => handleEntryClick(entry)}>
                      {getEntryIcon(entry)}
                      <span className={styles.fileName}>{entry.name}</span>
                    </button>
                  )}
                  <span className={styles.colSize}>{entry.type === 'file' ? formatFileSize(entry.size) : '—'}</span>
                  <span className={styles.colDate}>{formatFileDate(entry.createdAt)}</span>
                  <span className={styles.colActions}>
                    {entry.type === 'file' && isPreviewable(entry.name) && (
                      <Tooltip label="Preview">
                        <button
                          className={styles.iconBtn}
                          onClick={() => setPreviewEntry(entry)}
                          aria-label="Preview"
                        >
                          <Eye size={16} />
                        </button>
                      </Tooltip>
                    )}
                    {entry.type === 'file' && (
                      <Tooltip label="Download">
                        <button
                          className={styles.iconBtn}
                          onClick={() => handleDownload(entry.path)}
                          aria-label="Download"
                        >
                          <Download size={16} />
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip label="Show in Finder">
                      <button
                        className={styles.iconBtn}
                        onClick={() => handleReveal(entry.path)}
                        aria-label="Show in Finder"
                      >
                        <FolderOpen size={16} />
                      </button>
                    </Tooltip>
                    <Tooltip label="Rename">
                      <button
                        className={styles.iconBtn}
                        onClick={() => startRename(entry)}
                        aria-label="Rename"
                      >
                        <Pencil size={16} />
                      </button>
                    </Tooltip>
                    <Tooltip label="Delete">
                      <button
                        className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                        onClick={() => handleDelete(entry)}
                        aria-label="Delete"
                      >
                        <Trash2 size={16} />
                      </button>
                    </Tooltip>
                  </span>
                </div>
              ))}
            </div>
          )}
          {sorted.length > 0 && (
            <div className={styles.shortcutHints}>
              <span className={styles.shortcutHint}><kbd>{navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}A</kbd> Select all</span>
              <span className={styles.shortcutHint}><kbd>Esc</kbd> Deselect</span>
              <span className={styles.shortcutHint}><kbd>Del</kbd> Delete selected</span>
            </div>
          )}
        </div>
      )}

      {previewEntry && (
        <FilePreviewModal
          fileName={previewEntry.name}
          downloadUrl={`/api/storage/download?path=${encodeURIComponent(previewEntry.path)}`}
          onClose={() => setPreviewEntry(null)}
          onDownload={() => handleDownload(previewEntry.path)}
        />
      )}

      {confirmDialog}

      {showFsBrowser && (
        <FileSystemBrowserModal
          onSelect={handleCreateReference}
          onClose={() => setShowFsBrowser(false)}
        />
      )}
    </>
  );
}
