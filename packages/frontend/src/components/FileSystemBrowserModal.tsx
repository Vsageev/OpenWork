import { useCallback, useEffect, useRef, useState } from 'react';
import { Folder, File, ChevronRight, CornerLeftUp, HardDrive, X, Check, Info } from 'lucide-react';
import { Button, Tooltip } from '../ui';
import { api, ApiError } from '../lib/api';
import styles from './FileSystemBrowserModal.module.css';

interface FsEntry {
  name: string;
  path: string;
  type: 'file' | 'folder';
}

interface FileSystemBrowserModalProps {
  onSelect: (targetPath: string) => void;
  onClose: () => void;
  selectionMode?: 'any' | 'folder';
}

export function FileSystemBrowserModal({
  onSelect,
  onClose,
  selectionMode = 'any',
}: FileSystemBrowserModalProps) {
  const [currentPath, setCurrentPath] = useState('/');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState('/');
  const pathInputRef = useRef<HTMLInputElement>(null);

  const fetchEntries = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError('');
    setSelected(null);
    try {
      const data = await api<{ path: string; entries: FsEntry[] }>(
        `/storage/browse-fs?path=${encodeURIComponent(dirPath)}`,
      );
      setEntries(data.entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to browse filesystem');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEntries(currentPath);
    setPathInput(currentPath);
  }, [currentPath, fetchEntries]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Keep pathInput in sync when a file is selected
  useEffect(() => {
    setPathInput(selected ?? currentPath);
  }, [selected, currentPath]);

  const pathSegments = currentPath === '/' ? [] : currentPath.split('/').filter(Boolean);

  const parentPath =
    currentPath === '/'
      ? null
      : '/' + currentPath.split('/').filter(Boolean).slice(0, -1).join('/') || '/';

  function handleEntryClick(entry: FsEntry) {
    if (entry.type === 'folder') {
      setCurrentPath(entry.path);
    } else if (selectionMode === 'any') {
      setSelected(entry.path === selected ? null : entry.path);
    }
  }

  async function handleSelectCurrent() {
    const value = pathInput.trim();
    if (selectionMode === 'folder') {
      const targetPath = value || currentPath;
      try {
        await api<{ path: string; entries: FsEntry[] }>(
          `/storage/browse-fs?path=${encodeURIComponent(targetPath)}`,
        );
        onSelect(targetPath);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Folder not found');
      }
      return;
    }

    if (value) {
      onSelect(value);
    } else {
      onSelect(selected ?? currentPath);
    }
  }

  async function handlePathInputSubmit() {
    const value = pathInput.trim();
    if (!value) return;

    // Try to navigate to it as a directory first
    try {
      const data = await api<{ path: string; entries: FsEntry[] }>(
        `/storage/browse-fs?path=${encodeURIComponent(value)}`,
      );
      // If it returned entries or didn't error, it's a valid directory — navigate
      setEntries(data.entries);
      setCurrentPath(value);
      setSelected(null);
      setError('');
    } catch (err) {
      if (selectionMode === 'folder') {
        setError(err instanceof ApiError ? err.message : 'Folder not found');
        return;
      }
      // Not a directory or doesn't exist — treat as a direct path selection
      onSelect(value);
    }
  }

  const visibleEntries = selectionMode === 'folder'
    ? entries.filter((entry) => entry.type === 'folder')
    : entries;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>
            {selectionMode === 'folder' ? 'Select folder' : 'Select file or folder'}
            <Tooltip label="Browsers can't access local paths from a native picker. You can browse here, or paste a path — in Finder hold Option and right-click -> Copy as Pathname (or Option+Command+C), in Explorer Shift + right-click -> Copy as path.">
              <Info size={14} className={styles.infoIcon} />
            </Tooltip>
          </span>
          <Tooltip label="Close">
            <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </Tooltip>
        </div>

        {/* Breadcrumb */}
        <nav className={styles.breadcrumb}>
          <button
            className={`${styles.breadcrumbItem} ${currentPath === '/' ? styles.breadcrumbActive : ''}`}
            onClick={() => setCurrentPath('/')}
          >
            <HardDrive size={14} />
            /
          </button>
          {pathSegments.map((segment, i) => {
            const segPath = '/' + pathSegments.slice(0, i + 1).join('/');
            const isLast = i === pathSegments.length - 1;
            return (
              <span key={segPath} className={styles.breadcrumbSep}>
                <ChevronRight size={14} />
                <button
                  className={`${styles.breadcrumbItem} ${isLast ? styles.breadcrumbActive : ''}`}
                  onClick={() => setCurrentPath(segPath)}
                >
                  {segment}
                </button>
              </span>
            );
          })}
        </nav>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.body}>
          {loading ? (
            <div className={styles.loading}>Loading...</div>
          ) : (
            <>
              {parentPath !== null && (
                <button
                  className={styles.row}
                  onClick={() => setCurrentPath(parentPath)}
                >
                  <CornerLeftUp size={16} className={styles.iconFile} />
                  <span className={styles.entryName}>..</span>
                </button>
              )}
              {visibleEntries.length === 0 && !parentPath && (
                <div className={styles.empty}>No accessible entries</div>
              )}
              {visibleEntries.map((entry) => (
                <button
                  key={entry.path}
                  className={`${styles.row} ${selected === entry.path ? styles.rowSelected : ''}`}
                  onClick={() => handleEntryClick(entry)}
                >
                  {entry.type === 'folder' ? (
                    <Folder size={16} className={styles.iconFolder} />
                  ) : (
                    <File size={16} className={styles.iconFile} />
                  )}
                  <span className={styles.entryName}>{entry.name}</span>
                  {selected === entry.path && (
                    <Check size={14} className={styles.checkIcon} />
                  )}
                </button>
              ))}
            </>
          )}
        </div>

        <div className={styles.footer}>
          <input
            ref={pathInputRef}
            className={styles.pathInput}
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handlePathInputSubmit();
              }
            }}
            placeholder={selectionMode === 'folder' ? 'Type or paste a folder path...' : 'Type or paste a path...'}
            spellCheck={false}
          />
          <div className={styles.footerActions}>
            <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={handleSelectCurrent} disabled={!pathInput.trim()}>
              Select
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
