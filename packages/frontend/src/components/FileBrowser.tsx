import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import {
  Folder,
  File,
  Upload,
  FolderInput,
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
  X,
  CheckSquare,
  Square,
  Minus,
  Pencil,
  Check,
  FolderOpen,
  MoreVertical,
  type LucideIcon,
} from 'lucide-react';
import { AnchoredOverlay, Button, Input, Tooltip } from '../ui';
import { api, apiUpload, ApiError } from '../lib/api';
import { toast } from '../stores/toast';
import { useConfirm } from '../hooks/useConfirm';
import { formatFileSize, formatFileDate, isTextPreviewable, isImagePreviewable, isPreviewable } from '../lib/file-utils';
import { FilePreviewModal } from './FilePreviewModal';
import styles from './FileBrowser.module.css';

/* ─── Types ─── */

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'folder';
  size: number;
  createdAt: string;
  mimeType?: string | null;
  isReference?: boolean;
  target?: string;
}

export interface FileBrowserEndpoints {
  /** GET — returns { entries: FileEntry[] }. Receives the directory path. */
  list: (dirPath: string) => string;
  /** POST — body: { path, name } */
  createFolder: string;
  /** POST multipart — fields: path, file */
  upload: string;
  /** Returns the URL path for downloading (used with fetch + auth header). Receives file path. */
  download: (filePath: string) => string;
  /** DELETE — receives entry path, returns full URL with query */
  delete: (entryPath: string) => string;
  /** POST — body: { path } */
  reveal: string;
  /** PATCH — body: { path, newName }. Omit to disable rename. */
  rename?: string;
  /** GET text content for previews that need authenticated loading: returns { content }. */
  readTextContent?: (filePath: string) => string;
  /** PUT — body: { path, content }. Enables editing in the preview modal when supported. */
  writeTextContent?: string;
}

export interface FileBrowserProps {
  endpoints: FileBrowserEndpoints;
  /** Icon + label for the breadcrumb root */
  rootLabel: string;
  rootIcon: LucideIcon;
  /** Show multi-select checkboxes + bulk actions */
  showMultiSelect?: boolean;
  /** Show rename action on rows */
  showRename?: boolean;
  /** Add a folder-import option to the Upload control. */
  showUploadFolder?: boolean;
  /** Label for the folder-import action inside Upload. */
  uploadFolderLabel?: string;
  /** Label for the built-in empty-folder action. */
  createFolderLabel?: string;
  /** Placeholder for the built-in empty-folder input. */
  createFolderPlaceholder?: string;
  /** Override the built-in folder button action. Receives the current directory path. */
  onCreateFolderClick?: (context: { currentPath: string }) => void;
  /** Extra toolbar buttons rendered after Upload/Folder */
  extraToolbarButtons?: React.ReactNode | ((context: { currentPath: string }) => React.ReactNode);
}

interface RowMenuState {
  entryPath: string;
  anchorElement: HTMLButtonElement | null;
  anchorRect: DOMRect | null;
}

type DirectoryInputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  webkitdirectory?: string;
  directory?: string;
};

type DirectoryPickerEntry =
  | {
    kind: 'directory';
    name: string;
    values: () => AsyncIterable<DirectoryPickerEntry>;
  }
  | {
    kind: 'file';
    name: string;
    getFile: () => Promise<globalThis.File>;
  };

type DirectoryPickerHandle = Extract<DirectoryPickerEntry, { kind: 'directory' }>;

type UploadItem = {
  file: globalThis.File;
  relativeDir: string;
};

type PickedDirectorySelection = {
  emptyDirectories: string[];
  items: UploadItem[];
  skippedCount: number;
};

const IGNORED_UPLOAD_FILE_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

/* ─── Helpers ─── */

function getFileIcon(entry: FileEntry) {
  if (isImagePreviewable(entry.name)) return <Image size={18} className={styles.iconFile} />;
  if (isTextPreviewable(entry.name)) return <FileText size={18} className={styles.iconFile} />;
  return <File size={18} className={styles.iconFile} />;
}

function getEntryIcon(entry: FileEntry) {
  return entry.type === 'folder'
    ? <Folder size={18} className={styles.iconFolder} />
    : getFileIcon(entry);
}

function normalizeRelativeDir(relativeDir: string) {
  return relativeDir
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('/');
}

function shouldIgnoreUploadPath(fileName: string, relativeDir = '') {
  if (fileName.startsWith('._')) return true;
  if (IGNORED_UPLOAD_FILE_NAMES.has(fileName)) return true;

  return normalizeRelativeDir(relativeDir)
    .split('/')
    .filter(Boolean)
    .some((segment) => segment === '__MACOSX');
}

function shouldIgnoreUploadFile(file: globalThis.File, relativeDir = '') {
  const webkitRelativeDir = file.webkitRelativePath
    ?.replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .slice(0, -1)
    .join('/');

  return shouldIgnoreUploadPath(file.name, relativeDir || webkitRelativeDir || '');
}

function isDirectoryPickerAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isDirectoryPickerSupported(
  currentWindow: Window,
): currentWindow is Window & { showDirectoryPicker: () => Promise<DirectoryPickerHandle> } {
  return typeof (currentWindow as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/* ─── Component ─── */

export function FileBrowser({
  endpoints,
  rootLabel,
  rootIcon: RootIcon,
  showMultiSelect = false,
  showRename = false,
  showUploadFolder = false,
  uploadFolderLabel = 'Add folder',
  createFolderLabel = 'Folder',
  createFolderPlaceholder = 'Folder name',
  onCreateFolderClick,
  extraToolbarButtons,
}: FileBrowserProps) {
  const [currentPath, setCurrentPath] = useState('/');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();

  // New folder
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);

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
  const [previewEntry, setPreviewEntry] = useState<FileEntry | null>(null);
  const previewEntryPath = previewEntry?.path ?? null;

  // Upload / drag-and-drop
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);
  const uploadMenuAnchorRef = useRef<HTMLSpanElement>(null);
  const uploadMenuDropdownRef = useRef<HTMLDivElement>(null);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);

  const fetchEntries = useCallback(async (dirPath: string) => {
    setLoading(true);
    setLoadError(false);
    try {
      const data = await api<{ entries: FileEntry[] }>(endpoints.list(dirPath));
      setEntries(data.entries);
    } catch (err) {
      setLoadError(true);
      toast.error(err instanceof ApiError ? err.message : 'Failed to load files');
    } finally {
      setLoading(false);
    }
  }, [endpoints]);

  useEffect(() => {
    fetchEntries(currentPath);
  }, [currentPath, fetchEntries]);

  function navigateTo(dirPath: string) {
    setCurrentPath(dirPath);
    setShowNewFolder(false);
    setSelectedPaths(new Set());
  }

  // Breadcrumb segments
  const pathSegments = currentPath === '/' ? [] : currentPath.split('/').filter(Boolean);

  async function handleCreateFolder() {
    if (!folderName.trim()) return;
    setCreatingFolder(true);
    try {
      await api(endpoints.createFolder, {
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

  function resetUploadInputs() {
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (folderInputRef.current) folderInputRef.current.value = '';
  }

  function resolveTargetPath(relativeDir: string) {
    const normalizedRelativeDir = normalizeRelativeDir(relativeDir);
    if (!normalizedRelativeDir) return currentPath;
    return currentPath === '/'
      ? `/${normalizedRelativeDir}`
      : `${currentPath}/${normalizedRelativeDir}`;
  }

  function buildUploadItems(files: globalThis.File[], options?: { preserveRelativePaths?: boolean }) {
    return files.map<UploadItem>((file) => ({
      file,
      relativeDir: options?.preserveRelativePaths
        ? normalizeRelativeDir(
          file.webkitRelativePath
            ?.replace(/\\/g, '/')
            .split('/')
            .filter(Boolean)
            .slice(0, -1)
            .join('/') ?? '',
        )
        : '',
    }));
  }

  async function collectPickedDirectorySelection(handle: DirectoryPickerHandle): Promise<PickedDirectorySelection> {
    const items: UploadItem[] = [];
    const emptyDirectories: string[] = [];
    let skippedCount = 0;

    async function walkDirectory(
      directoryHandle: DirectoryPickerHandle,
      pathSegments: string[],
    ): Promise<boolean> {
      let hasFilesInSubtree = false;

      for await (const entry of directoryHandle.values()) {
        if (entry.kind === 'directory') {
          if (entry.name === '__MACOSX') {
            continue;
          }

          const childHasFiles = await walkDirectory(entry, [...pathSegments, entry.name]);
          if (childHasFiles) {
            hasFilesInSubtree = true;
          }
          continue;
        }

        const relativeDir = normalizeRelativeDir(pathSegments.join('/'));
        if (shouldIgnoreUploadPath(entry.name, relativeDir)) {
          skippedCount++;
          continue;
        }

        items.push({
          file: await entry.getFile(),
          relativeDir,
        });
        hasFilesInSubtree = true;
      }

      if (!hasFilesInSubtree) {
        emptyDirectories.push(normalizeRelativeDir(pathSegments.join('/')));
      }

      return hasFilesInSubtree;
    }

    await walkDirectory(handle, [handle.name]);
    return { emptyDirectories, items, skippedCount };
  }

  async function ensureEmptyDirectories(relativeDirs: string[]) {
    const sortedUniqueDirs = Array.from(new Set(relativeDirs.filter(Boolean)))
      .sort((a, b) => a.split('/').length - b.split('/').length);

    let created = 0;
    let existing = 0;
    let failed = 0;

    for (const relativeDir of sortedUniqueDirs) {
      const segments = normalizeRelativeDir(relativeDir).split('/').filter(Boolean);
      const name = segments.pop();
      if (!name) continue;

      const parentRelativeDir = segments.join('/');

      try {
        await api(endpoints.createFolder, {
          method: 'POST',
          body: JSON.stringify({
            path: resolveTargetPath(parentRelativeDir),
            name,
          }),
        });
        created++;
      } catch (err) {
        if (err instanceof ApiError && err.message === 'A file or folder with this name already exists') {
          existing++;
          continue;
        }
        failed++;
      }
    }

    return { created, existing, failed };
  }

  async function uploadFiles(
    items: UploadItem[],
    options?: { emptyDirectories?: string[]; skippedCount?: number },
  ) {
    const filteredItems = items.filter((item) => !shouldIgnoreUploadFile(item.file, item.relativeDir));
    const skippedCount = (options?.skippedCount ?? 0) + (items.length - filteredItems.length);
    const emptyDirectories = options?.emptyDirectories ?? [];

    if (filteredItems.length === 0 && emptyDirectories.length === 0) {
      resetUploadInputs();
      if (skippedCount > 0) {
        toast.warning('Skipped hidden system files');
      }
      return;
    }

    setUploading(true);
    const {
      created: createdEmptyDirectories,
      existing: existingEmptyDirectories,
      failed: failedEmptyDirectories,
    } = await ensureEmptyDirectories(emptyDirectories);
    const total = filteredItems.length;
    let done = 0;
    let failCount = 0;
    if (total > 1) setUploadProgress({ done: 0, total });

    for (const item of filteredItems) {
      try {
        const formData = new FormData();
        formData.append('path', resolveTargetPath(item.relativeDir));
        formData.append('file', item.file);
        await apiUpload(endpoints.upload, formData);
        done++;
        if (total > 1) setUploadProgress({ done, total });
      } catch {
        failCount++;
        done++;
        if (total > 1) setUploadProgress({ done, total });
      }
    }

    await fetchEntries(currentPath);

    if (failCount === 0 && failedEmptyDirectories === 0) {
      const successMessage = (() => {
        if (total > 0 && createdEmptyDirectories > 0) {
          return `${total === 1 ? '1 file uploaded' : `${total} files uploaded`} and ${createdEmptyDirectories} empty ${createdEmptyDirectories === 1 ? 'folder' : 'folders'} added`;
        }
        if (total > 0) {
          return total === 1 ? 'File uploaded' : `${total} files uploaded`;
        }
        if (existingEmptyDirectories > 0) {
          return existingEmptyDirectories === 1
          ? 'Folder already exists'
          : 'Folder structure already exists';
        }
        return createdEmptyDirectories === 1 ? 'Empty folder added' : `${createdEmptyDirectories} empty folders added`;
      })();

      toast.success(
        skippedCount > 0
          ? `${successMessage} — skipped ${skippedCount} system file${skippedCount === 1 ? '' : 's'}`
          : successMessage,
      );
    } else if (failCount < total || (total === 0 && createdEmptyDirectories > 0)) {
      const parts = [];
      if (total > 0) {
        parts.push(`${total - failCount} of ${total} files uploaded`);
      }
      if (createdEmptyDirectories > 0) {
        parts.push(`${createdEmptyDirectories} empty ${createdEmptyDirectories === 1 ? 'folder' : 'folders'} added`);
      }
      if (existingEmptyDirectories > 0 && total === 0) {
        parts.push(existingEmptyDirectories === 1 ? 'folder already existed' : 'folder structure already existed');
      }
      const failures = [];
      if (failCount > 0) {
        failures.push(`${failCount} file${failCount === 1 ? '' : 's'} failed`);
      }
      if (failedEmptyDirectories > 0) {
        failures.push(`${failedEmptyDirectories} folder${failedEmptyDirectories === 1 ? '' : 's'} failed`);
      }
      toast.warning(`${parts.join(', ')}${failures.length > 0 ? ` — ${failures.join(', ')}` : ''}`);
    } else {
      toast.error(total > 0 ? 'Failed to upload files' : 'Failed to add empty folders');
    }

    setUploading(false);
    setUploadProgress(null);
    resetUploadInputs();
  }

  function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) uploadFiles(buildUploadItems(Array.from(files)));
  }

  function handleFolderUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) {
      uploadFiles(buildUploadItems(Array.from(files), { preserveRelativePaths: true }));
    }
  }

  function openFileUploadPicker() {
    setUploadMenuOpen(false);
    fileInputRef.current?.click();
  }

  async function openFolderUploadPicker() {
    setUploadMenuOpen(false);
    if (isDirectoryPickerSupported(window)) {
      try {
        const handle = await window.showDirectoryPicker();
        const selection = await collectPickedDirectorySelection(handle);
        await uploadFiles(selection.items, {
          emptyDirectories: selection.emptyDirectories,
          skippedCount: selection.skippedCount,
        });
      } catch (error) {
        if (isDirectoryPickerAbortError(error)) {
          return;
        }
        toast.error(error instanceof Error ? error.message : 'Failed to add folder');
      }
      return;
    }

    folderInputRef.current?.click();
  }

  // Reset drag state if drag ends outside the window
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

  useEffect(() => {
    if (!uploadMenuOpen) return;
    const ownerDocument = uploadMenuAnchorRef.current?.ownerDocument ?? document;

    function isWithinMenu(target: EventTarget | null, event: Event) {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (uploadMenuAnchorRef.current && path.includes(uploadMenuAnchorRef.current)) return true;
      if (uploadMenuDropdownRef.current && path.includes(uploadMenuDropdownRef.current)) return true;
      const node = target as Node | null;
      return Boolean(
        node && (
          uploadMenuAnchorRef.current?.contains(node) ||
          uploadMenuDropdownRef.current?.contains(node)
        ),
      );
    }

    function handlePointerDown(e: PointerEvent) {
      if (!isWithinMenu(e.target, e)) {
        setUploadMenuOpen(false);
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setUploadMenuOpen(false);
      }
    }

    const timer = window.setTimeout(() => {
      ownerDocument.addEventListener('pointerdown', handlePointerDown);
      ownerDocument.addEventListener('keydown', handleKeyDown);
    }, 0);

    return () => {
      window.clearTimeout(timer);
      ownerDocument.removeEventListener('pointerdown', handlePointerDown);
      ownerDocument.removeEventListener('keydown', handleKeyDown);
    };
  }, [uploadMenuOpen]);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) uploadFiles(buildUploadItems(Array.from(files)));
  }

  const previewLoadTextContent = useMemo(() => {
    if (!previewEntryPath || !endpoints.readTextContent) return undefined;
    return async () => {
      const data = await api<{ content: string }>(endpoints.readTextContent!(previewEntryPath));
      return data.content;
    };
  }, [endpoints, previewEntryPath]);

  const previewSaveTextContent = useMemo(() => {
    if (!previewEntryPath || !endpoints.writeTextContent) return undefined;
    return async (content: string) => {
      await api(endpoints.writeTextContent!, {
        method: 'PUT',
        body: JSON.stringify({ path: previewEntryPath, content }),
      });
      toast.success('File saved');
      await fetchEntries(currentPath);
    };
  }, [currentPath, endpoints, fetchEntries, previewEntryPath]);

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

  async function handleDelete(entry: FileEntry) {
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
      await api(endpoints.delete(entry.path), { method: 'DELETE' });
      toast.success('Item deleted');
      await fetchEntries(currentPath);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to delete item');
    }
  }

  function handleDownload(filePath: string) {
    const token = localStorage.getItem('ws_access_token');
    const url = `/api${endpoints.download(filePath)}`;
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => res.blob())
      .then((blob) => {
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
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
      await api(endpoints.reveal, {
        method: 'POST',
        body: JSON.stringify({ path: entryPath }),
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to open location');
    }
  }

  function handleEntryClick(entry: FileEntry) {
    if (entry.type === 'folder') {
      navigateTo(entry.path);
    } else if (entry.type === 'file' && isPreviewable(entry.name)) {
      setPreviewEntry(entry);
    } else {
      handleDownload(entry.path);
    }
  }

  function startRename(entry: FileEntry) {
    setRenamingPath(entry.path);
    setRenameValue(entry.name);
    setTimeout(() => renameInputRef.current?.focus(), 0);
  }

  async function handleRename() {
    if (!renamingPath || !renameValue.trim() || renaming || !endpoints.rename) return;
    const entry = entries.find((e) => e.path === renamingPath);
    if (!entry || entry.name === renameValue.trim()) {
      setRenamingPath(null);
      return;
    }
    setRenaming(true);
    try {
      await api(endpoints.rename, {
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

  // Sort
  const sorted = useMemo(() => {
    const arr = [...entries];
    arr.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      const cmp = sortKey === 'name'
        ? a.name.localeCompare(b.name)
        : sortKey === 'size'
          ? a.size - b.size
          : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return sortAsc ? cmp : -cmp;
    });
    return arr;
  }, [entries, sortKey, sortAsc]);

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
        await api(endpoints.delete(path), { method: 'DELETE' });
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

  // Compact mode based on container width (not viewport)
  const containerRef = useRef<HTMLDivElement>(null);
  const [isCompact, setIsCompact] = useState(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setIsCompact(entry.contentBoxSize[0].inlineSize <= 640);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Compact row dropdown menu
  const [rowMenuState, setRowMenuState] = useState<RowMenuState | null>(null);
  const menuDropdownRef = useRef<HTMLDivElement>(null);
  const menuEntryPath = rowMenuState?.entryPath ?? null;
  const menuAnchorElement = rowMenuState?.anchorElement ?? null;
  const menuAnchorRect = rowMenuState?.anchorRect ?? null;

  function closeRowMenu() {
    setRowMenuState(null);
  }

  function toggleRowMenu(entryPath: string, anchorElement: HTMLButtonElement) {
    if (menuEntryPath === entryPath) {
      closeRowMenu();
      return;
    }
    setRowMenuState({
      entryPath,
      anchorElement,
      anchorRect: anchorElement.getBoundingClientRect(),
    });
  }

  // Close dropdown on outside press / Escape
  useEffect(() => {
    if (!menuEntryPath) return;
    const ownerDocument = menuAnchorElement?.ownerDocument ?? document;

    function isWithinMenu(target: EventTarget | null, event: Event) {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (menuAnchorElement && path.includes(menuAnchorElement)) return true;
      if (menuDropdownRef.current && path.includes(menuDropdownRef.current)) return true;
      const node = target as Node | null;
      return Boolean(
        node && (
          menuAnchorElement?.contains(node) ||
          menuDropdownRef.current?.contains(node)
        ),
      );
    }

    function handlePointerDown(e: PointerEvent) {
      if (!isWithinMenu(e.target, e)) {
        closeRowMenu();
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeRowMenu();
    }

    const timer = window.setTimeout(() => {
      ownerDocument.addEventListener('pointerdown', handlePointerDown);
      ownerDocument.addEventListener('keydown', handleKeyDown);
    }, 0);

    return () => {
      window.clearTimeout(timer);
      ownerDocument.removeEventListener('pointerdown', handlePointerDown);
      ownerDocument.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuAnchorElement, menuEntryPath]);

  const parentPath = currentPath === '/'
    ? null
    : '/' + currentPath.split('/').filter(Boolean).slice(0, -1).join('/');
  const resolvedExtraToolbarButtons =
    typeof extraToolbarButtons === 'function'
      ? extraToolbarButtons({ currentPath })
      : extraToolbarButtons;
  const handleCreateFolderButtonClick = () => {
    if (onCreateFolderClick) {
      onCreateFolderClick({ currentPath });
      return;
    }
    setShowNewFolder(!showNewFolder);
    setFolderName('');
  };
  const directoryInputProps: DirectoryInputProps = {
    directory: '',
    webkitdirectory: '',
  };
  const uploadButtonLabel = uploading
    ? (uploadProgress ? `${uploadProgress.done}/${uploadProgress.total}` : 'Uploading...')
    : 'Upload';
  const shouldShowUploadMenu = showUploadFolder;

  return (
    <div ref={containerRef} className={`${styles.container} ${isCompact ? styles.compact : ''}`}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className={styles.hiddenInput}
        onChange={handleUpload}
      />
      <input
        {...directoryInputProps}
        ref={folderInputRef}
        type="file"
        multiple
        className={styles.hiddenInput}
        onChange={handleFolderUpload}
      />

      {/* Breadcrumb */}
      <nav className={styles.breadcrumb}>
        <button
          className={`${styles.breadcrumbItem} ${currentPath === '/' ? styles.breadcrumbActive : ''}`}
          onClick={() => navigateTo('/')}
        >
          <RootIcon size={14} />
          {rootLabel}
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
          <RootIcon size={32} strokeWidth={1.5} />
          <p>Failed to load files</p>
          <Button size="sm" onClick={() => fetchEntries(currentPath)}>Try again</Button>
        </div>
      ) : (
        <div className={styles.fileList}>
          {showMultiSelect && selectedPaths.size > 0 && (
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
            {showMultiSelect && (
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
            )}
            {!showMultiSelect && <span className={styles.colCheck} />}
            <button className={`${styles.colName} ${styles.sortHeader}`} onClick={() => handleSort('name')}>
              Name
              {sortKey === 'name' && (sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
            </button>
            {!isCompact && (
              <>
                <button className={`${styles.colSize} ${styles.sortHeader}`} onClick={() => handleSort('size')}>
                  Size
                  {sortKey === 'size' && (sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                </button>
                <button className={`${styles.colDate} ${styles.sortHeader}`} onClick={() => handleSort('date')}>
                  Modified
                  {sortKey === 'date' && (sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                </button>
              </>
            )}
            <span className={styles.colActions}>
              {isCompact ? (
                <>
                  <Tooltip label={uploading ? 'Uploading...' : 'Upload'}>
                    <span ref={uploadMenuAnchorRef} className={styles.toolbarAnchor}>
                      <button
                        className={styles.iconBtn}
                        onClick={() => shouldShowUploadMenu ? setUploadMenuOpen((open) => !open) : openFileUploadPicker()}
                        disabled={uploading}
                        aria-label="Upload"
                        aria-expanded={shouldShowUploadMenu ? uploadMenuOpen : undefined}
                        aria-haspopup={shouldShowUploadMenu ? 'menu' : undefined}
                      >
                        <Upload size={14} />
                      </button>
                    </span>
                  </Tooltip>
                  <Tooltip label={createFolderLabel}>
                    <button
                      className={styles.iconBtn}
                      onClick={handleCreateFolderButtonClick}
                      aria-label={createFolderLabel}
                    >
                      <FolderPlus size={14} />
                    </button>
                  </Tooltip>
                </>
              ) : (
                <>
                  <span ref={uploadMenuAnchorRef} className={styles.toolbarAnchor}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => shouldShowUploadMenu ? setUploadMenuOpen((open) => !open) : openFileUploadPicker()}
                      disabled={uploading}
                      aria-expanded={shouldShowUploadMenu ? uploadMenuOpen : undefined}
                      aria-haspopup={shouldShowUploadMenu ? 'menu' : undefined}
                    >
                      <Upload size={14} />
                      {uploadButtonLabel}
                    </Button>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleCreateFolderButtonClick}
                  >
                    <FolderPlus size={14} />
                    {createFolderLabel}
                  </Button>
                </>
              )}
              {resolvedExtraToolbarButtons}
              {shouldShowUploadMenu && uploadMenuOpen && (
                <AnchoredOverlay
                  ref={uploadMenuDropdownRef}
                  anchorElement={uploadMenuAnchorRef.current}
                  placement="bottom-end"
                  className={styles.rowMenu}
                >
                  <button className={styles.rowMenuItem} onClick={openFileUploadPicker}>
                    <Upload size={14} />
                    Upload files
                  </button>
                  <button className={styles.rowMenuItem} onClick={openFolderUploadPicker}>
                    <FolderInput size={14} />
                    {uploadFolderLabel}
                  </button>
                </AnchoredOverlay>
              )}
            </span>
          </div>
          {showNewFolder && (
            <div className={styles.newFolderRow}>
              <div className={styles.newFolderIcon}>
                <Folder size={18} className={styles.iconFolder} />
              </div>
              <Input
                label=""
                placeholder={createFolderPlaceholder}
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
              {!isCompact && <span className={styles.colSize}>—</span>}
              {!isCompact && <span className={styles.colDate}>—</span>}
              <span className={styles.colActions} />
            </div>
          )}
          {sorted.length === 0 ? (
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
                  className={`${styles.fileRow} ${showMultiSelect && selectedPaths.has(entry.path) ? styles.fileRowSelected : ''}`}
                >
                  {showMultiSelect ? (
                    <span className={styles.colCheck}>
                      <button
                        className={styles.checkBtn}
                        onClick={() => toggleSelect(entry.path)}
                        aria-label={selectedPaths.has(entry.path) ? 'Deselect' : 'Select'}
                      >
                        {selectedPaths.has(entry.path) ? <CheckSquare size={16} /> : <Square size={16} />}
                      </button>
                    </span>
                  ) : (
                    <span className={styles.colCheck} />
                  )}
                  {showRename && renamingPath === entry.path ? (
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
                      <span className={styles.fileNameWrap}>
                        <span className={styles.fileName}>{entry.name}</span>
                        {isCompact && entry.type === 'file' && (
                          <span className={styles.fileMeta}>
                            {formatFileSize(entry.size)} · {formatFileDate(entry.createdAt)}
                          </span>
                        )}
                      </span>
                    </button>
                  )}
                  {!isCompact && <span className={styles.colSize}>{entry.type === 'file' ? formatFileSize(entry.size) : '—'}</span>}
                  {!isCompact && <span className={styles.colDate}>{formatFileDate(entry.createdAt)}</span>}
                  <span className={styles.colActions}>
                    {isCompact ? (
                      <div className={styles.rowMenuAnchor}>
                        <button
                          className={styles.iconBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleRowMenu(entry.path, e.currentTarget);
                          }}
                          aria-label="Actions"
                          aria-haspopup="menu"
                          aria-expanded={menuEntryPath === entry.path}
                        >
                          <MoreVertical size={16} />
                        </button>
                        {menuEntryPath === entry.path && (
                          <AnchoredOverlay
                            ref={menuDropdownRef}
                            anchorElement={menuAnchorElement}
                            anchorRect={menuAnchorRect}
                            className={styles.rowMenu}
                            placement="bottom-end"
                          >
                            {entry.type === 'file' && isPreviewable(entry.name) && (
                              <button className={styles.rowMenuItem} onClick={() => { setPreviewEntry(entry); closeRowMenu(); }}>
                                <Eye size={15} /> Preview
                              </button>
                            )}
                            {entry.type === 'file' && (
                              <button className={styles.rowMenuItem} onClick={() => { handleDownload(entry.path); closeRowMenu(); }}>
                                <Download size={15} /> Download
                              </button>
                            )}
                            <button className={styles.rowMenuItem} onClick={() => { handleReveal(entry.path); closeRowMenu(); }}>
                              <FolderOpen size={15} /> Reveal
                            </button>
                            {showRename && (
                              <button className={styles.rowMenuItem} onClick={() => { startRename(entry); closeRowMenu(); }}>
                                <Pencil size={15} /> Rename
                              </button>
                            )}
                            <button className={`${styles.rowMenuItem} ${styles.rowMenuItemDanger}`} onClick={() => { handleDelete(entry); closeRowMenu(); }}>
                              <Trash2 size={15} /> Delete
                            </button>
                          </AnchoredOverlay>
                        )}
                      </div>
                    ) : (
                      <>
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
                        {showRename && (
                          <Tooltip label="Rename">
                            <button
                              className={styles.iconBtn}
                              onClick={() => startRename(entry)}
                              aria-label="Rename"
                            >
                              <Pencil size={16} />
                            </button>
                          </Tooltip>
                        )}
                        <Tooltip label="Delete">
                          <button
                            className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                            onClick={() => handleDelete(entry)}
                            aria-label="Delete"
                          >
                            <Trash2 size={16} />
                          </button>
                        </Tooltip>
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {previewEntry && (
        <FilePreviewModal
          key={previewEntry.path}
          fileName={previewEntry.name}
          downloadUrl={`/api${endpoints.download(previewEntry.path)}`}
          onClose={() => setPreviewEntry(null)}
          onDownload={() => handleDownload(previewEntry.path)}
          onLoadTextContent={previewLoadTextContent}
          onSaveTextContent={previewSaveTextContent}
        />
      )}

      {confirmDialog}
    </div>
  );
}
