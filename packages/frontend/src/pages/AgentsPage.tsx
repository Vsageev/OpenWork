import { type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Plus,
  Trash2,
  X,
  Power,
  PowerOff,
  ExternalLink,
  Key,
  Terminal,
  AlertTriangle,
  Download,
  Search,
  Send,
  MessageSquare,
  Settings,
  FolderOpen,
  Folder,
  File,
  FileText,
  Image,
  Upload,
  FolderPlus,
  ChevronRight,
  CornerLeftUp,
  HardDrive,
  Eye,
  Copy,
  Check,
  ToggleLeft,
  ToggleRight,
  Layers,
  Pencil,
  Link2,
  SlidersHorizontal,
} from 'lucide-react';
import { Button, Badge, Input, Textarea, Select, CronEditor, ApiKeyFormFields, MarkdownContent, Tooltip } from '../ui';
import { api, apiUpload, ApiError } from '../lib/api';
import { formatFileSize, formatFileDate, isTextPreviewable, isImagePreviewable, isPreviewable } from '../lib/file-utils';
import { getFirstImageFromClipboardData, getFirstImageFromFileList, isImageFile, prepareImageForUpload } from '../lib/image-upload';
import { scrollToFirstError } from '../lib/scroll-to-error';
import { FilePreviewModal } from '../components/FilePreviewModal';
import { FileSystemBrowserModal } from '../components/FileSystemBrowserModal';
import { AgentAvatar, AgentAvatarPicker, randomPalette, randomIcon, type AvatarConfig } from '../components/AgentAvatar';
import {
  getLatestStreamingAgentChatStream,
  startAgentChatStream,
  startAgentChatRespondStream,
  useAgentChatStreams,
} from '../stores/agent-chat-runtime';
import { useWorkspace } from '../stores/WorkspaceContext';
import styles from './AgentsPage.module.css';

/* ── Types ── */

interface CliInfo {
  id: string;
  name: string;
  command: string;
  installed: boolean;
  downloadUrl: string;
}

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  permissions: string[];
  isActive: boolean;
  expiresAt?: string | null;
}

interface ApiKeysResponse {
  total: number;
  limit: number;
  offset: number;
  entries: ApiKey[];
}

interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  enabled: boolean;
}

interface AgentGroup {
  id: string;
  name: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

interface Agent {
  id: string;
  name: string;
  description: string;
  model: string;
  modelId: string | null;
  thinkingLevel: 'low' | 'medium' | 'high' | null;
  preset: string;
  status: 'active' | 'inactive' | 'error';
  apiKeyId: string;
  apiKeyName: string;
  apiKeyPrefix: string;
  lastActivity: string | null;
  capabilities: string[];
  skipPermissions?: boolean;
  cronJobs?: CronJob[];
  groupId: string | null;
  avatarIcon: string;
  avatarBgColor: string;
  avatarLogoColor: string;
  createdAt: string;
}

interface AgentsResponse {
  total: number;
  limit: number;
  offset: number;
  entries: Agent[];
}

interface Preset {
  id: string;
  name: string;
  description: string;
}

interface ChatConversation {
  id: string;
  subject: string | null;
  lastMessageAt: string | null;
  isUnread: boolean;
  isBusy?: boolean;
  updatedAt: string;
  createdAt: string;
}

interface ChatAttachment {
  type: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storagePath: string;
}

interface ChatMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  content: string;
  createdAt: string;
  type?: string;
  attachments?: ChatAttachment[] | null;
}

/* ── ChatImage component ── */

function ChatImage({ storagePath, alt }: { storagePath: string; alt: string }) {
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

  if (!src) return <div className={styles.chatImagePlaceholder}>Loading image…</div>;
  return <img className={styles.chatImage} src={src} alt={alt} />;
}

/* ── Constants ── */

const STATUS_COLOR: Record<Agent['status'], 'success' | 'default' | 'error'> = {
  active: 'success',
  inactive: 'default',
  error: 'error',
};

const STATUS_LABEL: Record<Agent['status'], string> = {
  active: 'Active',
  inactive: 'Inactive',
  error: 'Error',
};

const MODELS = [
  {
    id: 'claude',
    name: 'Claude',
    vendor: 'Anthropic',
    description: 'Strong reasoning, safety-focused. Best for complex workflows.',
    modelIds: [
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5-20251101',
      'claude-opus-4-1-20250805',
      'claude-sonnet-4-20250514',
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    vendor: 'OpenAI',
    description: 'Code-first agent model. Good for dev-oriented tasks.',
    modelIds: [
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark',
      'gpt-5.2-codex',
      'gpt-5.1-codex',
      'gpt-5-codex',
      'gpt-5-codex-mini',
    ],
  },
  {
    id: 'qwen',
    name: 'Qwen',
    vendor: 'Alibaba',
    description: 'Open-weight model. Good for self-hosted deployments.',
    modelIds: [
      'qwen3.5-plus',
      'qwen3-coder-plus',
      'qwen3-coder-next',
    ],
  },
] as const;

type ModelId = (typeof MODELS)[number]['id'];

type ThinkingLevel = 'low' | 'medium' | 'high';

interface CreateAgentForm {
  name: string;
  description: string;
  model: ModelId;
  modelId: string;
  thinkingLevel: ThinkingLevel | '';
  preset: string;
  apiKeyId: string;
  skipPermissions: boolean;
  groupId: string;
  newKey: boolean;
  newKeyPermissions: string[];
  avatar: AvatarConfig;
}

function makeEmptyForm(): CreateAgentForm {
  const [bgColor, logoColor] = randomPalette();
  return {
    name: '',
    description: '',
    model: 'claude',
    modelId: '',
    thinkingLevel: '',
    preset: 'basic',
    apiKeyId: '',
    skipPermissions: false,
    groupId: '',
    newKey: false,
    newKeyPermissions: [],
    avatar: { icon: randomIcon(), bgColor, logoColor },
  };
}

/* ── Helpers ── */

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function getSkipPermissionsFlag(model: string): string {
  const normalized = model.toLowerCase();
  if (normalized === 'claude') return '--dangerously-skip-permissions';
  if (normalized === 'codex') return '--dangerously-bypass-approvals-and-sandbox';
  if (normalized === 'qwen') return '--approval-mode yolo';
  return 'not supported';
}
function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every minute';
  if (min !== '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `Every hour at minute ${min}`;
  if (min !== '*' && hour !== '*' && dom === '*' && mon === '*' && dow === '*') {
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `Every day at ${h12}:${String(m).padStart(2, '0')} ${period}`;
  }
  if (min !== '*' && hour !== '*' && dom === '*' && mon === '*' && dow !== '*') {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayName = dayNames[parseInt(dow, 10)] ?? dow;
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `Every ${dayName} at ${h12}:${String(m).padStart(2, '0')} ${period}`;
  }
  return expr;
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function areChatConversationListsEqual(a: ChatConversation[], b: ChatConversation[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].id !== b[i].id ||
      a[i].subject !== b[i].subject ||
      a[i].lastMessageAt !== b[i].lastMessageAt ||
      a[i].isUnread !== b[i].isUnread ||
      Boolean(a[i].isBusy) !== Boolean(b[i].isBusy) ||
      a[i].updatedAt !== b[i].updatedAt
    ) {
      return false;
    }
  }
  return true;
}

/* ── Agent file entry type ── */

type AgentFileEntry = import('../lib/file-utils').FileEntry & { isReference?: boolean; target?: string };

function getAgentFileIcon(entry: AgentFileEntry) {
  if (isImagePreviewable(entry.name)) return <Image size={18} className={styles.filesIconFile} />;
  if (isTextPreviewable(entry.name)) return <FileText size={18} className={styles.filesIconFile} />;
  return <File size={18} className={styles.filesIconFile} />;
}

function getAgentEntryIcon(entry: AgentFileEntry) {
  const baseIcon = entry.type === 'folder'
    ? <Folder size={18} className={styles.filesIconFolder} />
    : getAgentFileIcon(entry);

  if (!entry.isReference) return baseIcon;

  return (
    <Tooltip label={`Reference → ${entry.target}`}>
      <span className={styles.filesIconWithBadge}>
        {baseIcon}
        <Link2 size={10} className={styles.filesIconBadge} />
      </span>
    </Tooltip>
  );
}

/* ── Agent Files sub-component ── */

function AgentFiles({ agentId }: { agentId: string }) {
  const [currentPath, setCurrentPath] = useState('/');
  const [entries, setEntries] = useState<AgentFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [showNewFolder, setShowNewFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);

  const [showFsBrowser, setShowFsBrowser] = useState(false);

  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Preview
  const [previewEntry, setPreviewEntry] = useState<AgentFileEntry | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);

  const fetchEntries = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError('');
    try {
      const data = await api<{ entries: AgentFileEntry[] }>(
        `/agents/${agentId}/files?path=${encodeURIComponent(dirPath)}`,
      );
      setEntries(data.entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load files');
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    setCurrentPath('/');
  }, [agentId]);

  useEffect(() => {
    fetchEntries(currentPath);
  }, [currentPath, fetchEntries]);

  function navigateTo(dirPath: string) {
    setCurrentPath(dirPath);
    setShowNewFolder(false);
    setDeletingPath(null);
  }

  const pathSegments = currentPath === '/' ? [] : currentPath.split('/').filter(Boolean);

  async function handleCreateFolder() {
    if (!folderName.trim()) return;
    setCreatingFolder(true);
    setError('');
    try {
      await api(`/agents/${agentId}/files/folders`, {
        method: 'POST',
        body: JSON.stringify({ path: currentPath, name: folderName.trim() }),
      });
      setShowNewFolder(false);
      setFolderName('');
      setSuccess('Folder created');
      await fetchEntries(currentPath);
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create folder');
    } finally {
      setCreatingFolder(false);
    }
  }

  async function handleCreateReference(targetPath: string) {
    const name = targetPath.split('/').filter(Boolean).pop();
    if (!name) return;
    setShowFsBrowser(false);
    setError('');
    try {
      await api(`/agents/${agentId}/files/references`, {
        method: 'POST',
        body: JSON.stringify({ path: currentPath, name, target: targetPath }),
      });
      setSuccess('Reference created');
      await fetchEntries(currentPath);
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create reference');
    }
  }

  async function uploadFile(file: globalThis.File) {
    setUploading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('path', currentPath);
      formData.append('file', file);
      await apiUpload(`/agents/${agentId}/files/upload`, formData);
      setSuccess('File uploaded');
      await fetchEntries(currentPath);
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to upload file');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) uploadFile(file);
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
    if (dragCounter.current === 0) setDragOver(false);
  }

  async function handleDelete(itemPath: string) {
    setDeleteLoading(true);
    setError('');
    try {
      await api(`/agents/${agentId}/files?path=${encodeURIComponent(itemPath)}`, { method: 'DELETE' });
      setDeletingPath(null);
      setSuccess('Item deleted');
      await fetchEntries(currentPath);
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete item');
    } finally {
      setDeleteLoading(false);
    }
  }

  function handleDownload(filePath: string) {
    const token = localStorage.getItem('ws_access_token');
    const url = `/api/agents/${agentId}/files/download?path=${encodeURIComponent(filePath)}`;
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
      .catch(() => setError('Failed to download file'));
  }

  function handleEntryClick(entry: AgentFileEntry) {
    if (entry.type === 'folder') {
      navigateTo(entry.path);
    } else if (isPreviewable(entry.name)) {
      setPreviewEntry(entry);
    } else {
      handleDownload(entry.path);
    }
  }

  const sorted = [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const parentPath = currentPath === '/'
    ? null
    : '/' + currentPath.split('/').filter(Boolean).slice(0, -1).join('/');

  return (
    <div className={styles.filesPanel}>
      <input
        ref={fileInputRef}
        type="file"
        className={styles.filesHiddenInput}
        onChange={handleUpload}
      />

      {/* Breadcrumb */}
      <nav className={styles.filesBreadcrumb}>
        <button
          className={`${styles.filesBreadcrumbItem} ${currentPath === '/' ? styles.filesBreadcrumbActive : ''}`}
          onClick={() => navigateTo('/')}
        >
          <HardDrive size={14} />
          Files
        </button>
        {pathSegments.map((segment, i) => {
          const segPath = '/' + pathSegments.slice(0, i + 1).join('/');
          const isLast = i === pathSegments.length - 1;
          return (
            <span key={segPath} className={styles.filesBreadcrumbSep}>
              <ChevronRight size={14} />
              <button
                className={`${styles.filesBreadcrumbItem} ${isLast ? styles.filesBreadcrumbActive : ''}`}
                onClick={() => navigateTo(segPath)}
              >
                {segment}
              </button>
            </span>
          );
        })}
      </nav>

      {success && <div className={styles.filesToast}>{success}</div>}
      {error && <div className={styles.filesError}>{error}</div>}

      {loading ? (
        <div className={styles.loadingState}>Loading...</div>
      ) : (
        <div className={styles.filesTable}>
          <div className={styles.filesTableHeader}>
            <span className={styles.filesColName}>Name</span>
            <span className={styles.filesColSize}>Size</span>
            <span className={styles.filesColDate}>Modified</span>
            <span className={styles.filesColActions}>
              <Button size="sm" variant="ghost" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                <Upload size={14} />
                {uploading ? 'Uploading...' : 'Upload'}
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
            <div className={styles.filesNewFolderRow}>
              <div className={styles.filesNewFolderIcon}>
                <Folder size={18} className={styles.filesIconFolder} />
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
            <div className={styles.filesRow}>
              <button className={styles.filesColName} onClick={() => navigateTo(parentPath === '/' ? '/' : parentPath)}>
                <CornerLeftUp size={18} className={styles.filesIconFile} />
                <span className={styles.filesFileName}>..</span>
              </button>
              <span className={styles.filesColSize}>—</span>
              <span className={styles.filesColDate}>—</span>
              <span className={styles.filesColActions} />
            </div>
          )}

          {sorted.length === 0 ? (
            <div
              className={`${styles.filesEmpty} ${dragOver ? styles.filesEmptyDragOver : ''}`}
              onDrop={handleDrop}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
            >
              <Upload size={32} strokeWidth={1.5} />
              <p>Drop files here or use the upload button</p>
            </div>
          ) : (
            <div
              className={`${styles.filesDropTarget} ${dragOver ? styles.filesDropTargetActive : ''}`}
              onDrop={handleDrop}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
            >
              {sorted.map((entry) => (
                <div key={entry.path} className={styles.filesRow}>
                  <button className={styles.filesColName} onClick={() => handleEntryClick(entry)}>
                    {getAgentEntryIcon(entry)}
                    <span className={styles.filesFileName}>{entry.name}</span>
                  </button>
                  <span className={styles.filesColSize}>{entry.type === 'file' ? formatFileSize(entry.size) : '—'}</span>
                  <span className={styles.filesColDate}>{formatFileDate(entry.createdAt)}</span>
                  <span className={styles.filesColActions}>
                    {entry.type === 'file' && isPreviewable(entry.name) && (
                      <Tooltip label="Preview">
                        <button
                          className={styles.filesIconBtn}
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
                          className={styles.filesIconBtn}
                          onClick={() => handleDownload(entry.path)}
                          aria-label="Download"
                        >
                          <Download size={16} />
                        </button>
                      </Tooltip>
                    )}
                    {deletingPath === entry.path ? (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => setDeletingPath(null)} disabled={deleteLoading}>
                          Cancel
                        </Button>
                        <Button size="sm" onClick={() => handleDelete(entry.path)} disabled={deleteLoading}>
                          {deleteLoading ? 'Deleting...' : 'Confirm'}
                        </Button>
                      </>
                    ) : (
                      <Tooltip label="Delete">
                        <button
                          className={`${styles.filesIconBtn} ${styles.filesIconBtnDanger}`}
                          onClick={() => setDeletingPath(entry.path)}
                          aria-label="Delete"
                        >
                          <Trash2 size={16} />
                        </button>
                      </Tooltip>
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
          fileName={previewEntry.name}
          downloadUrl={`/api/agents/${agentId}/files/download?path=${encodeURIComponent(previewEntry.path)}`}
          onClose={() => setPreviewEntry(null)}
          onDownload={() => handleDownload(previewEntry.path)}
        />
      )}

      {showFsBrowser && (
        <FileSystemBrowserModal
          onSelect={handleCreateReference}
          onClose={() => setShowFsBrowser(false)}
        />
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   Component
   ══════════════════════════════════════════════════════════ */

export function AgentsPage() {
  const { activeWorkspaceId } = useWorkspace();
  const [searchParams] = useSearchParams();
  const requestedAgentId = searchParams.get('agentId');
  const requestedConversationId = searchParams.get('conversationId');
  // ── Agent list state ──
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // ── Agent groups ──
  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [collapsedAgents, setCollapsedAgents] = useState<Set<string> | 'all'>(() => {
    try {
      const raw = localStorage.getItem('agents_page_settings');
      const settings = raw ? JSON.parse(raw) as { collapsedAgentIds?: string[] | 'all' } : {};
      if (Array.isArray(settings.collapsedAgentIds)) {
        return new Set(settings.collapsedAgentIds);
      }
    } catch { /* ignore */ }
    return 'all';
  });
  const [manageGroupsOpen, setManageGroupsOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState('');
  const [contextMenu, setContextMenu] = useState<{ agentId: string; x: number; y: number } | null>(null);

  // ── Selection state ──
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);

  // ── Per-agent conversations ──
  const [convsByAgent, setConvsByAgent] = useState<Record<string, ChatConversation[]>>({});

  // ── Chat state ──
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [chatError, setChatError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [stagedImage, setStagedImage] = useState<{ file: File; previewUrl: string } | null>(null);
  const [draggingOver, setDraggingOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isFirstMessageRef = useRef(false);
  const activeAgentIdRef = useRef<string | null>(null);
  const activeConvIdRef = useRef<string | null>(null);
  const previousStreamStatusRef = useRef<Map<string, 'streaming' | 'done' | 'error'>>(new Map());

  // ── Conversation indicators ──
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatStreams = useAgentChatStreams();

  // ── Create modal ──
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateAgentForm>(makeEmptyForm);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apiKeysLoading, setApiKeysLoading] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [cliStatus, setCliStatus] = useState<CliInfo[]>([]);

  // ── Chat / Files tab ──
  const [chatTab, setChatTab] = useState<'chat' | 'files'>('chat');

  // ── Page settings ──
  const [pageSettingsOpen, setPageSettingsOpen] = useState(false);
  const [autoCollapse, setAutoCollapse] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('agents_page_settings');
      return raw ? (JSON.parse(raw) as { autoCollapse?: boolean }).autoCollapse ?? false : false;
    } catch {
      return false;
    }
  });

  function toggleAutoCollapse() {
    setAutoCollapse((prev) => {
      const next = !prev;
      try {
        const raw = localStorage.getItem('agents_page_settings');
        const existing = raw ? JSON.parse(raw) as object : {};
        localStorage.setItem('agents_page_settings', JSON.stringify({ ...existing, autoCollapse: next }));
      } catch { /* ignore */ }
      return next;
    });
  }

  // Persist collapsed agents state
  useEffect(() => {
    try {
      const raw = localStorage.getItem('agents_page_settings');
      const existing = raw ? JSON.parse(raw) as object : {};
      const collapsedAgentIds = collapsedAgents === 'all' ? 'all' : Array.from(collapsedAgents);
      localStorage.setItem('agents_page_settings', JSON.stringify({ ...existing, collapsedAgentIds }));
    } catch { /* ignore */ }
  }, [collapsedAgents]);

  // ── Settings modal ──
  const [settingsAgent, setSettingsAgent] = useState<Agent | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState('');
  const [editingAvatar, setEditingAvatar] = useState(false);
  const editNameRef = useRef<HTMLInputElement>(null);

  // ── Cron jobs (settings modal) ──
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [cronFormOpen, setCronFormOpen] = useState(false);
  const [cronFormCron, setCronFormCron] = useState('');
  const [cronFormPrompt, setCronFormPrompt] = useState('');
  const [cronSaving, setCronSaving] = useState(false);

  // Keep ref in sync for closure access
  activeAgentIdRef.current = activeAgentId;
  activeConvIdRef.current = activeConvId;

  const streamingConversationIds = useMemo(
    () => new Set(chatStreams.filter((stream) => stream.status === 'streaming').map((stream) => stream.conversationId)),
    [chatStreams],
  );
  const activeStream = useMemo(
    () =>
      chatStreams.find(
        (stream) =>
          stream.status === 'streaming' &&
          stream.agentId === activeAgentId &&
          stream.conversationId === activeConvId,
      ) ?? null,
    [chatStreams, activeAgentId, activeConvId],
  );
  const activeConversation = useMemo(() => {
    if (!activeAgentId || !activeConvId) return null;
    return (convsByAgent[activeAgentId] || []).find((conv) => conv.id === activeConvId) ?? null;
  }, [activeAgentId, activeConvId, convsByAgent]);
  const activeConversationBusy = Boolean(activeConversation?.isBusy);
  const streaming = Boolean(activeStream) || activeConversationBusy;
  const streamText = activeStream?.text ?? '';

  /* ── Close context menu on outside click ── */
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  /* ── Fetch groups ── */
  const fetchGroups = useCallback(async () => {
    try {
      const qs = activeWorkspaceId ? `?workspaceId=${activeWorkspaceId}` : '';
      const data = await api<{ entries: AgentGroup[] }>(`/agent-groups${qs}`);
      setGroups(data.entries);
    } catch { /* silently fail */ }
  }, [activeWorkspaceId]);

  /* ── Fetch agents ── */
  const fetchAgents = useCallback(async () => {
    setLoading(true);
    try {
      const qp = new URLSearchParams({ limit: '100' });
      if (activeWorkspaceId) qp.set('workspaceId', activeWorkspaceId);
      const data = await api<AgentsResponse>(`/agents?${qp.toString()}`);
      setAgents(data.entries);
      return data.entries;
    } catch {
      // silently fail
      return [];
    } finally {
      setLoading(false);
    }
  }, [activeWorkspaceId]);

  /* ── Fetch conversations for an agent ── */
  const fetchConversations = useCallback(async (agentId: string) => {
    try {
      const data = await api<{ entries: ChatConversation[]; total: number }>(
        `/agents/${agentId}/chat/conversations`,
      );
      setConvsByAgent((prev) => ({ ...prev, [agentId]: data.entries }));
      return data.entries;
    } catch {
      return [];
    }
  }, []);

  const refreshAllConversations = useCallback(async () => {
    const agentIds = agents.map((agent) => agent.id);
    if (agentIds.length === 0) return;

    const fetched = await Promise.all(
      agentIds.map(async (agentId) => {
        try {
          const data = await api<{ entries: ChatConversation[]; total: number }>(
            `/agents/${agentId}/chat/conversations`,
          );
          return [agentId, data.entries] as const;
        } catch {
          return null;
        }
      }),
    );

    setConvsByAgent((prev) => {
      let changed = false;
      const next = { ...prev };

      for (const entry of fetched) {
        if (!entry) continue;
        const [agentId, incoming] = entry;
        const existing = prev[agentId] || [];
        if (areChatConversationListsEqual(existing, incoming)) continue;
        next[agentId] = incoming;
        changed = true;
      }

      return changed ? next : prev;
    });
  }, [agents]);

  /* ── Fetch messages ── */
  const fetchMessages = useCallback(async (agentId: string, conversationId: string) => {
    try {
      const data = await api<{ entries: ChatMessage[] }>(
        `/agents/${agentId}/chat/messages?conversationId=${conversationId}`,
      );
      setMessages(data.entries);
      isFirstMessageRef.current = data.entries.length === 0;
    } catch {
      setChatError('Failed to load messages');
    }
  }, []);

  const markConversationRead = useCallback(async (agentId: string, conversationId: string) => {
    setConvsByAgent((prev) => {
      const convs = prev[agentId];
      if (!convs || convs.length === 0) return prev;
      let changed = false;
      const nextConvs = convs.map((conv) => {
        if (conv.id !== conversationId || !conv.isUnread) return conv;
        changed = true;
        return { ...conv, isUnread: false };
      });
      if (!changed) return prev;
      return { ...prev, [agentId]: nextConvs };
    });

    try {
      await api(`/agents/${agentId}/chat/conversations/${conversationId}/read`, {
        method: 'PATCH',
      });
    } catch {
      // best effort
    }
  }, []);

  /* ── Initial load ── */
  useEffect(() => {
    let cancelled = false;
    async function load() {
      fetchGroups();
      const entries = await fetchAgents();
      if (cancelled || entries.length === 0) return;

      // Load conversations for all agents
      const allConvs: Record<string, ChatConversation[]> = {};
      await Promise.all(
        entries.map(async (agent) => {
          try {
            const data = await api<{ entries: ChatConversation[]; total: number }>(
              `/agents/${agent.id}/chat/conversations`,
            );
            allConvs[agent.id] = data.entries;
          } catch {
            allConvs[agent.id] = [];
          }
        }),
      );
      if (cancelled) return;
      setConvsByAgent(allConvs);

      if (requestedAgentId) {
        const requestedAgent = entries.find((agent) => agent.id === requestedAgentId);
        if (requestedAgent) {
          const requestedConvs = allConvs[requestedAgentId] || [];
          const requestedConvExists = requestedConversationId
            ? requestedConvs.some((conv) => conv.id === requestedConversationId)
            : false;
          const targetConvId = requestedConvExists ? requestedConversationId : requestedConvs[0]?.id ?? null;

          setActiveAgentId(requestedAgentId);
          if (targetConvId) {
            setActiveConvId(targetConvId);
            const msgData = await api<{ entries: ChatMessage[] }>(
              `/agents/${requestedAgentId}/chat/messages?conversationId=${targetConvId}`,
            );
            if (!cancelled) {
              setMessages(msgData.entries);
              isFirstMessageRef.current = msgData.entries.length === 0;
            }
          } else {
            setActiveConvId(null);
            setMessages([]);
            isFirstMessageRef.current = true;
          }
          return;
        }
      }

      const latestStreaming = getLatestStreamingAgentChatStream();
      if (latestStreaming) {
        const streamConvs = allConvs[latestStreaming.agentId] || [];
        const streamConvExists = streamConvs.some((conv) => conv.id === latestStreaming.conversationId);
        if (streamConvExists) {
          setActiveAgentId(latestStreaming.agentId);
          setActiveConvId(latestStreaming.conversationId);
          const msgData = await api<{ entries: ChatMessage[] }>(
            `/agents/${latestStreaming.agentId}/chat/messages?conversationId=${latestStreaming.conversationId}`,
          );
          if (!cancelled) {
            setMessages(msgData.entries);
            isFirstMessageRef.current = msgData.entries.length === 0;
          }
          return;
        }
      }

      for (const agent of entries) {
        const busyConv = (allConvs[agent.id] || []).find((conv) => Boolean(conv.isBusy));
        if (!busyConv) continue;
        setActiveAgentId(agent.id);
        setActiveConvId(busyConv.id);
        const msgData = await api<{ entries: ChatMessage[] }>(
          `/agents/${agent.id}/chat/messages?conversationId=${busyConv.id}`,
        );
        if (!cancelled) {
          setMessages(msgData.entries);
          isFirstMessageRef.current = msgData.entries.length === 0;
        }
        return;
      }

      // Auto-select first agent's first conversation
      const firstAgent = entries[0];
      const firstConvs = allConvs[firstAgent.id] || [];
      if (firstConvs.length > 0) {
        setActiveAgentId(firstAgent.id);
        setActiveConvId(firstConvs[0].id);
        const msgData = await api<{ entries: ChatMessage[] }>(
          `/agents/${firstAgent.id}/chat/messages?conversationId=${firstConvs[0].id}`,
        );
        if (!cancelled) {
          setMessages(msgData.entries);
          isFirstMessageRef.current = msgData.entries.length === 0;
        }
      } else {
        setActiveAgentId(firstAgent.id);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [fetchAgents, fetchGroups, requestedAgentId, requestedConversationId]);

  useEffect(() => {
    if (agents.length === 0) return;

    void refreshAllConversations();
    const intervalId = window.setInterval(() => {
      void refreshAllConversations();
    }, 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [agents, refreshAllConversations]);

  /* ── React to stream lifecycle updates ── */
  useEffect(() => {
    const previous = previousStreamStatusRef.current;
    const next = new Map<string, 'streaming' | 'done' | 'error'>();

    for (const stream of chatStreams) {
      next.set(stream.id, stream.status);
      const previousStatus = previous.get(stream.id);

      if (previousStatus !== 'streaming') continue;

      if (stream.status === 'done') {
        if (
          activeAgentIdRef.current === stream.agentId &&
          activeConvIdRef.current === stream.conversationId
        ) {
          void markConversationRead(stream.agentId, stream.conversationId);
          void fetchMessages(stream.agentId, stream.conversationId);
        }
        void fetchConversations(stream.agentId);
      } else if (
        stream.status === 'error' &&
        activeAgentIdRef.current === stream.agentId &&
        activeConvIdRef.current === stream.conversationId
      ) {
        setChatError(stream.error || 'Agent error');
      }
    }

    previousStreamStatusRef.current = next;
  }, [chatStreams, fetchConversations, fetchMessages, markConversationRead]);

  // While a run is active (local stream or backend busy flag), periodically
  // refresh messages so API-posted progress/final updates are visible.
  useEffect(() => {
    const pollingAgentId = activeStream?.agentId ?? (activeConversationBusy ? activeAgentId : null);
    const pollingConvId = activeStream?.conversationId ?? (activeConversationBusy ? activeConvId : null);
    if (!pollingAgentId || !pollingConvId) return;

    const agentId = pollingAgentId;
    const conversationId = pollingConvId;
    void fetchMessages(agentId, conversationId);

    const intervalId = window.setInterval(() => {
      void fetchMessages(agentId, conversationId);
    }, 1500);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeStream, activeConversationBusy, activeAgentId, activeConvId, fetchMessages]);

  /* ── Scroll to bottom ── */
  const scrollToBottom = useCallback(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamText, scrollToBottom]);

  useEffect(() => {
    if (!activeAgentId || !activeConvId) return;
    void markConversationRead(activeAgentId, activeConvId);
  }, [activeAgentId, activeConvId, markConversationRead]);

  // Sync cron jobs state when settings modal opens
  useEffect(() => {
    if (settingsAgent) {
      setCronJobs(settingsAgent.cronJobs ?? []);
      setCronFormOpen(false);
      setCronFormCron('');
      setCronFormPrompt('');
    }
  }, [settingsAgent?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Cron job handlers ── */

  async function saveCronJobs(agentId: string, jobs: CronJob[]) {
    setCronSaving(true);
    try {
      const updated = await api<Agent>(`/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ cronJobs: jobs }),
      });
      setAgents((prev) => prev.map((a) => (a.id === agentId ? updated : a)));
      if (settingsAgent?.id === agentId) setSettingsAgent(updated);
      setCronJobs(updated.cronJobs ?? []);
    } catch {
      // silently fail
    } finally {
      setCronSaving(false);
    }
  }

  function handleAddCronJob() {
    if (!settingsAgent || !cronFormCron.trim() || !cronFormPrompt.trim()) return;
    const newJob: CronJob = {
      id: generateId(),
      cron: cronFormCron.trim(),
      prompt: cronFormPrompt.trim(),
      enabled: true,
    };
    const updated = [...cronJobs, newJob];
    setCronFormOpen(false);
    setCronFormCron('');
    setCronFormPrompt('');
    saveCronJobs(settingsAgent.id, updated);
  }

  function handleToggleCronJob(jobId: string) {
    if (!settingsAgent) return;
    const updated = cronJobs.map((j) => (j.id === jobId ? { ...j, enabled: !j.enabled } : j));
    saveCronJobs(settingsAgent.id, updated);
  }

  function handleDeleteCronJob(jobId: string) {
    if (!settingsAgent) return;
    const updated = cronJobs.filter((j) => j.id !== jobId);
    saveCronJobs(settingsAgent.id, updated);
  }

  /* ── Select conversation ── */
  async function selectConversation(agentId: string, convId: string) {
    if (agentId === activeAgentId && convId === activeConvId) {
      void markConversationRead(agentId, convId);
      return;
    }
    if (autoCollapse) {
      setCollapsedAgents(() => {
        const next = new Set(agents.map((a) => a.id));
        next.delete(agentId);
        return next;
      });
    }
    setActiveAgentId(agentId);
    setActiveConvId(convId);
    setMessages([]);
    setChatError(null);
    clearStagedImage();
    void markConversationRead(agentId, convId);
    await fetchMessages(agentId, convId);
    inputRef.current?.focus();
  }

  /* ── Create conversation ── */
  async function createConversation(agentId: string) {
    try {
      const conv = await api<ChatConversation>(
        `/agents/${agentId}/chat/conversations`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      setConvsByAgent((prev) => ({
        ...prev,
        [agentId]: [conv, ...(prev[agentId] || [])],
      }));
      // Expand the agent so the new conversation is visible
      setCollapsedAgents((prev) => {
        if (prev === 'all') {
          const next = new Set(agents.map((a) => a.id));
          next.delete(agentId);
          return next;
        }
        if (!prev.has(agentId)) return prev;
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
      setActiveAgentId(agentId);
      setActiveConvId(conv.id);
      setMessages([]);
      isFirstMessageRef.current = true;
      setChatError(null);
      inputRef.current?.focus();
    } catch {
      setChatError('Failed to create conversation');
    }
  }

  /* ── Delete conversation ── */
  async function deleteConversation(agentId: string, convId: string) {
    try {
      await api(`/agents/${agentId}/chat/conversations/${convId}`, { method: 'DELETE' });
      setConvsByAgent((prev) => {
        const next = (prev[agentId] || []).filter((c) => c.id !== convId);
        return { ...prev, [agentId]: next };
      });
      if (convId === activeConvId) {
        const remaining = (convsByAgent[agentId] || []).filter((c) => c.id !== convId);
        if (remaining.length > 0) {
          setActiveConvId(remaining[0].id);
          fetchMessages(agentId, remaining[0].id);
        } else {
          setActiveConvId(null);
          setMessages([]);
        }
      }
    } catch {
      setChatError('Failed to delete conversation');
    }
  }

  /* ── Send message (SSE streaming) ── */
  async function sendMessage() {
    const prompt = input.trim();
    const hasImage = !!stagedImage;
    if ((!prompt && !hasImage) || streaming || !activeAgentId || !activeConvId) return;

    const sentAgentId = activeAgentId;
    const sentConvId = activeConvId;

    setInput('');
    setChatError(null);

    const wasFirst = isFirstMessageRef.current;
    isFirstMessageRef.current = false;

    // If there's a staged image, upload it then trigger the agent to respond
    if (hasImage) {
      setUploading(true);
      try {
        const imgMsg = await uploadStagedImage(prompt);
        if (imgMsg) {
          setMessages((prev) => [...prev, imgMsg]);
        }
      } catch (err) {
        setChatError(err instanceof Error ? err.message : 'Failed to upload image');
        setUploading(false);
        return;
      }
      setUploading(false);

      // Refetch conversations for auto-title
      if (wasFirst && sentAgentId) {
        void fetchConversations(sentAgentId);
      }

      // Trigger the agent to respond to the uploaded image
      try {
        await startAgentChatRespondStream({
          agentId: sentAgentId,
          conversationId: sentConvId,
        });
      } catch (err) {
        setChatError(err instanceof Error ? err.message : 'Failed to get agent response');
      } finally {
        inputRef.current?.focus();
      }
      return;
    }

    // Text-only message — optimistic UI + stream
    const tempMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      direction: 'outbound',
      content: prompt,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempMsg]);

    try {
      await startAgentChatStream({
        agentId: sentAgentId,
        conversationId: sentConvId,
        prompt,
      });

      // Refetch conversations to pick up auto-title
      if (wasFirst && sentAgentId) {
        void fetchConversations(sentAgentId);
      }
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  /* ── Image paste/upload ── */

  function stageImage(file: File) {
    if (!isImageFile(file)) return;
    // Revoke previous preview URL if any
    if (stagedImage) URL.revokeObjectURL(stagedImage.previewUrl);
    const previewUrl = URL.createObjectURL(file);
    setStagedImage({ file, previewUrl });
  }

  function clearStagedImage() {
    if (stagedImage) {
      URL.revokeObjectURL(stagedImage.previewUrl);
      setStagedImage(null);
    }
  }

  async function uploadStagedImage(caption: string): Promise<ChatMessage | null> {
    if (!stagedImage || !activeAgentId || !activeConvId) return null;

    const uploadFile = await prepareImageForUpload(stagedImage.file);
    const fd = new FormData();
    fd.append('conversationId', activeConvId);
    if (caption) fd.append('caption', caption);
    fd.append('file', uploadFile, uploadFile.name);

    const msg = await apiUpload<ChatMessage>(
      `/agents/${activeAgentId}/chat/upload`,
      fd,
    );
    clearStagedImage();
    return msg;
  }

  function handlePaste(e: ReactClipboardEvent<HTMLTextAreaElement>) {
    const file = getFirstImageFromClipboardData(e.clipboardData);
    if (!file) return;
    e.preventDefault();
    stageImage(file);
  }

  function handleDragOver(e: ReactDragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      setDraggingOver(true);
    }
  }

  function handleDragLeave(e: ReactDragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDraggingOver(false);
  }

  function handleDrop(e: ReactDragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDraggingOver(false);
    const file = getFirstImageFromFileList(e.dataTransfer.files);
    if (file) stageImage(file);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = getFirstImageFromFileList(e.target.files);
    if (file) stageImage(file);
    // Reset so the same file can be selected again
    e.target.value = '';
  }

  /* ── Agent CRUD ── */
  const selectedModel = MODELS.find((m) => m.id === form.model);
  const selectedCli = cliStatus.find((c) => c.id === form.model);
  const cliMissing = selectedCli ? !selectedCli.installed : false;
  const selectedKey = apiKeys.find((k) => k.id === form.apiKeyId);

  function openCreate(presetGroupId?: string) {
    const f = makeEmptyForm();
    if (presetGroupId) f.groupId = presetGroupId;
    setForm(f);
    setFormErrors({});
    setCreateOpen(true);
    // Fetch supporting data
    (async () => {
      setApiKeysLoading(true);
      try {
        const data = await api<ApiKeysResponse>('/api-keys?limit=100');
        setApiKeys(data.entries.filter((k) => k.isActive));
      } catch { /* empty */ } finally { setApiKeysLoading(false); }
    })();
    (async () => {
      try {
        const data = await api<{ presets: Preset[] }>('/agents/presets');
        setPresets(data.presets);
      } catch { /* empty */ }
    })();
    (async () => {
      try {
        const data = await api<{ clis: CliInfo[] }>('/agents/cli-status');
        setCliStatus(data.clis);
      } catch { /* empty */ }
    })();
  }

  function closeCreate() {
    setCreateOpen(false);
    setForm(makeEmptyForm());
    setFormErrors({});
  }

  /* ── Group management ── */
  async function handleCreateGroup() {
    if (!newGroupName.trim()) return;
    try {
      const group = await api<AgentGroup>('/agent-groups', {
        method: 'POST',
        body: JSON.stringify({ name: newGroupName.trim() }),
      });
      setGroups((prev) => [...prev, group]);
      setNewGroupName('');
    } catch { /* silently fail */ }
  }

  async function handleRenameGroup(id: string) {
    if (!editingGroupName.trim()) return;
    try {
      const updated = await api<AgentGroup>(`/agent-groups/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editingGroupName.trim() }),
      });
      setGroups((prev) => prev.map((g) => (g.id === id ? updated : g)));
      setEditingGroupId(null);
    } catch { /* silently fail */ }
  }

  async function handleDeleteGroup(id: string) {
    try {
      await api(`/agent-groups/${id}`, { method: 'DELETE' });
      setGroups((prev) => prev.filter((g) => g.id !== id));
      // Move agents in this group to ungrouped
      setAgents((prev) => prev.map((a) => (a.groupId === id ? { ...a, groupId: null } : a)));
    } catch { /* silently fail */ }
  }

  async function handleRenameAgent(agentId: string, newName: string) {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === settingsAgent?.name) {
      setEditingName(false);
      return;
    }
    try {
      const updated = await api<Agent>(`/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: trimmed }),
      });
      setAgents((prev) => prev.map((a) => (a.id === agentId ? updated : a)));
      if (settingsAgent?.id === agentId) setSettingsAgent(updated);
    } catch { /* silently fail */ }
    setEditingName(false);
  }

  async function handleChangeAvatar(agentId: string, avatar: AvatarConfig) {
    try {
      const updated = await api<Agent>(`/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ avatarIcon: avatar.icon, avatarBgColor: avatar.bgColor, avatarLogoColor: avatar.logoColor }),
      });
      setAgents((prev) => prev.map((a) => (a.id === agentId ? updated : a)));
      if (settingsAgent?.id === agentId) setSettingsAgent(updated);
    } catch { /* silently fail */ }
  }

  async function handleChangeAgentModel(agentId: string, field: 'model' | 'modelId' | 'thinkingLevel', value: string) {
    const body: Record<string, unknown> = { [field]: value || null };
    // Clear modelId when switching provider; clear thinkingLevel for qwen (no CLI flag)
    if (field === 'model') {
      body.modelId = null;
      if (value === 'qwen') {
        body.thinkingLevel = null;
      }
    }
    try {
      const updated = await api<Agent>(`/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setAgents((prev) => prev.map((a) => (a.id === agentId ? updated : a)));
      if (settingsAgent?.id === agentId) setSettingsAgent(updated);
    } catch { /* silently fail */ }
  }

  async function handleChangeAgentGroup(agentId: string, groupId: string | null) {
    try {
      const updated = await api<Agent>(`/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ groupId }),
      });
      setAgents((prev) => prev.map((a) => (a.id === agentId ? updated : a)));
      if (settingsAgent?.id === agentId) setSettingsAgent(updated);
    } catch { /* silently fail */ }
  }

  function toggleGroupCollapse(id: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function isAgentCollapsed(id: string) {
    return collapsedAgents === 'all' || collapsedAgents.has(id);
  }

  function toggleAgentCollapse(id: string) {
    setCollapsedAgents((prev) => {
      if (prev === 'all') {
        // Expand this one agent, collapse the rest
        const next = new Set(agents.map((a) => a.id));
        next.delete(id);
        return next;
      }
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const errors: Record<string, string> = {};
    if (!form.name.trim()) errors.name = 'Name is required';
    if (form.newKey) {
      if (form.newKeyPermissions.length === 0) errors.permissions = 'Select at least one permission';
    } else {
      if (!form.apiKeyId) errors.apiKeyId = 'Select an API key';
    }
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) {
      scrollToFirstError();
      return;
    }

    const model = MODELS.find((m) => m.id === form.model)!;
    let keyId: string;

    if (form.newKey) {
      const agentName = form.name.trim();
      setCreating(true);
      try {
        const created = await api<{ id: string }>('/api-keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: `${agentName} Key`,
            description: `Auto-created for agent "${agentName}"`,
            permissions: form.newKeyPermissions,
          }),
        });
        keyId = created.id;
      } catch {
        setFormErrors({ permissions: 'Failed to create API key' });
        setCreating(false);
        return;
      }
    } else {
      keyId = form.apiKeyId;
    }

    setCreating(true);
    try {
      const newAgent = await api<Agent>('/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          description: form.description.trim() || `${model.name} agent`,
          model: model.name,
          modelId: form.modelId.trim() || null,
          thinkingLevel: form.thinkingLevel || null,
          preset: form.preset,
          apiKeyId: keyId,
          skipPermissions: form.skipPermissions,
          groupId: form.groupId || null,
          avatarIcon: form.avatar.icon,
          avatarBgColor: form.avatar.bgColor,
          avatarLogoColor: form.avatar.logoColor,
        }),
      });
      setAgents((prev) => [...prev, newAgent]);
      // Auto-create first conversation for the new agent
      try {
        const conv = await api<ChatConversation>(
          `/agents/${newAgent.id}/chat/conversations`,
          { method: 'POST', body: JSON.stringify({}) },
        );
        setConvsByAgent((prev) => ({ ...prev, [newAgent.id]: [conv] }));
        setActiveAgentId(newAgent.id);
        setActiveConvId(conv.id);
        setMessages([]);
        isFirstMessageRef.current = true;
      } catch {
        setConvsByAgent((prev) => ({ ...prev, [newAgent.id]: [] }));
        setActiveAgentId(newAgent.id);
        setActiveConvId(null);
      }
      closeCreate();
    } catch (err) {
      setFormErrors({ name: err instanceof ApiError ? err.message : 'Failed to create agent' });
    } finally {
      setCreating(false);
    }
  }

  async function handleToggle(agent: Agent) {
    const newStatus = agent.status === 'active' ? 'inactive' : 'active';
    try {
      const updated = await api<Agent>(`/agents/${agent.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      });
      setAgents((prev) => prev.map((a) => (a.id === agent.id ? updated : a)));
      if (settingsAgent?.id === agent.id) setSettingsAgent(updated);
    } catch {
      // silently fail
    }
  }

  async function handleToggleSkipPermissions(agent: Agent) {
    try {
      const updated = await api<Agent>(`/agents/${agent.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ skipPermissions: !agent.skipPermissions }),
      });
      setAgents((prev) => prev.map((a) => (a.id === agent.id ? updated : a)));
      if (settingsAgent?.id === agent.id) setSettingsAgent(updated);
    } catch {
      // silently fail
    }
  }

  async function handleDelete(id: string) {
    try {
      await api(`/agents/${id}`, { method: 'DELETE' });
      setAgents((prev) => prev.filter((a) => a.id !== id));
      setConvsByAgent((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (activeAgentId === id) {
        setActiveAgentId(null);
        setActiveConvId(null);
        setMessages([]);
      }
      setDeletingId(null);
      setSettingsAgent(null);
    } catch {
      // silently fail
    }
  }

  /* ── Derived data ── */
  const activeAgent = agents.find((a) => a.id === activeAgentId) ?? null;
  const filteredAgents = search.trim()
    ? agents.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()))
    : agents;

  // Group agents by groupId
  const groupedAgents = useMemo(() => {
    const byGroup: Record<string, Agent[]> = {};
    for (const agent of filteredAgents) {
      const key = agent.groupId || '__ungrouped__';
      if (!byGroup[key]) byGroup[key] = [];
      byGroup[key].push(agent);
    }
    return byGroup;
  }, [filteredAgents]);

  /* ── Render a single agent item in sidebar ── */
  function renderAgentItem(agent: Agent) {
    const convs = convsByAgent[agent.id] || [];
    const collapsed = isAgentCollapsed(agent.id);
    return (
      <div key={agent.id} className={styles.agentGroup}>
        <div
          className={styles.agentGroupHeader}
          onClick={() => {
            toggleAgentCollapse(agent.id);
          }}
          onContextMenu={(e) => {
            if (groups.length === 0) return;
            e.preventDefault();
            setContextMenu({ agentId: agent.id, x: e.clientX, y: e.clientY });
          }}
        >
          <ChevronRight
            size={14}
            className={`${styles.agentGroupChevron} ${!collapsed ? styles.agentGroupChevronOpen : ''}`}
          />
          <AgentAvatar
            icon={agent.avatarIcon || 'spark'}
            bgColor={agent.avatarBgColor || '#1a1a2e'}
            logoColor={agent.avatarLogoColor || '#e94560'}
            size={36}
          />
          <div className={styles.agentGroupInfo}>
            <div className={styles.agentGroupName}>{agent.name}</div>
            <div className={styles.agentGroupMeta}>
              {agent.model} · {convs.length} chat{convs.length !== 1 ? 's' : ''}
            </div>
          </div>
          <div className={styles.agentGroupActions}>
            <Tooltip label="Settings">
              <button
                className={styles.agentGroupIconBtn}
                onClick={(e) => { e.stopPropagation(); setSettingsAgent(agent); }}
                aria-label="Agent settings"
              >
                <Settings size={14} />
              </button>
            </Tooltip>
            <Tooltip label="New chat">
              <button
                className={styles.agentGroupIconBtn}
                onClick={(e) => { e.stopPropagation(); createConversation(agent.id); }}
                aria-label="New chat"
              >
                <Plus size={14} />
              </button>
            </Tooltip>
          </div>
        </div>

        {!collapsed && convs.length > 0 && (
          <div className={styles.convList}>
            {convs.map((conv) => {
              const isStreaming = Boolean(conv.isBusy) || streamingConversationIds.has(conv.id);
              const isUnread = conv.isUnread;
              return (
                <div
                  key={conv.id}
                  className={`${styles.convItem} ${
                    activeAgentId === agent.id && activeConvId === conv.id
                      ? styles.convItemActive
                      : ''
                  }`}
                  onClick={() => selectConversation(agent.id, conv.id)}
                >
                  {isStreaming && (
                    <span className={styles.convStreamingDot} title="Agent is responding..." />
                  )}
                  {!isStreaming && isUnread && (
                    <span className={styles.convUnreadDot} title="New response" />
                  )}
                  <div className={styles.convItemInfo}>
                    <div className={styles.convItemTitle}>
                      {conv.subject || 'New conversation'}
                    </div>
                  </div>
                  <span className={styles.convItemTime}>
                    {relativeTime(conv.lastMessageAt || conv.createdAt)}
                  </span>
                  <button
                    className={styles.convItemDelete}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConversation(agent.id, conv.id);
                    }}
                    aria-label="Delete conversation"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
            <button
              className={styles.newConvBtn}
              onClick={() => createConversation(agent.id)}
            >
              <Plus size={13} />
              New chat
            </button>
          </div>
        )}
      </div>
    );
  }

  /* ══════════════════════════════════════════════════════════
     Render
     ══════════════════════════════════════════════════════════ */

  return (
    <div className={styles.wrapper}>
      <div className={styles.container}>
        {/* ── Left sidebar ── */}
        <div className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <span className={styles.sidebarTitle}>Agents</span>
            <div style={{ display: 'flex', gap: 4 }}>
              <Tooltip label="Page settings">
                <button className={styles.addAgentBtn} onClick={() => setPageSettingsOpen(!pageSettingsOpen)} aria-label="Page settings">
                  <SlidersHorizontal size={16} />
                </button>
              </Tooltip>
              <Tooltip label="Manage groups">
                <button className={styles.addAgentBtn} onClick={() => setManageGroupsOpen(!manageGroupsOpen)} aria-label="Manage groups">
                  <Layers size={16} />
                </button>
              </Tooltip>
              <Tooltip label="Add agent">
                <button className={styles.addAgentBtn} onClick={() => openCreate()} aria-label="Add agent">
                  <Plus size={16} />
                </button>
              </Tooltip>
            </div>
          </div>

          {/* Page settings panel */}
          {pageSettingsOpen && (
            <div className={styles.manageGroupsPanel}>
              <div className={styles.manageGroupsHeader}>
                <span className={styles.manageGroupsTitle}>Settings</span>
                <button className={styles.modalCloseBtn} onClick={() => setPageSettingsOpen(false)} style={{ width: 24, height: 24 }}>
                  <X size={14} />
                </button>
              </div>
              <div className={styles.manageGroupsList}>
                <div className={styles.manageGroupItem}>
                  <span style={{ flex: 1, fontSize: 13, color: 'var(--color-text)' }}>Auto-collapse chats on open</span>
                  <button
                    className={styles.agentGroupIconBtn}
                    onClick={toggleAutoCollapse}
                    aria-label="Toggle auto-collapse"
                    style={{ color: autoCollapse ? 'var(--color-primary)' : undefined }}
                  >
                    {autoCollapse ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Manage groups popover */}
          {manageGroupsOpen && (
            <div className={styles.manageGroupsPanel}>
              <div className={styles.manageGroupsHeader}>
                <span className={styles.manageGroupsTitle}>Groups</span>
                <button className={styles.modalCloseBtn} onClick={() => setManageGroupsOpen(false)} style={{ width: 24, height: 24 }}>
                  <X size={14} />
                </button>
              </div>
              <div className={styles.manageGroupsList}>
                {groups.map((group) => (
                  <div key={group.id} className={styles.manageGroupItem}>
                    {editingGroupId === group.id ? (
                      <input
                        className={styles.manageGroupInput}
                        value={editingGroupName}
                        onChange={(e) => setEditingGroupName(e.target.value)}
                        onBlur={() => handleRenameGroup(group.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRenameGroup(group.id);
                          if (e.key === 'Escape') setEditingGroupId(null);
                        }}
                        autoFocus
                      />
                    ) : (
                      <span className={styles.manageGroupName}>{group.name}</span>
                    )}
                    <div className={styles.manageGroupActions}>
                      <button
                        className={styles.agentGroupIconBtn}
                        onClick={() => { setEditingGroupId(group.id); setEditingGroupName(group.name); }}
                        title="Rename"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        className={`${styles.agentGroupIconBtn} ${styles.iconBtnDanger}`}
                        onClick={() => handleDeleteGroup(group.id)}
                        title="Delete group"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className={styles.manageGroupAddRow}>
                <input
                  className={styles.manageGroupInput}
                  placeholder="New group name..."
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreateGroup(); }}
                />
                <Button size="sm" onClick={handleCreateGroup} disabled={!newGroupName.trim()}>
                  Add
                </Button>
              </div>
            </div>
          )}

          <div className={styles.searchRow}>
            <div className={styles.searchWrap}>
              <Search size={14} className={styles.searchIcon} />
              <input
                className={styles.searchInput}
                placeholder="Search agents..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          <div className={styles.agentList}>
            {loading ? (
              <div className={styles.sidebarEmpty}>Loading agents...</div>
            ) : filteredAgents.length === 0 ? (
              <div className={styles.sidebarEmpty}>
                {search ? 'No agents match your search' : 'No agents yet'}
              </div>
            ) : (
              <>
                {/* Render grouped agents */}
                {groups.map((group) => {
                  const groupAgents = groupedAgents[group.id] || [];
                  if (groupAgents.length === 0 && search.trim()) return null;
                  const isCollapsed = collapsedGroups.has(group.id);
                  return (
                    <div key={group.id} className={styles.sidebarGroup}>
                      <div
                        className={styles.sidebarGroupHeader}
                        onClick={() => toggleGroupCollapse(group.id)}
                      >
                        <ChevronRight
                          size={14}
                          className={`${styles.sidebarGroupChevron} ${!isCollapsed ? styles.sidebarGroupChevronOpen : ''}`}
                        />
                        <span className={styles.sidebarGroupName}>{group.name}</span>
                        <span className={styles.sidebarGroupCount}>{groupAgents.length}</span>
                        <button
                          className={styles.sidebarGroupAddBtn}
                          onClick={(e) => { e.stopPropagation(); openCreate(group.id); }}
                          title="Add agent to group"
                        >
                          <Plus size={13} />
                        </button>
                      </div>
                      {!isCollapsed && groupAgents.map((agent) => renderAgentItem(agent))}
                    </div>
                  );
                })}
                {/* Ungrouped agents */}
                {(() => {
                  const ungrouped = groupedAgents['__ungrouped__'] || [];
                  if (ungrouped.length === 0) return null;
                  const showHeader = groups.length > 0;
                  const isCollapsed = collapsedGroups.has('__ungrouped__');
                  return (
                    <div className={styles.sidebarGroup}>
                      {showHeader && (
                        <div
                          className={styles.sidebarGroupHeader}
                          onClick={() => toggleGroupCollapse('__ungrouped__')}
                        >
                          <ChevronRight
                            size={14}
                            className={`${styles.sidebarGroupChevron} ${!isCollapsed ? styles.sidebarGroupChevronOpen : ''}`}
                          />
                          <span className={styles.sidebarGroupName}>Ungrouped</span>
                          <span className={styles.sidebarGroupCount}>{ungrouped.length}</span>
                        </div>
                      )}
                      {(!showHeader || !isCollapsed) && ungrouped.map((agent) => renderAgentItem(agent))}
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        </div>

        {/* ── Right panel: Chat ── */}
        <div className={styles.chatPanel}>
          {activeAgent && activeConvId ? (
            <>
              {/* Chat header */}
              <div className={styles.chatHeader}>
                <div className={styles.chatHeaderInfo}>
                  <AgentAvatar
                    icon={activeAgent.avatarIcon || 'spark'}
                    bgColor={activeAgent.avatarBgColor || '#1a1a2e'}
                    logoColor={activeAgent.avatarLogoColor || '#e94560'}
                    size={32}
                  />
                  <span className={styles.chatHeaderName}>{activeAgent.name}</span>
                  <span className={styles.chatHeaderModel}>{activeAgent.model}</span>
                </div>
                <div className={styles.chatHeaderActions}>
                  <div className={styles.chatTabs}>
                    <button
                      className={`${styles.chatTabBtn} ${chatTab === 'chat' ? styles.chatTabBtnActive : ''}`}
                      onClick={() => setChatTab('chat')}
                    >
                      <MessageSquare size={14} />
                      Chat
                    </button>
                    <button
                      className={`${styles.chatTabBtn} ${chatTab === 'files' ? styles.chatTabBtnActive : ''}`}
                      onClick={() => setChatTab('files')}
                    >
                      <FolderOpen size={14} />
                      Files
                    </button>
                  </div>
                  <Tooltip label="Agent settings">
                    <button
                      className={styles.iconBtn}
                      onClick={() => setSettingsAgent(activeAgent)}
                      aria-label="Agent settings"
                    >
                      <Settings size={15} />
                    </button>
                  </Tooltip>
                </div>
              </div>

              {chatTab === 'files' ? (
                <AgentFiles agentId={activeAgent.id} />
              ) : (
              <>
              {/* Error banner */}
              {chatError && <div className={styles.errorBanner}>{chatError}</div>}

              {/* Messages */}
              {messages.length === 0 && !streaming ? (
                <div className={styles.emptyPanel}>
                  <MessageSquare size={36} strokeWidth={1.5} className={styles.emptyIcon} />
                  <div className={styles.emptyTitle}>Start a conversation</div>
                  <div className={styles.emptyText}>
                    Send a message to begin chatting with {activeAgent.name}
                  </div>
                </div>
              ) : (
                <div className={styles.messagesArea} ref={messagesRef}>
                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`${styles.messageRow} ${
                        msg.direction === 'outbound' ? styles.messageRowUser : styles.messageRowAgent
                      }`}
                    >
                      <div className={styles.messageContent}>
                        <div
                          className={`${styles.messageBubble} ${
                            msg.direction === 'outbound'
                              ? styles.messageBubbleUser
                              : styles.messageBubbleAgent
                          } ${msg.attachments?.some((a) => a.type === 'image') ? styles.messageBubbleImage : ''}`}
                        >
                          {msg.attachments?.map((att, i) =>
                            att.type === 'image' ? (
                              <ChatImage key={i} storagePath={att.storagePath} alt={att.fileName} />
                            ) : null,
                          )}
                          {msg.content && (
                            msg.direction === 'inbound' ? (
                              <MarkdownContent>{msg.content}</MarkdownContent>
                            ) : (
                              msg.content
                            )
                          )}
                        </div>
                        <div
                          className={`${styles.messageMeta} ${
                            msg.direction === 'outbound' ? styles.messageMetaUser : ''
                          }`}
                        >
                          {new Date(msg.createdAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                          {msg.direction === 'inbound' && (
                            <button
                              className={styles.copyBtn}
                              onClick={() => {
                                navigator.clipboard.writeText(msg.content);
                                setCopiedId(msg.id);
                                setTimeout(() => setCopiedId(null), 1500);
                              }}
                              aria-label="Copy message"
                            >
                              {copiedId === msg.id ? <Check size={12} /> : <Copy size={12} />}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}

                  {/* Streaming bubble */}
                  {streaming && streamText && (
                    <div className={`${styles.messageRow} ${styles.messageRowAgent}`}>
                      <div className={styles.messageContent}>
                        <div className={`${styles.messageBubble} ${styles.messageBubbleAgent} ${styles.streamingCursor}`}>
                          <MarkdownContent>{streamText}</MarkdownContent>
                        </div>
                      </div>
                    </div>
                  )}

                  {streaming && !streamText && (
                    <div className={`${styles.messageRow} ${styles.messageRowAgent}`}>
                      <div className={styles.messageContent}>
                        <div className={`${styles.messageBubble} ${styles.messageBubbleAgent} ${styles.streamingCursor}`}>
                          &nbsp;
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Reply box */}
              <div
                className={`${styles.replyBox} ${draggingOver ? styles.replyBoxDragOver : ''}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                {uploading && (
                  <div className={styles.uploadingIndicator}>Uploading image…</div>
                )}
                {stagedImage && (
                  <div className={styles.stagedImagePreview}>
                    <img src={stagedImage.previewUrl} alt="Preview" className={styles.stagedImageThumb} />
                    <span className={styles.stagedImageName}>{stagedImage.file.name}</span>
                    <button
                      className={styles.stagedImageRemove}
                      onClick={clearStagedImage}
                      aria-label="Remove image"
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
                <div className={styles.replyRow}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className={styles.hiddenFileInput}
                    onChange={handleFileSelect}
                  />
                  <button
                    className={styles.attachBtn}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={streaming || uploading}
                    aria-label="Attach image"
                    title="Attach image"
                  >
                    <Image size={18} />
                  </button>
                  <textarea
                    ref={inputRef}
                    className={styles.replyInput}
                    placeholder={stagedImage ? 'Add a caption… (optional)' : 'Type a message…'}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    rows={1}
                    disabled={streaming || uploading}
                  />
                  <button
                    className={styles.sendBtn}
                    onClick={sendMessage}
                    disabled={streaming || uploading || (!input.trim() && !stagedImage)}
                    aria-label="Send message"
                  >
                    <Send size={18} />
                  </button>
                </div>
              </div>
              </>
              )}
            </>
          ) : activeAgent && !activeConvId ? (
            <div className={styles.emptyPanel}>
              <MessageSquare size={36} strokeWidth={1.5} className={styles.emptyIcon} />
              <div className={styles.emptyTitle}>No conversations yet</div>
              <div className={styles.emptyText}>
                Start your first chat with {activeAgent.name}
              </div>
              <Button size="sm" onClick={() => createConversation(activeAgent.id)}>
                <Plus size={14} />
                New chat
              </Button>
            </div>
          ) : (
            <div className={styles.emptyPanel}>
              <MessageSquare size={36} strokeWidth={1.5} className={styles.emptyIcon} />
              <div className={styles.emptyTitle}>
                {agents.length === 0 ? 'No agents yet' : 'Select a conversation'}
              </div>
              <div className={styles.emptyText}>
                {agents.length === 0
                  ? 'Create your first agent to start chatting'
                  : 'Choose an agent and conversation from the sidebar'}
              </div>
              {agents.length === 0 && (
                <Button size="sm" onClick={() => openCreate()}>
                  <Plus size={14} />
                  Add Agent
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Agent context menu (right-click → Move to group) ── */}
      {contextMenu && (
        <div
          className={styles.contextMenu}
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className={styles.contextMenuLabel}>Move to group</div>
          <button
            className={`${styles.contextMenuItem} ${
              !agents.find((a) => a.id === contextMenu.agentId)?.groupId ? styles.contextMenuItemActive : ''
            }`}
            onClick={() => { handleChangeAgentGroup(contextMenu.agentId, null); setContextMenu(null); }}
          >
            No group
          </button>
          {groups.map((g) => (
            <button
              key={g.id}
              className={`${styles.contextMenuItem} ${
                agents.find((a) => a.id === contextMenu.agentId)?.groupId === g.id ? styles.contextMenuItemActive : ''
              }`}
              onClick={() => { handleChangeAgentGroup(contextMenu.agentId, g.id); setContextMenu(null); }}
            >
              {g.name}
            </button>
          ))}
        </div>
      )}

      {/* ── Create Agent Modal ── */}
      {createOpen && (
        <div className={styles.modalOverlay} onClick={closeCreate}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>Add Agent</h3>
              <button className={styles.modalCloseBtn} onClick={closeCreate}>
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleCreate}>
              <div className={styles.modalBody}>
                <Input
                  label="Name"
                  placeholder="e.g. Workflow Assistant"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  error={formErrors.name}
                  autoFocus
                />

                <div>
                  <div className={styles.fieldLabel}>Avatar</div>
                  <AgentAvatarPicker
                    value={form.avatar}
                    onChange={(avatar) => setForm((f) => ({ ...f, avatar }))}
                  />
                </div>

                <Textarea
                  label="Description"
                  placeholder="What does this agent do?"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  rows={2}
                />

                {groups.length > 0 && (
                  <Select
                    label="Group"
                    value={form.groupId}
                    onChange={(e) => setForm((f) => ({ ...f, groupId: e.target.value }))}
                  >
                    <option value="">No group</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </Select>
                )}

                {presets.length > 0 && (
                  <div>
                    <div className={styles.fieldLabel}>Preset</div>
                    <div className={styles.presetGrid}>
                      {presets.map((preset) => (
                        <div
                          key={preset.id}
                          className={[
                            styles.presetCard,
                            form.preset === preset.id && styles.presetCardSelected,
                          ].filter(Boolean).join(' ')}
                          onClick={() => setForm((f) => ({ ...f, preset: preset.id }))}
                        >
                          <div className={styles.presetName}>{preset.name}</div>
                          <div className={styles.presetDescription}>{preset.description}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <div className={styles.fieldLabel}>Model</div>
                  <div className={styles.modelGrid}>
                    {MODELS.map((model) => (
                      <div
                        key={model.id}
                        className={[
                          styles.modelCard,
                          form.model === model.id && styles.modelCardSelected,
                        ].filter(Boolean).join(' ')}
                        onClick={() => setForm((f) => ({ ...f, model: model.id, modelId: '', thinkingLevel: model.id === 'qwen' ? '' : f.thinkingLevel }))}
                      >
                        <div className={styles.modelName}>{model.name}</div>
                        <div className={styles.modelVendor}>{model.vendor}</div>
                        <div className={styles.modelDescription}>{model.description}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className={styles.modelOptionsRow}>
                  <div className={styles.modelOptionField}>
                    <div className={styles.fieldLabel}>Model <span className={styles.fieldHint}>(optional)</span></div>
                    <select
                      className={styles.textInput}
                      value={form.modelId}
                      onChange={(e) => setForm((f) => ({ ...f, modelId: e.target.value }))}
                    >
                      <option value="">Default</option>
                      {MODELS.find((m) => m.id === form.model)?.modelIds.map((mid) => (
                        <option key={mid} value={mid}>{mid}</option>
                      ))}
                    </select>
                    <div className={styles.fieldHint}>Override the default model used by the CLI</div>
                  </div>
                  {(form.model === 'claude' || form.model === 'codex') && (
                    <div className={styles.modelOptionField}>
                      <div className={styles.fieldLabel}>
                        {form.model === 'claude' ? 'Thinking Level' : 'Reasoning Effort'}{' '}
                        <span className={styles.fieldHint}>(optional)</span>
                      </div>
                      <select
                        className={styles.textInput}
                        value={form.thinkingLevel}
                        onChange={(e) => setForm((f) => ({ ...f, thinkingLevel: e.target.value as ThinkingLevel | '' }))}
                      >
                        <option value="">Default</option>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </select>
                      <div className={styles.fieldHint}>
                        {form.model === 'claude' ? 'Controls reasoning effort via --effort' : 'Controls reasoning effort via model_reasoning_effort'}
                      </div>
                    </div>
                  )}
                </div>

                {cliMissing && selectedCli && (
                  <div className={styles.cliBanner}>
                    <div className={styles.cliBannerIcon}>
                      <AlertTriangle size={16} />
                    </div>
                    <div className={styles.cliBannerContent}>
                      <div className={styles.cliBannerTitle}>
                        {selectedModel?.name} CLI not installed
                      </div>
                      <div className={styles.cliBannerText}>
                        The <code>{selectedCli.command}</code> command was not found on this server.
                        Agents using {selectedModel?.name} require the CLI to be installed.
                      </div>
                      <a
                        href={selectedCli.downloadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.cliBannerLink}
                      >
                        <Download size={13} />
                        Download {selectedModel?.name} CLI
                        <ExternalLink size={11} />
                      </a>
                    </div>
                  </div>
                )}

                <div className={styles.skipPermissionsCard}>
                  <label className={styles.skipPermissionsLabel}>
                    <input
                      type="checkbox"
                      checked={form.skipPermissions}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, skipPermissions: e.target.checked }))
                      }
                    />
                    Enable skip permissions
                  </label>
                  <div className={styles.skipPermissionsHint}>
                    Uses <code className={styles.settingsCode}>{getSkipPermissionsFlag(form.model)}</code>{' '}
                    for {selectedModel?.name || 'this model'}.
                  </div>
                </div>

                <div>
                  <div className={styles.fieldLabel}>API Key</div>
                  <div className={styles.keyModeTabs}>
                    <button
                      type="button"
                      className={`${styles.keyModeTab} ${!form.newKey ? styles.keyModeTabActive : ''}`}
                      onClick={() => setForm((f) => ({ ...f, newKey: false }))}
                    >
                      Use existing
                    </button>
                    <button
                      type="button"
                      className={`${styles.keyModeTab} ${form.newKey ? styles.keyModeTabActive : ''}`}
                      onClick={() => setForm((f) => ({ ...f, newKey: true }))}
                    >
                      <Plus size={13} />
                      Create new
                    </button>
                  </div>

                  {!form.newKey ? (
                    <>
                      <Select
                        value={form.apiKeyId}
                        onChange={(e) => setForm((f) => ({ ...f, apiKeyId: e.target.value }))}
                        error={formErrors.apiKeyId}
                      >
                        <option value="">
                          {apiKeysLoading ? 'Loading keys...' : 'Select an API key'}
                        </option>
                        {apiKeys.map((k) => (
                          <option key={k.id} value={k.id}>
                            {k.name} ({k.keyPrefix}...)
                          </option>
                        ))}
                      </Select>

                      {selectedKey && (
                        <div className={styles.keyPermissions}>
                          <div className={styles.keyPermissionsLabel}>Permissions from this key</div>
                          <div className={styles.keyPermissionsList}>
                            {selectedKey.permissions.map((perm) => (
                              <Badge key={perm} color="info">{perm}</Badge>
                            ))}
                            {selectedKey.permissions.length === 0 && (
                              <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>
                                No permissions configured
                              </span>
                            )}
                          </div>
                        </div>
                      )}

                      {apiKeys.length === 0 && !apiKeysLoading && (
                        <div className={styles.noKeysHint}>
                          No active API keys. Switch to "Create new" to make one now.
                        </div>
                      )}
                    </>
                  ) : (
                    <ApiKeyFormFields
                      permissionsOnly
                      form={{ name: '', description: '', permissions: form.newKeyPermissions, hasExpiration: false, expiresAt: '' }}
                      onChange={(updater) => {
                        setForm((f) => {
                          const next = updater({ name: '', description: '', permissions: f.newKeyPermissions, hasExpiration: false, expiresAt: '' });
                          return { ...f, newKeyPermissions: next.permissions };
                        });
                      }}
                      errors={{ permissions: formErrors.permissions }}
                    />
                  )}
                </div>
              </div>
              <div className={styles.modalFooter}>
                <Button type="button" variant="secondary" size="md" onClick={closeCreate}>
                  Cancel
                </Button>
                <Button type="submit" size="md" disabled={creating}>
                  {creating ? 'Creating...' : 'Create Agent'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Agent Settings Modal ── */}
      {settingsAgent && (
        <div className={styles.modalOverlay} onClick={() => { setSettingsAgent(null); setDeletingId(null); setEditingName(false); setEditingAvatar(false); }}>
          <div className={styles.settingsModalWide} onClick={(e) => e.stopPropagation()}>
            {/* Hero header with avatar, name, status */}
            <div className={styles.settingsHero}>
              <div className={styles.settingsAvatarWrap}>
                <button
                  type="button"
                  className={styles.settingsAvatarBtn}
                  onClick={() => setEditingAvatar((v) => !v)}
                  title="Edit avatar"
                >
                  <AgentAvatar
                    icon={settingsAgent.avatarIcon || 'spark'}
                    bgColor={settingsAgent.avatarBgColor || '#1a1a2e'}
                    logoColor={settingsAgent.avatarLogoColor || '#e94560'}
                    size={56}
                  />
                  <span className={styles.settingsAvatarOverlay}><Pencil size={16} /></span>
                </button>
                {editingAvatar && (
                  <div className={styles.settingsAvatarPickerDropdown}>
                    <AgentAvatarPicker
                      value={{ icon: settingsAgent.avatarIcon || 'spark', bgColor: settingsAgent.avatarBgColor || '#1a1a2e', logoColor: settingsAgent.avatarLogoColor || '#e94560' }}
                      onChange={(avatar) => handleChangeAvatar(settingsAgent.id, avatar)}
                    />
                  </div>
                )}
              </div>
              <div className={styles.settingsHeroInfo}>
                {editingName ? (
                  <input
                    ref={editNameRef}
                    className={styles.settingsHeroNameInput}
                    value={editNameValue}
                    onChange={(e) => setEditNameValue(e.target.value)}
                    onBlur={() => handleRenameAgent(settingsAgent.id, editNameValue)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); handleRenameAgent(settingsAgent.id, editNameValue); }
                      if (e.key === 'Escape') setEditingName(false);
                    }}
                    maxLength={255}
                    autoFocus
                  />
                ) : (
                  <h3
                    className={styles.settingsHeroName}
                    onClick={() => { setEditNameValue(settingsAgent.name); setEditingName(true); }}
                    title="Click to rename"
                  >
                    {settingsAgent.name}
                    <Pencil size={13} className={styles.settingsHeroNameEditIcon} />
                  </h3>
                )}
                <p className={styles.settingsHeroDesc}>{settingsAgent.description}</p>
              </div>
              <div className={styles.settingsHeroRight}>
                <Badge color={STATUS_COLOR[settingsAgent.status]}>
                  <span
                    className={`${styles.statusDot} ${
                      settingsAgent.status === 'active'
                        ? styles.statusDotActive
                        : settingsAgent.status === 'error'
                          ? styles.statusDotError
                          : styles.statusDotInactive
                    }`}
                  />
                  {STATUS_LABEL[settingsAgent.status]}
                </Badge>
              </div>
              <button className={styles.modalCloseBtn} onClick={() => { setSettingsAgent(null); setDeletingId(null); setEditingName(false); }}>
                <X size={18} />
              </button>
            </div>

            <div className={styles.modalBody}>
              {/* Configuration section */}
              <div className={styles.settingsSection}>
                <div className={styles.settingsSectionTitle}>Configuration</div>
                <div className={styles.settingsGrid}>
                  <div className={styles.settingsGridItem}>
                    <div className={styles.settingsGridLabel}>
                      <Terminal size={13} />
                      Provider
                    </div>
                    <div className={styles.settingsGridValue}>
                      <select
                        className={styles.settingsGroupSelect}
                        value={settingsAgent.model}
                        onChange={(e) => handleChangeAgentModel(settingsAgent.id, 'model', e.target.value)}
                      >
                        {MODELS.map((m) => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className={styles.settingsGridItem}>
                    <div className={styles.settingsGridLabel}>Model</div>
                    <div className={styles.settingsGridValue}>
                      <select
                        className={styles.settingsGroupSelect}
                        value={settingsAgent.modelId || ''}
                        onChange={(e) => handleChangeAgentModel(settingsAgent.id, 'modelId', e.target.value)}
                      >
                        <option value="">Default</option>
                        {MODELS.find((m) => m.id === settingsAgent.model)?.modelIds.map((mid) => (
                          <option key={mid} value={mid}>{mid}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {(settingsAgent.model === 'claude' || settingsAgent.model === 'codex') && (
                    <div className={styles.settingsGridItem}>
                      <div className={styles.settingsGridLabel}>
                        {settingsAgent.model === 'claude' ? 'Thinking Level' : 'Reasoning Effort'}
                      </div>
                      <div className={styles.settingsGridValue}>
                        <select
                          className={styles.settingsGroupSelect}
                          value={settingsAgent.thinkingLevel || ''}
                          onChange={(e) => handleChangeAgentModel(settingsAgent.id, 'thinkingLevel', e.target.value)}
                        >
                          <option value="">None</option>
                          <option value="low">Low</option>
                          <option value="medium">Medium</option>
                          <option value="high">High</option>
                        </select>
                      </div>
                    </div>
                  )}
                  <div className={styles.settingsGridItem}>
                    <div className={styles.settingsGridLabel}>
                      <Key size={13} />
                      API Key
                    </div>
                    <div className={styles.settingsGridValue}>
                      {settingsAgent.apiKeyName}{' '}
                      <code className={styles.settingsCode}>{settingsAgent.apiKeyPrefix}...</code>
                    </div>
                  </div>
                  <div className={styles.settingsGridItem}>
                    <div className={styles.settingsGridLabel}>Skip permissions</div>
                    <div className={styles.settingsGridValue}>
                      {settingsAgent.skipPermissions ? 'Enabled' : 'Disabled'}
                      <code className={styles.settingsCode}>{getSkipPermissionsFlag(settingsAgent.model)}</code>
                    </div>
                  </div>
                  <div className={styles.settingsGridItem}>
                    <div className={styles.settingsGridLabel}>
                      <Layers size={13} />
                      Group
                    </div>
                    <div className={styles.settingsGridValue}>
                      <select
                        className={styles.settingsGroupSelect}
                        value={settingsAgent.groupId || ''}
                        onChange={(e) => handleChangeAgentGroup(settingsAgent.id, e.target.value || null)}
                      >
                        <option value="">No group</option>
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>{g.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              {/* Capabilities section */}
              <div className={styles.settingsSection}>
                <div className={styles.settingsSectionTitle}>Capabilities</div>
                <div className={styles.capsList}>
                  {settingsAgent.capabilities.map((cap) => (
                    <Badge key={cap} color="info">{cap}</Badge>
                  ))}
                  {settingsAgent.capabilities.length === 0 && (
                    <span className={styles.settingsEmpty}>No capabilities assigned</span>
                  )}
                </div>
              </div>

              {/* Cron Jobs section */}
              <div className={styles.settingsSection}>
                <div className={styles.settingsSectionTitle}>Cron Jobs</div>

                {cronJobs.length > 0 && (
                  <div className={styles.cronJobList}>
                    {cronJobs.map((job) => (
                      <div key={job.id} className={styles.cronJobItem}>
                        <button
                          type="button"
                          className={styles.cronToggleBtn}
                          onClick={() => handleToggleCronJob(job.id)}
                          disabled={cronSaving}
                          title={job.enabled ? 'Disable' : 'Enable'}
                        >
                          {job.enabled
                            ? <ToggleRight size={20} className={styles.cronToggleOn} />
                            : <ToggleLeft size={20} className={styles.cronToggleOff} />
                          }
                        </button>
                        <div className={styles.cronJobInfo}>
                          <div className={styles.cronJobExpr}>
                            <code className={styles.settingsCode}>{job.cron}</code>
                            <span className={styles.cronJobDesc}>{describeCron(job.cron)}</span>
                          </div>
                          <div className={styles.cronJobPrompt}>
                            {job.prompt.length > 80 ? job.prompt.slice(0, 80) + '...' : job.prompt}
                          </div>
                        </div>
                        <button
                          type="button"
                          className={`${styles.cronDeleteBtn}`}
                          onClick={() => handleDeleteCronJob(job.id)}
                          disabled={cronSaving}
                          title="Delete cron job"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {cronFormOpen ? (
                  <div className={styles.cronForm}>
                    <div className={styles.cronFormRow}>
                      <div>
                        <div className={styles.fieldLabel}>Schedule</div>
                        <CronEditor value={cronFormCron} onChange={setCronFormCron} />
                      </div>
                    </div>
                    <div>
                      <div className={styles.fieldLabel}>Prompt</div>
                      <Textarea
                        rows={2}
                        placeholder="What should the agent do?"
                        value={cronFormPrompt}
                        onChange={(e) => setCronFormPrompt(e.target.value)}
                      />
                    </div>
                    <div className={styles.cronFormActions}>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => { setCronFormOpen(false); setCronFormCron(''); setCronFormPrompt(''); }}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={handleAddCronJob}
                        disabled={!cronFormCron.trim() || !cronFormPrompt.trim() || cronSaving}
                      >
                        {cronSaving ? 'Saving...' : 'Add Job'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => { setCronFormOpen(true); setCronFormCron('* * * * *'); }}
                  >
                    <Plus size={13} />
                    Add cron job
                  </Button>
                )}
              </div>

              {/* Activity section */}
              <div className={styles.settingsSection}>
                <div className={styles.settingsSectionTitle}>Activity</div>
                <div className={styles.settingsGrid}>
                  <div className={styles.settingsGridItem}>
                    <div className={styles.settingsGridLabel}>Last active</div>
                    <div className={styles.settingsGridValue}>
                      {settingsAgent.lastActivity
                        ? new Date(settingsAgent.lastActivity).toLocaleString()
                        : 'Never'}
                    </div>
                  </div>
                  <div className={styles.settingsGridItem}>
                    <div className={styles.settingsGridLabel}>Created</div>
                    <div className={styles.settingsGridValue}>
                      {new Date(settingsAgent.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className={styles.settingsActions}>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => handleToggleSkipPermissions(settingsAgent)}
                >
                  {settingsAgent.skipPermissions
                    ? 'Disable skip permissions'
                    : 'Enable skip permissions'}
                </Button>

                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => handleToggle(settingsAgent)}
                >
                  {settingsAgent.status === 'active' ? <PowerOff size={13} /> : <Power size={13} />}
                  {settingsAgent.status === 'active' ? 'Disable agent' : 'Enable agent'}
                </Button>

                <div className={styles.settingsActionsSpacer} />

                {deletingId === settingsAgent.id ? (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => setDeletingId(null)}>
                      Cancel
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => handleDelete(settingsAgent.id)}>
                      Confirm Delete
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => setDeletingId(settingsAgent.id)}>
                    <Trash2 size={13} />
                    Delete
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
