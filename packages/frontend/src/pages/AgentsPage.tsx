import {
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type Dispatch,
  type DragEvent as ReactDragEvent,
  Fragment,
  type FormEvent,
  type KeyboardEvent,
  memo,
  type SetStateAction,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
  Image,
  Paperclip,
  ChevronDown,
  ChevronRight,
  HardDrive,
  Copy,
  Check,
  Shield,
  ToggleLeft,
  ToggleRight,
  Layers,
  Pencil,
  Link2,
  SlidersHorizontal,
  Eraser,
  Clock,
  Loader,
  Blocks,
  Square,
  ChevronsDownUp,
  ChevronsUpDown,
  MoreHorizontal,
  ArrowLeft,
  ArrowRight,
  FileText,
  RotateCcw,
  OctagonX,
} from 'lucide-react';
import { formatDate } from 'shared';
import {
  Button,
  Badge,
  Input,
  Textarea,
  Select,
  CronEditor,
  ApiKeyFormFields,
  MarkdownContent,
  Tooltip,
} from '../ui';
import { api, apiUpload, ApiError } from '../lib/api';
import {
  AGENT_MODEL_PROVIDERS as MODELS,
  getAgentModelDefaultId,
  getAgentModelOptions,
} from '../lib/agent-models';
import { toast } from '../stores/toast';
import {
  getImagesFromClipboardData,
  getImagesFromFileList,
  isImageFile,
  prepareImageForUpload,
} from '../lib/image-upload';
import { scrollToFirstError } from '../lib/scroll-to-error';
import { useConfirm } from '../hooks/useConfirm';
import { FileBrowser } from '../components/FileBrowser';
import { FileSystemBrowserModal } from '../components/FileSystemBrowserModal';
import {
  AgentAvatar,
  AgentAvatarPicker,
  randomPalette,
  randomIcon,
  type AvatarConfig,
  type SavedAvatarPreset,
  type SavedColorPreset,
} from '../components/AgentAvatar';
import { useWorkspace } from '../stores/WorkspaceContext';
import styles from './AgentsPage.module.css';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  buildAgentConversationViewModel,
  getBranchTargetIdByOffset,
  queueItemsLabel,
  toQueueCount,
} from './agent-chat-view-model';

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

interface AgentDefaultsResponse {
  defaultAgentKeyId: string | null;
}

interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  nextRunAt?: string | null;
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

interface AgentEnvVar {
  id: string;
  agentId: string;
  key: string;
  valuePreview: string;
  description: string | null;
  isActive: boolean;
  createdById: string;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AgentEnvVarFormState {
  id: string | null;
  key: string;
  value: string;
  description: string;
  isActive: boolean;
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
  parameters?: PresetParameter[];
}

interface PresetParameter {
  key: string;
  label: string;
  description?: string;
  placeholder?: string;
  required: boolean;
  type: 'text' | 'directory';
}

type AvatarPreset = SavedAvatarPreset;
type ColorPreset = SavedColorPreset;

interface ChatConversation {
  id: string;
  subject: string | null;
  lastMessageAt: string | null;
  isUnread: boolean;
  isBusy?: boolean;
  queuedCount?: number;
  hasFailed?: boolean;
  updatedAt: string;
  createdAt: string;
}

interface ConversationBootstrapRequest {
  agentId: string;
  conversationId: string | null;
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
  metadata?: string | null;
  attachments?: ChatAttachment[] | null;
  parentId?: string | null;
  siblingIndex?: number;
  siblingCount?: number;
  siblingIds?: string[];
}

interface QueuePromptResponse {
  status: 'queued';
  queuedCount?: number;
}

interface QueueItem {
  id: string;
  agentId: string;
  conversationId: string;
  mode?: 'append_prompt' | 'respond_to_message';
  prompt: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  attempts: number;
  createdAt: string;
  updatedAt?: string;
  targetMessageId?: string | null;
  queuedMessageId?: string | null;
  responseMessageId?: string | null;
  errorMessage?: string | null;
  nextAttemptAt?: string | null;
  completedAt?: string | null;
  runId?: string | null;
  lastRunId?: string | null;
  usedFallback?: boolean;
  fallbackModel?: string | null;
}

interface AgentRunSummary {
  id: string;
  agentId: string;
  conversationId: string | null;
  responseParentId?: string | null;
  status: 'running' | 'completed' | 'error';
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
}

interface EditMessageResponse {
  message: ChatMessage;
  entries: ChatMessage[];
  queueItem: QueueItem;
}

interface AgentMessageMetadata {
  runId?: string | null;
  agentChatUpdate?: boolean;
  isFinal?: boolean;
  queuedFailure?: boolean;
  fallbackRetry?: boolean;
  fallbackModel?: string | null;
}

interface StagedImage {
  file: File;
  previewUrl: string;
}

interface DraftAttachment {
  file: File;
  kind: 'image' | 'file';
  previewUrl: string | null;
}

interface ManagedExistingImage {
  storagePath: string;
  fileName: string;
}

interface EditingMessageState {
  agentId: string;
  conversationId: string;
  id: string;
  initialValue: string;
  value: string;
  existingImages: ManagedExistingImage[];
  isSubmitting: boolean;
}

interface ReplyComposerProps {
  streaming: boolean;
  editingMessage?: {
    agentId: string;
    conversationId: string;
    id: string;
    initialValue: string;
    value: string;
    existingImages: ManagedExistingImage[];
    isSubmitting: boolean;
    onChange: (value: string) => void;
    onCancel: () => void;
    onSubmit: (files: File[], keepStoragePaths: string[]) => Promise<void>;
  } | null;
  onSendAttachments: (caption: string, files: File[]) => Promise<void>;
  onSendText: (prompt: string) => Promise<void>;
}

const MAX_STAGED_ATTACHMENTS = 10;
const AGENT_CHAT_DRAFT_STORAGE_KEY = 'openwork_agent_chat_global_draft';

export function getChatMessageImages(
  message: Pick<ChatMessage, 'attachments'>,
): ManagedExistingImage[] {
  return (
    message.attachments
      ?.filter((attachment) => attachment.type === 'image')
      .map((attachment) => ({
        storagePath: attachment.storagePath,
        fileName: attachment.fileName,
      })) ?? []
  );
}

export function isEditableChatMessage(message: ChatMessage): boolean {
  if (message.direction !== 'outbound') return false;
  const type = message.type ?? 'text';
  return type === 'text' || type === 'image';
}

function readAgentChatDraft(): string {
  if (typeof window === 'undefined') return '';
  try {
    const raw = window.localStorage.getItem(AGENT_CHAT_DRAFT_STORAGE_KEY);
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

function persistAgentChatDraft(content: string) {
  if (typeof window === 'undefined') return;
  const nextContent = content.trim();
  try {
    if (nextContent.length === 0) {
      window.localStorage.removeItem(AGENT_CHAT_DRAFT_STORAGE_KEY);
    } else {
      window.localStorage.setItem(AGENT_CHAT_DRAFT_STORAGE_KEY, content);
    }
  } catch {
    // Ignore storage write failures and keep the in-memory draft usable.
  }
}

function parseAgentMessageMetadata(raw: string | null | undefined): AgentMessageMetadata | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AgentMessageMetadata;
  } catch {
    return null;
  }
}

function buildMonitorRunUrl(runId: string): string {
  return `/monitor?${new URLSearchParams({ runId }).toString()}`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

export const ReplyComposer = memo(function ReplyComposer({
  streaming,
  editingMessage = null,
  onSendAttachments,
  onSendText,
}: ReplyComposerProps) {
  const [input, setInput] = useState(() => readAgentChatDraft());
  const [uploading, setUploading] = useState(false);
  const [draftStagedAttachments, setDraftStagedAttachments] = useState<DraftAttachment[]>([]);
  const [editStagedImages, setEditStagedImages] = useState<StagedImage[]>([]);
  const [retainedEditImages, setRetainedEditImages] = useState<ManagedExistingImage[]>([]);
  const [draggingOver, setDraggingOver] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isEditing = editingMessage !== null;
  const editingSubmitting = isEditing && editingMessage.isSubmitting;
  const composerValue = isEditing ? editingMessage.value : input;
  const draftStagedImages = draftStagedAttachments.filter(
    (attachment): attachment is DraftAttachment & { kind: 'image'; previewUrl: string } =>
      attachment.kind === 'image' && Boolean(attachment.previewUrl),
  );
  const stagedImages = isEditing ? editStagedImages : draftStagedImages;
  const existingImages = isEditing ? retainedEditImages : [];
  const totalAttachmentCount = isEditing
    ? stagedImages.length + existingImages.length
    : draftStagedAttachments.length;
  const trimmedComposerValue = isEditing ? editingMessage.value.trim() : input.trim();
  const existingImagesChanged = isEditing
    ? editingMessage.existingImages.length !== retainedEditImages.length ||
      editingMessage.existingImages.some(
        (image, index) => retainedEditImages[index]?.storagePath !== image.storagePath,
      )
    : false;
  const canSubmitEdit = isEditing
    ? (trimmedComposerValue !== editingMessage.initialValue.trim() ||
        stagedImages.length > 0 ||
        existingImagesChanged) &&
      (trimmedComposerValue.length > 0 || totalAttachmentCount > 0)
    : false;

  const clearImageSet = useCallback((setImages: Dispatch<SetStateAction<StagedImage[]>>) => {
    setImages((prev) => {
      for (const img of prev) URL.revokeObjectURL(img.previewUrl);
      return [];
    });
  }, []);

  const clearDraftStagedAttachments = useCallback(() => {
    setDraftStagedAttachments((prev) => {
      for (const attachment of prev) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      return [];
    });
    if (imageInputRef.current) imageInputRef.current.value = '';
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const clearEditStagedImages = useCallback(() => {
    clearImageSet(setEditStagedImages);
    if (imageInputRef.current) imageInputRef.current.value = '';
  }, [clearImageSet]);

  useEffect(
    () => () => {
      clearDraftStagedAttachments();
      clearEditStagedImages();
    },
    [clearDraftStagedAttachments, clearEditStagedImages],
  );

  useEffect(() => {
    setRetainedEditImages(editingMessage?.existingImages ?? []);
    clearEditStagedImages();
  }, [clearEditStagedImages, editingMessage?.existingImages, editingMessage?.id]);

  useEffect(() => {
    if (isEditing) return;
    persistAgentChatDraft(input);
  }, [input, isEditing]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [isEditing]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (!composerValue) {
      el.style.height = '';
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 400)}px`;
  }, [composerValue]);

  const stageImages = useCallback(
    (files: File[]) => {
      const images = files.filter(isImageFile);
      if (images.length === 0) return;
      if (isEditing) {
        setEditStagedImages((prev) => {
          const remaining = MAX_STAGED_ATTACHMENTS - prev.length - retainedEditImages.length;
          if (remaining <= 0) return prev;
          const toAdd = images.slice(0, remaining).map((file) => ({
            file,
            previewUrl: URL.createObjectURL(file),
          }));
          return [...prev, ...toAdd];
        });
        return;
      }
      setDraftStagedAttachments((prev) => {
        const remaining = MAX_STAGED_ATTACHMENTS - prev.length;
        if (remaining <= 0) return prev;
        const toAdd = images.slice(0, remaining).map((file) => ({
          file,
          kind: 'image' as const,
          previewUrl: URL.createObjectURL(file),
        }));
        return [...prev, ...toAdd];
      });
    },
    [isEditing, retainedEditImages.length],
  );

  const stageFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setDraftStagedAttachments((prev) => {
      const remaining = MAX_STAGED_ATTACHMENTS - prev.length;
      if (remaining <= 0) return prev;
      const toAdd = files.slice(0, remaining).map((file) => ({
        file,
        kind: isImageFile(file) ? ('image' as const) : ('file' as const),
        previewUrl: isImageFile(file) ? URL.createObjectURL(file) : null,
      }));
      return [...prev, ...toAdd];
    });
  }, []);

  const removeDraftAttachment = useCallback((index: number) => {
    setDraftStagedAttachments((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return next;
    });
  }, []);

  const removeStagedImage = useCallback(
    (index: number) => {
      if (!isEditing) {
        removeDraftAttachment(index);
        return;
      }
      setEditStagedImages((prev) => {
        const next = [...prev];
        const [removed] = next.splice(index, 1);
        if (removed) URL.revokeObjectURL(removed.previewUrl);
        return next;
      });
    },
    [isEditing, removeDraftAttachment],
  );

  const removeExistingImage = useCallback((storagePath: string) => {
    setRetainedEditImages((prev) => prev.filter((image) => image.storagePath !== storagePath));
  }, []);

  const handleSend = useCallback(async () => {
    if (uploading || editingSubmitting) return;

    if (isEditing) {
      const nextValue = editingMessage.value.trim();
      const hasImages = editStagedImages.length > 0;
      const keptStoragePaths = retainedEditImages.map((image) => image.storagePath);
      if (!nextValue && !hasImages && keptStoragePaths.length === 0) return;
      try {
        await editingMessage.onSubmit(
          editStagedImages.map((img) => img.file),
          keptStoragePaths,
        );
        clearEditStagedImages();
      } catch {
        // Parent state already surfaces the failure; keep the draft intact for retry.
      } finally {
        inputRef.current?.focus();
      }
      return;
    }

    const prompt = input.trim();
    const hasAttachments = draftStagedAttachments.length > 0;
    if (!prompt && !hasAttachments) return;

    if (hasAttachments) {
      if (streaming) return;
      setUploading(true);
      try {
        await onSendAttachments(
          prompt,
          draftStagedAttachments.map((attachment) => attachment.file),
        );
        clearDraftStagedAttachments();
        setInput('');
        persistAgentChatDraft('');
      } catch {
        // Parent state already surfaces the failure.
      } finally {
        setUploading(false);
        inputRef.current?.focus();
      }
      return;
    }

    try {
      await onSendText(prompt);
      setInput('');
      persistAgentChatDraft('');
    } catch {
      // Parent state already surfaces the failure.
    } finally {
      inputRef.current?.focus();
    }
  }, [
    clearDraftStagedAttachments,
    clearEditStagedImages,
    draftStagedAttachments,
    editingSubmitting,
    editStagedImages,
    editingMessage,
    input,
    isEditing,
    onSendAttachments,
    onSendText,
    streaming,
    uploading,
  ]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const handlePaste = useCallback(
    (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
      const files = getImagesFromClipboardData(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      stageImages(files);
    },
    [stageImages],
  );

  const handleDragOver = useCallback((e: ReactDragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      setDraggingOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: ReactDragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: ReactDragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDraggingOver(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length === 0) return;
      if (isEditing) {
        stageImages(files);
      } else {
        stageFiles(files);
      }
    },
    [isEditing, stageFiles, stageImages],
  );

  const handleImageSelect = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = getImagesFromFileList(e.target.files);
      if (files.length > 0) stageImages(files);
      e.target.value = '';
    },
    [stageImages],
  );

  const handleFileSelect = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) stageFiles(files);
      e.target.value = '';
    },
    [stageFiles],
  );

  const handleEditCancel = useCallback(() => {
    if (editingSubmitting) return;
    clearEditStagedImages();
    editingMessage?.onCancel();
  }, [clearEditStagedImages, editingMessage, editingSubmitting]);

  return (
    <div
      className={`${styles.replyBox} ${draggingOver ? styles.replyBoxDragOver : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {(uploading || editingSubmitting) && (
        <div className={styles.uploadingIndicator}>
          {editingSubmitting ? 'Saving edit…' : 'Uploading attachments…'}
        </div>
      )}
      {isEditing && (
        <div className={styles.composerEditBar}>
          <div className={styles.composerEditMeta}>
            <Pencil size={13} />
            Editing message
          </div>
          <button
            className={styles.composerEditCancel}
            onClick={handleEditCancel}
            disabled={editingSubmitting}
          >
            Cancel
          </button>
        </div>
      )}
      {(existingImages.length > 0 ||
        (!isEditing && draftStagedAttachments.length > 0) ||
        (isEditing && stagedImages.length > 0)) && (
        <div className={styles.stagedImagesRow}>
          {existingImages.map((img) => (
            <div key={img.storagePath} className={styles.stagedImagePreview}>
              <StorageImageThumb
                storagePath={img.storagePath}
                alt={img.fileName}
                className={styles.stagedImageThumb}
                placeholderClassName={styles.stagedImageThumbPlaceholder}
              />
              <button
                className={styles.stagedImageRemove}
                onClick={() => removeExistingImage(img.storagePath)}
                aria-label="Remove image"
                disabled={editingSubmitting}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {isEditing
            ? stagedImages.map((img, i) => (
                <div key={img.previewUrl} className={styles.stagedImagePreview}>
                  <img src={img.previewUrl} alt="Preview" className={styles.stagedImageThumb} />
                  <button
                    className={styles.stagedImageRemove}
                    onClick={() => removeStagedImage(i)}
                    aria-label="Remove image"
                    disabled={editingSubmitting}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))
            : draftStagedAttachments.map((attachment, i) =>
                attachment.kind === 'image' && attachment.previewUrl ? (
                  <div key={attachment.previewUrl} className={styles.stagedImagePreview}>
                    <img
                      src={attachment.previewUrl}
                      alt={attachment.file.name}
                      className={styles.stagedImageThumb}
                    />
                    <button
                      className={styles.stagedImageRemove}
                      onClick={() => removeDraftAttachment(i)}
                      aria-label="Remove attachment"
                      disabled={uploading}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <div key={`${attachment.file.name}-${i}`} className={styles.stagedFileChip}>
                    <FileText size={14} className={styles.stagedFileIcon} />
                    <div className={styles.stagedFileMeta}>
                      <span className={styles.stagedFileName}>{attachment.file.name}</span>
                      <span className={styles.stagedFileSize}>
                        {formatBytes(attachment.file.size)}
                      </span>
                    </div>
                    <button
                      className={styles.stagedFileRemove}
                      onClick={() => removeDraftAttachment(i)}
                      aria-label="Remove attachment"
                      disabled={uploading}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ),
              )}
        </div>
      )}
      <div className={styles.replyRow}>
        <>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            className={styles.hiddenFileInput}
            onChange={handleImageSelect}
          />
          {!isEditing && (
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className={styles.hiddenFileInput}
              onChange={handleFileSelect}
            />
          )}
          <div className={styles.attachmentButtons}>
            <button
              className={styles.attachBtn}
              onClick={() => imageInputRef.current?.click()}
              disabled={
                uploading ||
                editingSubmitting ||
                (!isEditing && streaming) ||
                totalAttachmentCount >= MAX_STAGED_ATTACHMENTS
              }
              aria-label="Attach images"
              title={
                totalAttachmentCount >= MAX_STAGED_ATTACHMENTS
                  ? `Max ${MAX_STAGED_ATTACHMENTS} attachments`
                  : 'Attach images'
              }
            >
              <Image size={16} />
            </button>
            {!isEditing && (
              <button
                className={styles.attachBtn}
                onClick={() => fileInputRef.current?.click()}
                disabled={
                  uploading ||
                  editingSubmitting ||
                  streaming ||
                  totalAttachmentCount >= MAX_STAGED_ATTACHMENTS
                }
                aria-label="Attach files"
                title={
                  totalAttachmentCount >= MAX_STAGED_ATTACHMENTS
                    ? `Max ${MAX_STAGED_ATTACHMENTS} attachments`
                    : 'Attach files'
                }
              >
                <Paperclip size={16} />
              </button>
            )}
          </div>
        </>
        <textarea
          ref={inputRef}
          className={styles.replyInput}
          placeholder={
            isEditing
              ? 'Edit your message…'
              : totalAttachmentCount > 0
                ? 'Add a note… (optional)'
                : streaming
                  ? 'Type to queue a message…'
                  : 'Type a message…'
          }
          value={composerValue}
          onChange={(e) =>
            isEditing ? editingMessage.onChange(e.target.value) : setInput(e.target.value)
          }
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={1}
          disabled={uploading || editingSubmitting}
        />
        <button
          className={styles.sendBtn}
          onClick={() => void handleSend()}
          disabled={
            uploading ||
            editingSubmitting ||
            (isEditing
              ? !canSubmitEdit
              : !composerValue.trim() && draftStagedAttachments.length === 0)
          }
          aria-label={isEditing ? 'Save edited message' : 'Send message'}
          title={isEditing ? 'Save edited message' : 'Send message'}
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
});

function StorageImageThumb({
  storagePath,
  alt,
  className,
  placeholderClassName,
}: {
  storagePath: string;
  alt: string;
  className: string;
  placeholderClassName: string;
}) {
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

  if (!src) return <div className={placeholderClassName}>Loading…</div>;
  return <img className={className} src={src} alt={alt} />;
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

async function downloadStorageFile(storagePath: string, fileName: string) {
  const token = localStorage.getItem('ws_access_token');
  const res = await fetch(`/api/storage/download?path=${encodeURIComponent(storagePath)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error('Failed to download file');

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function ChatFileAttachment({ attachment }: { attachment: ChatAttachment }) {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadStorageFile(attachment.storagePath, attachment.fileName);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to download file');
    } finally {
      setDownloading(false);
    }
  }, [attachment.fileName, attachment.storagePath, downloading]);

  return (
    <button className={styles.chatFileLink} onClick={() => void handleDownload()} type="button">
      <FileText size={16} className={styles.chatFileIcon} />
      <div className={styles.chatFileMeta}>
        <span className={styles.chatFileName}>{attachment.fileName}</span>
        <span className={styles.chatFileSize}>
          {attachment.fileSize != null ? formatBytes(attachment.fileSize) : attachment.mimeType}
        </span>
      </div>
      <Download size={14} className={styles.chatFileDownload} />
      {downloading && <span className={styles.chatFileLoading}>Loading…</span>}
    </button>
  );
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

function envVarTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function createEmptyAgentEnvVarForm(): AgentEnvVarFormState {
  return {
    id: null,
    key: '',
    value: '',
    description: '',
    isActive: true,
  };
}

const AGENT_ENV_VAR_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const RESERVED_AGENT_ENV_VAR_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'HOME',
  'NODE_ENV',
  'OPENAI_API_KEY',
  'PATH',
  'PROJECTS_DIR',
  'PROJECT_PORT',
  'PWD',
  'SHELL',
  'WORKSPACE_API_KEY',
  'WORKSPACE_API_URL',
]);

function validateAgentEnvVarForm(form: AgentEnvVarFormState): Record<string, string> {
  const errors: Record<string, string> = {};
  const normalizedKey = form.key.trim().toUpperCase();

  if (!normalizedKey) {
    errors.key = 'Env var name is required';
  } else if (!AGENT_ENV_VAR_KEY_PATTERN.test(normalizedKey)) {
    errors.key = 'Use letters, numbers, and underscores only, starting with a letter';
  } else if (RESERVED_AGENT_ENV_VAR_KEYS.has(normalizedKey)) {
    errors.key = `"${normalizedKey}" is reserved by OpenWork`;
  }

  if (!form.value && !form.id) {
    errors.value = 'Value is required';
  }

  return errors;
}

function mapAgentEnvVarApiErrorToFormErrors(
  error: unknown,
  hasExistingValue: boolean,
): Record<string, string> | null {
  if (!(error instanceof ApiError) || !error.message) return null;

  if (error.message.includes('key must match')) {
    return { key: 'Use letters, numbers, and underscores only, starting with a letter' };
  }

  if (error.message.includes('already exists') || error.message.includes('is reserved')) {
    return { key: error.message };
  }

  if (error.message.includes('value is required')) {
    return { value: 'Value is required' };
  }

  if (error.message.includes('value cannot be empty')) {
    return {
      value: hasExistingValue ? 'Replacement value cannot be empty' : 'Value is required',
    };
  }

  return null;
}

type ModelId = (typeof MODELS)[number]['id'];

type ThinkingLevel = 'low' | 'medium' | 'high';

interface CreateAgentForm {
  name: string;
  description: string;
  model: ModelId;
  modelId: string;
  thinkingLevel: ThinkingLevel | '';
  preset: string;
  presetParameters: Record<string, string>;
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
    presetParameters: {},
    apiKeyId: '',
    skipPermissions: false,
    groupId: '',
    newKey: false,
    newKeyPermissions: [],
    avatar: { icon: randomIcon(), bgColor, logoColor },
  };
}

function filterPresetParameterValues(
  preset: Preset | undefined,
  values: Record<string, string>,
): Record<string, string> {
  const allowedKeys = new Set((preset?.parameters ?? []).map((parameter) => parameter.key));
  return Object.fromEntries(Object.entries(values).filter(([key]) => allowedKeys.has(key)));
}

function serializePresetParameters(
  preset: Preset | undefined,
  values: Record<string, string>,
): Record<string, string> | undefined {
  const entries = (preset?.parameters ?? [])
    .map((parameter) => [parameter.key, values[parameter.key]?.trim() ?? ''] as const)
    .filter(([, value]) => value.length > 0);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
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
  if (normalized === 'cursor') return '--force --trust';
  if (normalized === 'opencode') return 'allow-by-default';
  if (normalized === 'qwen') return '--approval-mode yolo';
  return 'not supported';
}

function supportsThinkingLevel(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized === 'claude' || normalized === 'codex' || normalized === 'opencode';
}

function getModelVariantHint(model: string): string {
  const normalized = model.toLowerCase();
  if (normalized === 'cursor') {
    return 'Curated from the installed Cursor CLI model list on this server';
  }
  if (normalized === 'opencode') {
    return 'Uses provider/model IDs. Run opencode models on the server for the full list';
  }
  return 'Override the default model used by the CLI';
}

function getCliInfoForModel(
  cliStatus: CliInfo[],
  model: string | null | undefined,
): CliInfo | undefined {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return undefined;
  return cliStatus.find((entry) => entry.id === normalized);
}

function getCliUnavailableMessage(cliInfo: CliInfo): string {
  return (
    `${cliInfo.name} CLI is not installed or not available on this server ` +
    `(expected command: ${cliInfo.command}). Install it from ${cliInfo.downloadUrl}.`
  );
}

function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*')
    return 'Every minute';
  if (min !== '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*')
    return `Every hour at minute ${min}`;
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

function describeCronNextRun(job: Pick<CronJob, 'enabled' | 'nextRunAt'>): string {
  if (!job.enabled) return 'Next trigger disabled';
  if (!job.nextRunAt) return 'Next trigger unavailable';
  return `Next trigger ${formatDate(job.nextRunAt)}`;
}

interface AgentSidebarItemProps {
  agent: Agent;
  conversations: ChatConversation[];
  collapsed: boolean;
  isActive: boolean;
  activeConversationId: string | null;
  groupsEnabled: boolean;
  pendingConversationKeys: Set<string>;
  onToggleCollapse: (agentId: string) => void;
  onOpenContextMenu: (agentId: string, x: number, y: number) => void;
  onOpenSettings: (agent: Agent) => void;
  onCleanConversations: (agentId: string) => void;
  onCreateConversation: (agentId: string) => void;
  onSelectConversation: (agentId: string, conversationId: string) => void;
  onDeleteConversation: (agentId: string, conversationId: string) => void;
}

const AgentSidebarItem = memo(function AgentSidebarItem({
  agent,
  conversations,
  collapsed,
  isActive,
  activeConversationId,
  groupsEnabled,
  pendingConversationKeys,
  onToggleCollapse,
  onOpenContextMenu,
  onOpenSettings,
  onCleanConversations,
  onCreateConversation,
  onSelectConversation,
  onDeleteConversation,
}: AgentSidebarItemProps) {
  const hasUnreadAny = conversations.some((conversation) => conversation.isUnread);
  const hasStreamingAny = conversations.some(
    (conversation) =>
      Boolean(conversation.isBusy) ||
      pendingConversationKeys.has(agentConversationKey(agent.id, conversation.id)),
  );
  const queuedTotal = conversations.reduce(
    (sum, conversation) => sum + toQueueCount(conversation.queuedCount),
    0,
  );

  return (
    <div className={styles.agentGroup}>
      <div
        className={`${styles.agentGroupHeader} ${isActive ? styles.agentGroupHeaderActive : ''}`}
        onClick={() => {
          if (conversations.length > 0) {
            onSelectConversation(agent.id, conversations[0].id);
          } else {
            onCreateConversation(agent.id);
          }
        }}
        onContextMenu={(e) => {
          if (!groupsEnabled) return;
          e.preventDefault();
          onOpenContextMenu(agent.id, e.clientX, e.clientY);
        }}
      >
        <ChevronRight
          size={14}
          className={`${styles.agentGroupChevron} ${!collapsed ? styles.agentGroupChevronOpen : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse(agent.id);
          }}
        />
        <div className={styles.agentAvatarWrapper}>
          <AgentAvatar
            icon={agent.avatarIcon || 'spark'}
            bgColor={agent.avatarBgColor || '#1a1a2e'}
            logoColor={agent.avatarLogoColor || '#e94560'}
            size={28}
          />
          {hasUnreadAny ? (
            <span
              className={styles.agentStatusDot}
              style={{ background: 'var(--color-primary)' }}
              title="Has unread messages"
            />
          ) : hasStreamingAny ? (
            <span
              className={styles.agentStreamingDot}
              title={
                queuedTotal > 0
                  ? `Queued in backend: ${queueItemsLabel(queuedTotal)}`
                  : 'Agent is responding...'
              }
            />
          ) : null}
        </div>
        <div className={styles.agentGroupInfo}>
          <div className={styles.agentGroupName}>{agent.name}</div>
        </div>
        <div className={styles.agentGroupActions}>
          <Tooltip label="Settings">
            <button
              className={styles.agentGroupIconBtn}
              onClick={(e) => {
                e.stopPropagation();
                onOpenSettings(agent);
              }}
              aria-label="Agent settings"
            >
              <Settings size={14} />
            </button>
          </Tooltip>
          <Tooltip label="Clean chats">
            <button
              className={styles.agentGroupIconBtn}
              onClick={(e) => {
                e.stopPropagation();
                void onCleanConversations(agent.id);
              }}
              aria-label="Clean chats"
            >
              <Eraser size={14} />
            </button>
          </Tooltip>
          <Tooltip label="New chat">
            <button
              className={styles.agentGroupIconBtn}
              onClick={(e) => {
                e.stopPropagation();
                onCreateConversation(agent.id);
              }}
              aria-label="New chat"
            >
              <Plus size={14} />
            </button>
          </Tooltip>
        </div>
      </div>

      {!collapsed && conversations.length > 0 && (
        <div className={styles.convList}>
          {conversations.map((conversation) => {
            const isStreaming =
              Boolean(conversation.isBusy) ||
              pendingConversationKeys.has(agentConversationKey(agent.id, conversation.id));
            const isUnread = conversation.isUnread;
            const queuedCount = toQueueCount(conversation.queuedCount);
            const hasFailed = Boolean(conversation.hasFailed);
            const streamingTitle =
              queuedCount > 0
                ? `Queued in backend: ${queueItemsLabel(queuedCount)}`
                : 'Agent is responding...';
            return (
              <div
                key={conversation.id}
                className={`${styles.convItem} ${
                  isActive && activeConversationId === conversation.id ? styles.convItemActive : ''
                }`}
                onClick={() => onSelectConversation(agent.id, conversation.id)}
              >
                {isStreaming && <span className={styles.convStreamingDot} title={streamingTitle} />}
                {!isStreaming && isUnread && (
                  <span className={styles.convUnreadDot} title="New response" />
                )}
                <div className={styles.convItemInfo}>
                  <div className={styles.convItemTitle}>
                    {conversation.subject || 'New conversation'}
                  </div>
                </div>
                {queuedCount > 0 && (
                  <span className={styles.convQueueBadge} title={queueItemsLabel(queuedCount)}>
                    <Clock size={9} />
                    {queuedCount}
                  </span>
                )}
                {hasFailed && (
                  <span className={styles.convFailedBadge} title="Latest active branch failed">
                    <AlertTriangle size={10} />
                    Failed
                  </span>
                )}
                <span className={styles.convItemTime}>
                  {relativeTime(conversation.lastMessageAt || conversation.createdAt)}
                </span>
                <button
                  className={styles.convItemDelete}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteConversation(agent.id, conversation.id);
                  }}
                  aria-label="Delete conversation"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
          <button className={styles.newConvBtn} onClick={() => onCreateConversation(agent.id)}>
            <Plus size={13} />
            New chat
          </button>
        </div>
      )}
    </div>
  );
}, areAgentSidebarItemPropsEqual);

function areAgentSidebarItemPropsEqual(
  prev: AgentSidebarItemProps,
  next: AgentSidebarItemProps,
): boolean {
  if (prev.agent !== next.agent) return false;
  if (prev.conversations !== next.conversations) return false;
  if (prev.collapsed !== next.collapsed) return false;
  if (prev.isActive !== next.isActive) return false;
  if (prev.activeConversationId !== next.activeConversationId) return false;
  if (prev.groupsEnabled !== next.groupsEnabled) return false;
  if (prev.pendingConversationKeys === next.pendingConversationKeys) return true;

  for (const conversation of prev.conversations) {
    const key = agentConversationKey(prev.agent.id, conversation.id);
    if (prev.pendingConversationKeys.has(key) !== next.pendingConversationKeys.has(key)) {
      return false;
    }
  }

  return true;
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
      Number(a[i].queuedCount ?? 0) !== Number(b[i].queuedCount ?? 0) ||
      Boolean(a[i].hasFailed) !== Boolean(b[i].hasFailed) ||
      a[i].updatedAt !== b[i].updatedAt
    ) {
      return false;
    }
  }
  return true;
}

function agentConversationKey(agentId: string, conversationId: string): string {
  return `${agentId}:${conversationId}`;
}

function mergeConversationIntoList(
  conversations: ChatConversation[],
  conversation: ChatConversation | null,
): ChatConversation[] {
  if (!conversation) return conversations;
  if (conversations.some((entry) => entry.id === conversation.id)) return conversations;
  return [conversation, ...conversations];
}

function readConversationBootstrapRequest(
  searchParams: URLSearchParams,
): ConversationBootstrapRequest | null {
  const agentId =
    searchParams.get('agentId') ?? searchParams.get('id') ?? searchParams.get('settingsAgentId');
  if (!agentId) return null;
  return {
    agentId,
    conversationId: searchParams.get('conversationId'),
  };
}

function areConversationBootstrapRequestsEqual(
  a: ConversationBootstrapRequest | null,
  b: ConversationBootstrapRequest | null,
): boolean {
  return a?.agentId === b?.agentId && a?.conversationId === b?.conversationId;
}

const RUN_HANDOFF_MS = 6000;
const SCROLL_BOTTOM_THRESHOLD_PX = 80;

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/* ── Agent Files sub-component ── */

function agentFileEndpoints(agentId: string) {
  const enc = encodeURIComponent;
  return {
    list: (dirPath: string) => `/agents/${agentId}/files?path=${enc(dirPath)}`,
    createFolder: `/agents/${agentId}/files/folders`,
    upload: `/agents/${agentId}/files/upload`,
    download: (filePath: string) => `/agents/${agentId}/files/download?path=${enc(filePath)}`,
    readTextContent: (filePath: string) => `/agents/${agentId}/files/content?path=${enc(filePath)}`,
    writeTextContent: `/agents/${agentId}/files/content`,
    delete: (entryPath: string) => `/agents/${agentId}/files?path=${enc(entryPath)}`,
    reveal: `/agents/${agentId}/files/reveal`,
    rename: `/agents/${agentId}/files/rename`,
  };
}

function skillFileEndpoints(skillId: string) {
  const enc = encodeURIComponent;
  return {
    list: (dirPath: string) => `/skills/${skillId}/files?path=${enc(dirPath)}`,
    createFolder: `/skills/${skillId}/files/folders`,
    upload: `/skills/${skillId}/files/upload`,
    download: (filePath: string) => `/skills/${skillId}/files/download?path=${enc(filePath)}`,
    readTextContent: (filePath: string) => `/skills/${skillId}/files/content?path=${enc(filePath)}`,
    writeTextContent: `/skills/${skillId}/files/content`,
    delete: (entryPath: string) => `/skills/${skillId}/files?path=${enc(entryPath)}`,
    reveal: `/skills/${skillId}/files/reveal`,
  };
}

function AgentFiles({ agentId }: { agentId: string }) {
  const [showFsBrowser, setShowFsBrowser] = useState(false);
  const [refKey, setRefKey] = useState(0);

  const [skillsPickerOpen, setSkillsPickerOpen] = useState(false);
  const [allSkills, setAllSkills] = useState<{ id: string; name: string; description: string }[]>(
    [],
  );
  const [agentSkills, setAgentSkills] = useState<AgentLocalSkill[]>([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);

  const endpoints = useMemo(() => agentFileEndpoints(agentId), [agentId]);

  const loadSkills = useCallback(async () => {
    const [allData, agentData] = await Promise.all([
      api<{ entries: { id: string; name: string; description: string }[] }>('/skills'),
      api<{ entries: AgentLocalSkill[] }>(`/agents/${agentId}/skills`),
    ]);
    setAllSkills(allData.entries);
    setAgentSkills(agentData.entries);
    setSkillsLoaded(true);
  }, [agentId]);

  useEffect(() => {
    if (skillsLoaded) return;
    (async () => {
      try {
        await loadSkills();
      } catch {
        /* ignore */
      }
    })();
  }, [loadSkills, skillsLoaded]);

  useEffect(() => {
    setSkillsLoaded(false);
  }, [agentId]);

  const installedSkillSlugs = new Set(agentSkills.map((skill) => localSkillSlug(skill.path)));
  const unattachedSkills = allSkills.filter(
    (skill) => !installedSkillSlugs.has(slugifySkillName(skill.name)),
  );

  async function openSkillsPicker() {
    setSkillsPickerOpen(true);
    try {
      await loadSkills();
    } catch {
      /* ignore */
    }
  }

  async function handleAttachSkill(skillId: string) {
    try {
      const data = await api<{ entries: AgentLocalSkill[] }>(`/agents/${agentId}/skills`, {
        method: 'POST',
        body: JSON.stringify({ skillId }),
      });
      setAgentSkills(data.entries);
      setSkillsPickerOpen(false);
      toast.success('Skill added');
      setRefKey((k) => k + 1);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to add skill');
    }
  }

  async function handleDetachSkill(skillId: string) {
    try {
      await api(`/agents/${agentId}/skills/${skillId}`, { method: 'DELETE' });
      setAgentSkills((prev) => prev.filter((skill) => skill.id !== skillId));
      toast.success('Skill removed');
      setRefKey((k) => k + 1);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to remove skill');
    }
  }

  async function handleCreateReference(targetPath: string) {
    const name = targetPath.split('/').filter(Boolean).pop();
    if (!name) return;
    setShowFsBrowser(false);
    try {
      await api(`/agents/${agentId}/files/references`, {
        method: 'POST',
        body: JSON.stringify({ path: '/', name, target: targetPath }),
      });
      toast.success('Reference created');
      setRefKey((k) => k + 1);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to create reference');
    }
  }

  return (
    <div className={styles.filesPanel}>
      {/* Enabled skills */}
      {skillsLoaded && (
        <div className={styles.filesSkillsBar}>
          <div className={styles.filesSkillsLabel}>
            <Blocks size={13} />
            Skills
          </div>
          <div className={styles.filesSkillsChips}>
            {agentSkills.map((skill) => (
              <div key={skill.id} className={styles.filesSkillChip}>
                <span className={styles.filesSkillChipName}>{skill.name}</span>
                <button
                  className={styles.filesSkillChipRemove}
                  onClick={() => void handleDetachSkill(skill.id)}
                  aria-label={`Remove ${skill.name}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            <button className={styles.filesSkillAddBtn} onClick={() => void openSkillsPicker()}>
              <Plus size={13} />
              Add
            </button>
          </div>
        </div>
      )}

      <div className={styles.filesPanelScroll}>
        <FileBrowser
          key={refKey}
          endpoints={endpoints}
          rootLabel="Files"
          rootIcon={HardDrive}
          extraToolbarButtons={
            <Button size="sm" variant="ghost" onClick={() => setShowFsBrowser(true)}>
              <Link2 size={14} />
              Reference
            </Button>
          }
        />
      </div>

      {showFsBrowser && (
        <FileSystemBrowserModal
          onSelect={handleCreateReference}
          onClose={() => setShowFsBrowser(false)}
        />
      )}

      {skillsPickerOpen && (
        <div className={styles.skillsPickerOverlay} onClick={() => setSkillsPickerOpen(false)}>
          <div className={styles.skillsPickerModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.skillsPickerHeader}>
              <span className={styles.skillsPickerTitle}>Add From Library</span>
              <button
                className={styles.skillsPickerClose}
                onClick={() => setSkillsPickerOpen(false)}
              >
                <X size={16} />
              </button>
            </div>
            <div className={styles.skillsPickerBody}>
              {unattachedSkills.length === 0 ? (
                <div className={styles.skillsPickerEmpty}>
                  <Blocks size={28} className={styles.skillsPickerEmptyIcon} />
                  <p className={styles.skillsPickerEmptyText}>
                    {allSkills.length === 0
                      ? 'No skills exist yet. Create skills from the Skills manager in the sidebar.'
                      : 'All available skills are already added to this agent.'}
                  </p>
                </div>
              ) : (
                unattachedSkills.map((skill) => (
                  <div
                    key={skill.id}
                    className={styles.skillsPickerItem}
                    onClick={() => void handleAttachSkill(skill.id)}
                  >
                    <div className={styles.skillsPickerIcon}>
                      <Blocks size={16} />
                    </div>
                    <div className={styles.skillsPickerInfo}>
                      <div className={styles.skillsPickerName}>{skill.name}</div>
                      {skill.description && (
                        <div className={styles.skillsPickerDesc}>{skill.description}</div>
                      )}
                    </div>
                    <div className={styles.skillsPickerAdd}>
                      <Plus size={14} />
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Skill types ── */

interface SkillFull {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

interface AgentLocalSkill {
  id: string;
  name: string;
  description: string;
  path: string;
  missing: boolean;
}

function slugifySkillName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'skill'
  );
}

function localSkillSlug(skillId: string): string {
  const normalized = skillId.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() ?? normalized;
}

/* ══════════════════════════════════════════════════════════
   Component
   ══════════════════════════════════════════════════════════ */

export function AgentsPage() {
  useDocumentTitle('Agents');
  const { activeWorkspaceId } = useWorkspace();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [conversationBootstrapRequest, setConversationBootstrapRequest] =
    useState<ConversationBootstrapRequest | null>(() =>
      readConversationBootstrapRequest(searchParams),
    );
  const requestedAgentId = conversationBootstrapRequest?.agentId ?? null;
  const requestedConversationId = conversationBootstrapRequest?.conversationId ?? null;
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
      const settings = raw ? (JSON.parse(raw) as { collapsedAgentIds?: string[] | 'all' }) : {};
      if (Array.isArray(settings.collapsedAgentIds)) {
        return new Set(settings.collapsedAgentIds);
      }
    } catch {
      /* ignore */
    }
    return 'all';
  });
  const [manageGroupsOpen, setManageGroupsOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState('');
  const [contextMenu, setContextMenu] = useState<{ agentId: string; x: number; y: number } | null>(
    null,
  );

  // ── Selection state ──
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);

  // ── Per-agent conversations ──
  const [convsByAgent, setConvsByAgent] = useState<Record<string, ChatConversation[]>>({});

  // ── Chat state ──
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [showChatLoading, setShowChatLoading] = useState(false);
  const chatLoadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const nextRequest = readConversationBootstrapRequest(searchParams);
    if (!nextRequest) {
      setConversationBootstrapRequest((prev) => (prev === null ? prev : null));
      return;
    }
    const matchesCurrentSelection =
      activeAgentIdRef.current === nextRequest.agentId &&
      activeConvIdRef.current === nextRequest.conversationId;
    setConversationBootstrapRequest((prev) => {
      if (matchesCurrentSelection) return null;
      return areConversationBootstrapRequestsEqual(prev, nextRequest) ? prev : nextRequest;
    });
  }, [searchParams]);

  useEffect(() => {
    if (chatLoading) {
      chatLoadingTimerRef.current = setTimeout(() => setShowChatLoading(true), 1500);
    } else {
      if (chatLoadingTimerRef.current) clearTimeout(chatLoadingTimerRef.current);
      chatLoadingTimerRef.current = null;
      setShowChatLoading(false);
    }
    return () => {
      if (chatLoadingTimerRef.current) clearTimeout(chatLoadingTimerRef.current);
    };
  }, [chatLoading]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingMessage, setEditingMessage] = useState<EditingMessageState | null>(null);
  const [pendingConversationKeys, setPendingConversationKeys] = useState<Set<string>>(new Set());
  const [runHandoffKeys, setRunHandoffKeys] = useState<Set<string>>(new Set());
  const [stoppingRun, setStoppingRun] = useState(false);
  const [activeConversationRun, setActiveConversationRun] = useState<AgentRunSummary | null>(null);
  const [optimisticResponseParentIds, setOptimisticResponseParentIds] = useState<
    Record<string, string>
  >({});

  const isFirstMessageRef = useRef(false);
  const activeAgentIdRef = useRef<string | null>(null);
  const activeConvIdRef = useRef<string | null>(null);
  const convsByAgentRef = useRef<Record<string, ChatConversation[]>>({});
  const pendingConversationKeysRef = useRef<Set<string>>(new Set());
  const pendingConversationCountRef = useRef<Map<string, number>>(new Map());
  const runHandoffTimersRef = useRef<Map<string, number>>(new Map());
  const runHandoffStartedAtRef = useRef<Map<string, number>>(new Map());
  // ── Conversation indicators ──
  const messagesRef = useRef<HTMLDivElement>(null);

  // ── Create modal ──
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateAgentForm>(makeEmptyForm);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [createAvatarOpen, setCreateAvatarOpen] = useState(false);
  const [pickingPresetDirectoryKey, setPickingPresetDirectoryKey] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apiKeysLoading, setApiKeysLoading] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [avatarPresets, setAvatarPresets] = useState<AvatarPreset[]>([]);
  const [colorPresets, setColorPresets] = useState<ColorPreset[]>([]);
  const [cliStatus, setCliStatus] = useState<CliInfo[]>([]);
  const createAvatarPickerRef = useRef<HTMLDivElement>(null);

  // ── Chat / Files tab ──
  const [chatTab, setChatTab] = useState<'chat' | 'files'>('chat');

  // ── Queue panel ──
  const [queuePanelOpen, setQueuePanelOpen] = useState(false);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [editingQueueItemId, setEditingQueueItemId] = useState<string | null>(null);
  const [editingQueuePrompt, setEditingQueuePrompt] = useState('');

  // ── Skills manager (page-level) ──
  const [skillsManagerOpen, setSkillsManagerOpen] = useState(false);
  const [mgrSkills, setMgrSkills] = useState<SkillFull[]>([]);
  const [mgrLoading, setMgrLoading] = useState(false);
  const [mgrCreating, setMgrCreating] = useState(false);
  const [mgrEditingId, setMgrEditingId] = useState<string | null>(null);
  const [mgrFormName, setMgrFormName] = useState('');
  const [mgrFormDesc, setMgrFormDesc] = useState('');
  const [mgrFormError, setMgrFormError] = useState('');
  const [mgrSaving, setMgrSaving] = useState(false);
  const [mgrActiveSkillId, setMgrActiveSkillId] = useState<string | null>(null);
  const mgrNameRef = useRef<HTMLInputElement>(null);
  const mgrFileBrowserEndpoints = useMemo(
    () => skillFileEndpoints(mgrActiveSkillId ?? ''),
    [mgrActiveSkillId],
  );

  // ── Header menu ──
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const headerMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!headerMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target as Node)) {
        setHeaderMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [headerMenuOpen]);

  // ── Page settings ──
  const [pageSettingsOpen, setPageSettingsOpen] = useState(false);
  const [autoCollapse, setAutoCollapse] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('agents_page_settings');
      return raw ? ((JSON.parse(raw) as { autoCollapse?: boolean }).autoCollapse ?? false) : false;
    } catch {
      return false;
    }
  });

  function toggleAutoCollapse() {
    setAutoCollapse((prev) => {
      const next = !prev;
      try {
        const raw = localStorage.getItem('agents_page_settings');
        const existing = raw ? (JSON.parse(raw) as object) : {};
        localStorage.setItem(
          'agents_page_settings',
          JSON.stringify({ ...existing, autoCollapse: next }),
        );
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  // Persist collapsed agents state
  useEffect(() => {
    try {
      const raw = localStorage.getItem('agents_page_settings');
      const existing = raw ? (JSON.parse(raw) as object) : {};
      const collapsedAgentIds = collapsedAgents === 'all' ? 'all' : Array.from(collapsedAgents);
      localStorage.setItem(
        'agents_page_settings',
        JSON.stringify({ ...existing, collapsedAgentIds }),
      );
    } catch {
      /* ignore */
    }
  }, [collapsedAgents]);

  // Cleanup legacy client-side chat queue artifacts (queue is backend-managed now).
  useEffect(() => {
    try {
      localStorage.removeItem('agents_page_chat_queue_v2');
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith('agents_page_chat_queue_lock_v1:')) continue;
        localStorage.removeItem(key);
      }
    } catch {
      // Ignore storage errors.
    }
  }, []);

  // ── Settings modal ──
  const [settingsAgent, setSettingsAgent] = useState<Agent | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState('');
  const [editingAvatar, setEditingAvatar] = useState(false);
  const [agentEnvVars, setAgentEnvVars] = useState<AgentEnvVar[]>([]);
  const [agentEnvVarsLoading, setAgentEnvVarsLoading] = useState(false);
  const [agentEnvVarSaving, setAgentEnvVarSaving] = useState(false);
  const [agentEnvVarFormOpen, setAgentEnvVarFormOpen] = useState(false);
  const [agentEnvVarFormErrors, setAgentEnvVarFormErrors] = useState<Record<string, string>>({});
  const [agentEnvVarForm, setAgentEnvVarForm] = useState<AgentEnvVarFormState>(() =>
    createEmptyAgentEnvVarForm(),
  );
  const editNameRef = useRef<HTMLInputElement>(null);
  const avatarPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!createAvatarOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (createAvatarPickerRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[role="dialog"][aria-modal="true"]')) return;
      setCreateAvatarOpen(false);
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [createAvatarOpen]);

  useEffect(() => {
    if (!editingAvatar) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (avatarPickerRef.current?.contains(target)) return;
      // Don't close if clicking inside a portaled modal (e.g. the icon drawing modal)
      if (target instanceof Element && target.closest('[role="dialog"][aria-modal="true"]')) return;
      setEditingAvatar(false);
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [editingAvatar]);

  // ── Cron jobs (settings modal) ──
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [cronFormOpen, setCronFormOpen] = useState(false);
  const [cronFormCron, setCronFormCron] = useState('');
  const [cronFormPrompt, setCronFormPrompt] = useState('');
  const [cronSaving, setCronSaving] = useState(false);

  // Keep ref in sync for closure access
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  activeAgentIdRef.current = activeAgentId;
  activeConvIdRef.current = activeConvId;
  convsByAgentRef.current = convsByAgent;
  pendingConversationKeysRef.current = pendingConversationKeys;

  const setActiveConversation = useCallback(
    (agentId: string | null, conversationId: string | null) => {
      activeAgentIdRef.current = agentId;
      activeConvIdRef.current = conversationId;
      setActiveAgentId(agentId);
      setActiveConvId(conversationId);
      setQueueItems([]);
      setQueuePanelOpen(false);
      setEditingQueueItemId(null);
      setEditingQueuePrompt('');
      setEditingMessage(null);
      // Expand the active agent so the selected conversation is visible in the sidebar
      if (agentId) {
        setCollapsedAgents((prev) => {
          if (prev === 'all') {
            const next = new Set(agentsRef.current.map((a) => a.id));
            next.delete(agentId);
            return next;
          }
          if (!prev.has(agentId)) return prev;
          const next = new Set(prev);
          next.delete(agentId);
          return next;
        });
      }
    },
    [],
  );

  const syncActiveConversationUrl = useCallback(
    () => {
      if (conversationBootstrapRequest) return;

      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('id');
      nextParams.delete('settingsAgentId');
      if (activeAgentId) {
        nextParams.set('agentId', activeAgentId);
      } else {
        nextParams.delete('agentId');
      }
      if (activeConvId) {
        nextParams.set('conversationId', activeConvId);
      } else {
        nextParams.delete('conversationId');
      }

      const currentParams = new URLSearchParams(searchParams);
      currentParams.delete('id');
      currentParams.delete('settingsAgentId');
      const currentQuery = currentParams.toString();
      const nextQuery = nextParams.toString();
      if (currentQuery === nextQuery) return;

      setSearchParams(nextParams, { replace: true });
    },
    [activeAgentId, activeConvId, conversationBootstrapRequest, searchParams, setSearchParams],
  );

  const setConversationPending = useCallback(
    (agentId: string, conversationId: string, pending: boolean) => {
      const key = agentConversationKey(agentId, conversationId);
      const counts = pendingConversationCountRef.current;
      const prevCount = counts.get(key) ?? 0;
      const nextCount = pending ? prevCount + 1 : Math.max(0, prevCount - 1);
      if (nextCount > 0) {
        counts.set(key, nextCount);
        pendingConversationKeysRef.current.add(key);
      } else {
        counts.delete(key);
        pendingConversationKeysRef.current.delete(key);
      }

      const nextPending = nextCount > 0;
      setPendingConversationKeys((prev) => {
        const currentlyPending = prev.has(key);
        if (currentlyPending === nextPending) return prev;
        const next = new Set(prev);
        if (nextPending) {
          next.add(key);
        } else {
          next.delete(key);
        }
        return next;
      });
    },
    [],
  );

  const setOptimisticResponseParent = useCallback(
    (agentId: string, conversationId: string, messageId: string | null) => {
      const key = agentConversationKey(agentId, conversationId);
      setOptimisticResponseParentIds((prev) => {
        const current = prev[key];
        if (messageId === null) {
          if (current === undefined) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        }
        if (current === messageId) return prev;
        return { ...prev, [key]: messageId };
      });
    },
    [],
  );

  const clearRunHandoff = useCallback((agentId: string, conversationId: string) => {
    const key = agentConversationKey(agentId, conversationId);
    const timer = runHandoffTimersRef.current.get(key);
    if (timer) {
      clearTimeout(timer);
      runHandoffTimersRef.current.delete(key);
    }
    runHandoffStartedAtRef.current.delete(key);
    setRunHandoffKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const beginRunHandoff = useCallback((agentId: string, conversationId: string) => {
    const key = agentConversationKey(agentId, conversationId);
    const existing = runHandoffTimersRef.current.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    runHandoffStartedAtRef.current.set(key, Date.now());
    const timer = window.setTimeout(() => {
      runHandoffTimersRef.current.delete(key);
      runHandoffStartedAtRef.current.delete(key);
      setRunHandoffKeys((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, RUN_HANDOFF_MS);
    runHandoffTimersRef.current.set(key, timer);
    setRunHandoffKeys((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const activeConversation = useMemo(() => {
    if (!activeAgentId || !activeConvId) return null;
    return (convsByAgent[activeAgentId] || []).find((conv) => conv.id === activeConvId) ?? null;
  }, [activeAgentId, activeConvId, convsByAgent]);
  const activeConversationPending =
    activeAgentId && activeConvId
      ? pendingConversationKeys.has(agentConversationKey(activeAgentId, activeConvId))
      : false;
  const activeConversationHandoff =
    activeAgentId && activeConvId
      ? runHandoffKeys.has(agentConversationKey(activeAgentId, activeConvId))
      : false;
  const activeConversationBusy = Boolean(activeConversation?.isBusy);
  const activeConversationQueueCount = toQueueCount(activeConversation?.queuedCount);
  const activeConversationRunBusy = activeConversationRun?.status === 'running';
  const streaming =
    activeConversationPending ||
    activeConversationBusy ||
    activeConversationRunBusy ||
    activeConversationHandoff ||
    activeConversationQueueCount > 0;
  const activeConversationKey =
    activeAgentId && activeConvId ? agentConversationKey(activeAgentId, activeConvId) : null;
  const {
    queuedQueueItems,
    effectivePendingBranchExecutionsByMessageId,
    errorsByMessageId,
    orphanErrorItems,
    showStreamingBubble,
  } = useMemo(
    () =>
      buildAgentConversationViewModel({
        messages,
        queueItems,
        activeConversationRun,
        activeAgentId,
        activeConvId,
        activeConversationKey,
        optimisticResponseParentIds,
        streaming,
      }),
    [
      activeAgentId,
      activeConvId,
      activeConversationKey,
      activeConversationRun,
      messages,
      optimisticResponseParentIds,
      queueItems,
      streaming,
    ],
  );
  const isNearMessagesBottom = useCallback((element: HTMLDivElement) => {
    return (
      element.scrollHeight - element.scrollTop - element.clientHeight <= SCROLL_BOTTOM_THRESHOLD_PX
    );
  }, []);
  const shouldStickToBottomRef = useRef(true);
  const forceScrollToBottomRef = useRef(false);
  const requestAutoScrollToBottom = useCallback(() => {
    forceScrollToBottomRef.current = true;
    shouldStickToBottomRef.current = true;
  }, []);
  const handleMessagesScroll = useCallback(() => {
    const element = messagesRef.current;
    if (!element) return;
    shouldStickToBottomRef.current = isNearMessagesBottom(element);
  }, [isNearMessagesBottom]);

  const isActiveConversation = useCallback(
    (agentId: string, conversationId: string) =>
      activeAgentIdRef.current === agentId && activeConvIdRef.current === conversationId,
    [],
  );

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
    } catch {
      /* silently fail */
    }
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

  const fetchCliStatus = useCallback(async () => {
    try {
      const data = await api<{ clis: CliInfo[] }>('/agents/cli-status');
      setCliStatus(data.clis);
      return data.clis;
    } catch {
      return [];
    }
  }, []);

  const ensureAgentCliAvailable = useCallback(
    (agentId: string) => {
      const agent = agents.find((entry) => entry.id === agentId);
      if (!agent) return true;
      const cliInfo = getCliInfoForModel(cliStatus, agent.model);
      if (!cliInfo || cliInfo.installed) return true;
      const message = getCliUnavailableMessage(cliInfo);
      setChatError(message);
      toast.error(message);
      return false;
    },
    [agents, cliStatus],
  );

  const fetchAvatarPresets = useCallback(async () => {
    try {
      const data = await api<{ entries: AvatarPreset[] }>('/agent-avatar-presets');
      setAvatarPresets(data.entries);
    } catch {
      /* silently fail */
    }
  }, []);

  const fetchColorPresets = useCallback(async () => {
    try {
      const data = await api<{ entries: ColorPreset[] }>('/agent-color-presets');
      setColorPresets(data.entries);
    } catch {
      /* silently fail */
    }
  }, []);

  const fetchAgentEnvVars = useCallback(async (agentId: string) => {
    setAgentEnvVarsLoading(true);
    try {
      const data = await api<{ entries: AgentEnvVar[] }>(`/agents/${agentId}/env-vars`);
      setAgentEnvVars(data.entries);
      return data.entries;
    } catch {
      setAgentEnvVars([]);
      return [];
    } finally {
      setAgentEnvVarsLoading(false);
    }
  }, []);

  const fetchConversationById = useCallback(async (agentId: string, conversationId: string) => {
    try {
      return await api<ChatConversation>(`/agents/${agentId}/chat/conversations/${conversationId}`);
    } catch {
      return null;
    }
  }, []);

  /* ── Fetch conversations for an agent ── */
  const fetchConversations = useCallback(
    async (agentId: string) => {
      try {
        const data = await api<{ entries: ChatConversation[]; total: number }>(
          `/agents/${agentId}/chat/conversations`,
        );
        const preservedConversation =
          activeAgentIdRef.current === agentId && activeConvIdRef.current
            ? ((convsByAgentRef.current[agentId] || []).find(
                (conv) => conv.id === activeConvIdRef.current,
              ) ?? null)
            : null;
        const nextEntries = mergeConversationIntoList(data.entries, preservedConversation);
        for (const conversation of nextEntries) {
          if (conversation.isBusy || toQueueCount(conversation.queuedCount) > 0) {
            clearRunHandoff(agentId, conversation.id);
          }
        }
        setConvsByAgent((prev) => {
          const existing = prev[agentId] || [];
          if (areChatConversationListsEqual(existing, nextEntries)) return prev;
          return { ...prev, [agentId]: nextEntries };
        });
        return nextEntries;
      } catch {
        return [];
      }
    },
    [clearRunHandoff],
  );

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
        const preservedConversation =
          activeAgentIdRef.current === agentId && activeConvIdRef.current
            ? ((prev[agentId] || []).find((conv) => conv.id === activeConvIdRef.current) ?? null)
            : null;
        const nextEntries = mergeConversationIntoList(incoming, preservedConversation);
        for (const conversation of nextEntries) {
          if (conversation.isBusy || toQueueCount(conversation.queuedCount) > 0) {
            clearRunHandoff(agentId, conversation.id);
          }
        }
        const existing = prev[agentId] || [];
        if (areChatConversationListsEqual(existing, nextEntries)) continue;
        next[agentId] = nextEntries;
        changed = true;
      }

      return changed ? next : prev;
    });
  }, [agents, clearRunHandoff]);

  /* ── Fetch messages ── */
  const messagesRef2 = useRef<ChatMessage[]>([]);
  messagesRef2.current = messages;
  const queueItemsRef = useRef<QueueItem[]>([]);
  queueItemsRef.current = queueItems;
  const activeMessagesRequestTokenRef = useRef(0);
  const activeQueueRequestTokenRef = useRef(0);

  const setActiveConversationMessages = useCallback(
    (
      agentId: string,
      conversationId: string,
      nextMessages: ChatMessage[] | ((currentMessages: ChatMessage[]) => ChatMessage[]),
    ) => {
      if (!isActiveConversation(agentId, conversationId)) return;
      activeMessagesRequestTokenRef.current += 1;
      const resolvedMessages =
        typeof nextMessages === 'function' ? nextMessages(messagesRef2.current) : nextMessages;
      messagesRef2.current = resolvedMessages;
      setMessages(resolvedMessages);
      isFirstMessageRef.current = resolvedMessages.length === 0;
    },
    [isActiveConversation],
  );

  const setActiveConversationQueueItems = useCallback(
    (
      agentId: string,
      conversationId: string,
      nextQueueItems: QueueItem[] | ((currentQueueItems: QueueItem[]) => QueueItem[]),
    ) => {
      if (!isActiveConversation(agentId, conversationId)) return;
      activeQueueRequestTokenRef.current += 1;
      const resolvedQueueItems =
        typeof nextQueueItems === 'function'
          ? nextQueueItems(queueItemsRef.current)
          : nextQueueItems;
      queueItemsRef.current = resolvedQueueItems;
      setQueueItems(resolvedQueueItems);
    },
    [isActiveConversation],
  );

  const fetchMessages = useCallback(
    async (agentId: string, conversationId: string, options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      const requestToken = ++activeMessagesRequestTokenRef.current;
      if (!silent) setChatLoading(true);
      try {
        const data = await api<{ entries: ChatMessage[] }>(
          `/agents/${agentId}/chat/messages?conversationId=${conversationId}`,
        );
        if (!isActiveConversation(agentId, conversationId)) return;
        if (requestToken !== activeMessagesRequestTokenRef.current) return;
        const handoffStartedAt =
          runHandoffStartedAtRef.current.get(agentConversationKey(agentId, conversationId)) ?? null;
        if (
          handoffStartedAt !== null &&
          data.entries.some(
            (message) =>
              message.direction === 'inbound' &&
              message.type !== 'system' &&
              new Date(message.createdAt).getTime() >= handoffStartedAt,
          )
        ) {
          clearRunHandoff(agentId, conversationId);
        }
        // Skip update if message list hasn't changed (avoids dropping optimistic
        // temp messages and prevents unnecessary re-renders during polling).
        const prev = messagesRef2.current;
        if (
          prev.length === data.entries.length &&
          prev.every((m, i) => {
            const next = data.entries[i];
            return (
              m.id === next.id &&
              m.content === next.content &&
              m.type === next.type &&
              m.parentId === next.parentId &&
              (m.siblingIndex ?? 0) === (next.siblingIndex ?? 0) &&
              (m.siblingCount ?? 1) === (next.siblingCount ?? 1) &&
              JSON.stringify(m.siblingIds ?? []) === JSON.stringify(next.siblingIds ?? []) &&
              JSON.stringify(m.attachments ?? null) === JSON.stringify(next.attachments ?? null)
            );
          })
        ) {
          return;
        }
        setActiveConversationMessages(agentId, conversationId, data.entries);
      } catch {
        if (!isActiveConversation(agentId, conversationId)) return;
        setChatError('Failed to load messages');
      } finally {
        if (!silent) setChatLoading(false);
      }
    },
    [clearRunHandoff, isActiveConversation, setActiveConversationMessages],
  );

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

  /* ── Queue item handlers ── */
  const fetchQueueItems = useCallback(
    async (agentId: string, conversationId: string) => {
      const requestToken = ++activeQueueRequestTokenRef.current;
      try {
        const data = await api<{ entries: QueueItem[] }>(
          `/agents/${agentId}/chat/conversations/${conversationId}/queue`,
        );
        if (!isActiveConversation(agentId, conversationId)) return;
        if (requestToken !== activeQueueRequestTokenRef.current) return;
        setActiveConversationQueueItems(agentId, conversationId, data.entries);
      } catch {
        // silently fail
      }
    },
    [isActiveConversation, setActiveConversationQueueItems],
  );

  const fetchConversationRun = useCallback(
    async (agentId: string, conversationId: string) => {
      try {
        const params = new URLSearchParams({
          agentId,
          conversationId,
          status: 'running',
          limit: '1',
        });
        const data = await api<{ entries: AgentRunSummary[] }>(`/agent-runs?${params.toString()}`);
        if (!isActiveConversation(agentId, conversationId)) return;

        const latestRun = data.entries[0] ?? null;
        setActiveConversationRun(latestRun);
      } catch {
        if (!isActiveConversation(agentId, conversationId)) return;
        setActiveConversationRun(null);
      } finally {
        // no-op
      }
    },
    [isActiveConversation],
  );

  const syncActiveConversation = useCallback(
    async (agentId: string, conversationId: string, options?: { silent?: boolean }) => {
      await Promise.all([
        fetchMessages(agentId, conversationId, options),
        fetchQueueItems(agentId, conversationId),
        fetchConversations(agentId),
        fetchConversationRun(agentId, conversationId),
      ]);
    },
    [fetchConversationRun, fetchConversations, fetchMessages, fetchQueueItems],
  );

  async function handleSaveQueueItem(itemId: string) {
    if (!activeAgentId || !activeConvId || !editingQueuePrompt.trim()) return;
    try {
      await api(`/agents/${activeAgentId}/chat/queue/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          conversationId: activeConvId,
          prompt: editingQueuePrompt.trim(),
        }),
      });
      setEditingQueueItemId(null);
      setEditingQueuePrompt('');
      await fetchQueueItems(activeAgentId, activeConvId);
    } catch {
      // silently fail
    }
  }

  async function handleDeleteQueueItem(itemId: string) {
    if (!activeAgentId || !activeConvId) return;
    try {
      await api(`/agents/${activeAgentId}/chat/queue/${itemId}`, {
        method: 'DELETE',
        body: JSON.stringify({ conversationId: activeConvId }),
      });
      await fetchQueueItems(activeAgentId, activeConvId);
    } catch {
      // silently fail
    }
  }

  async function handleClearQueue() {
    if (!activeAgentId || !activeConvId || queuedQueueItems.length === 0) return;
    try {
      await Promise.all(
        queuedQueueItems.map((item) =>
          api(`/agents/${activeAgentId}/chat/queue/${item.id}`, {
            method: 'DELETE',
            body: JSON.stringify({ conversationId: activeConvId }),
          }),
        ),
      );
      setActiveConversationQueueItems(activeAgentId, activeConvId, (prev) =>
        prev.filter((item) => !queuedQueueItems.some((queuedItem) => queuedItem.id === item.id)),
      );
      await fetchConversations(activeAgentId);
    } catch {
      // silently fail
    }
  }

  async function handleRetryQueueItem(itemId: string) {
    if (!activeAgentId || !activeConvId) return;
    try {
      await api(`/agents/${activeAgentId}/chat/queue/${itemId}/retry`, {
        method: 'POST',
        body: JSON.stringify({ conversationId: activeConvId }),
      });
      await syncActiveConversation(activeAgentId, activeConvId);
    } catch {
      // silently fail
    }
  }

  async function handleDismissQueueItem(itemId: string) {
    if (!activeAgentId || !activeConvId) return;
    try {
      await api(`/agents/${activeAgentId}/chat/queue/${itemId}`, {
        method: 'DELETE',
        body: JSON.stringify({ conversationId: activeConvId }),
      });
      await syncActiveConversation(activeAgentId, activeConvId);
    } catch {
      // silently fail
    }
  }

  /* ── Initial load ── */
  useEffect(() => {
    let cancelled = false;
    async function load() {
      fetchGroups();
      fetchAvatarPresets();
      fetchColorPresets();
      fetchCliStatus();
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

      const currentAgentId = activeAgentIdRef.current;
      const currentConvId = activeConvIdRef.current;
      if (currentAgentId) {
        const preservedConversation =
          currentConvId == null
            ? null
            : ((allConvs[currentAgentId] || []).find((conv) => conv.id === currentConvId) ??
              (convsByAgentRef.current[currentAgentId] || []).find(
                (conv) => conv.id === currentConvId,
              ) ??
              null);
        if (preservedConversation) {
          allConvs[currentAgentId] = mergeConversationIntoList(
            allConvs[currentAgentId] || [],
            preservedConversation,
          );
        }
      }

      if (requestedAgentId) {
        const requestedAgent = entries.find((agent) => agent.id === requestedAgentId);
        if (requestedAgent) {
          const requestedConvs = allConvs[requestedAgentId] || [];
          const requestedConversation =
            requestedConversationId == null
              ? null
              : (requestedConvs.find((conv) => conv.id === requestedConversationId) ??
                (await fetchConversationById(requestedAgentId, requestedConversationId)));
          const requestedAgentConvs = mergeConversationIntoList(
            requestedConvs,
            requestedConversation,
          );
          allConvs[requestedAgentId] = requestedAgentConvs;
          setConvsByAgent(allConvs);
          const targetConvId = requestedConversation?.id ?? requestedAgentConvs[0]?.id ?? null;
          const shouldResetSelection =
            currentAgentId !== requestedAgentId || currentConvId !== targetConvId;

          if (targetConvId) {
            if (shouldResetSelection) {
              setActiveConversation(requestedAgentId, targetConvId);
              setMessages([]);
            }
            setChatError(null);
            await syncActiveConversation(requestedAgentId, targetConvId);
          } else {
            if (shouldResetSelection) {
              setActiveConversation(requestedAgentId, null);
              setMessages([]);
            }
            isFirstMessageRef.current = true;
          }
          setConversationBootstrapRequest(null);
          return;
        }

        setConversationBootstrapRequest(null);
      }

      setConvsByAgent(allConvs);

      if (currentAgentId) {
        const activeAgentExists = entries.some((agent) => agent.id === currentAgentId);
        const activeConversationExists =
          currentConvId == null ||
          (allConvs[currentAgentId] || []).some((conv) => conv.id === currentConvId);

        if (activeAgentExists && activeConversationExists) {
          return;
        }
      }

      for (const agent of entries) {
        const busyConv = (allConvs[agent.id] || []).find((conv) => Boolean(conv.isBusy));
        if (!busyConv) continue;
        setActiveConversation(agent.id, busyConv.id);
        setMessages([]);
        setChatError(null);
        await syncActiveConversation(agent.id, busyConv.id);
        return;
      }

      // Auto-select first agent's first conversation
      const firstAgent = entries[0];
      const firstConvs = allConvs[firstAgent.id] || [];
      if (firstConvs.length > 0) {
        setActiveConversation(firstAgent.id, firstConvs[0].id);
        setMessages([]);
        setChatError(null);
        await syncActiveConversation(firstAgent.id, firstConvs[0].id);
      } else {
        setActiveConversation(firstAgent.id, null);
        setMessages([]);
        setChatError(null);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [
    fetchAgents,
    fetchAvatarPresets,
    fetchColorPresets,
    fetchCliStatus,
    fetchConversationById,
    fetchGroups,
    syncActiveConversation,
    requestedAgentId,
    requestedConversationId,
    setActiveConversation,
  ]);

  useEffect(() => {
    syncActiveConversationUrl();
  }, [activeAgentId, activeConvId, syncActiveConversationUrl]);

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

  useEffect(() => {
    setActiveConversationRun(null);

    if (!activeAgentId || !activeConvId) {
      return;
    }

    void fetchConversationRun(activeAgentId, activeConvId);
  }, [activeAgentId, activeConvId, fetchConversationRun]);

  useEffect(() => {
    if (!activeAgentId || !activeConvId || streaming) return;
    setOptimisticResponseParent(activeAgentId, activeConvId, null);
  }, [activeAgentId, activeConvId, setOptimisticResponseParent, streaming]);

  // While a run is active or queued, keep the active chat state in sync so the
  // reply, queue badge, and processing indicator settle together.
  useEffect(() => {
    if (!streaming || !activeAgentId || !activeConvId) {
      return;
    }

    const agentId = activeAgentId;
    const conversationId = activeConvId;
    void syncActiveConversation(agentId, conversationId, { silent: true });

    const intervalId = window.setInterval(() => {
      void syncActiveConversation(agentId, conversationId, { silent: true });
    }, 1500);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeAgentId, activeConvId, streaming, syncActiveConversation]);

  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (streaming) {
      wasStreamingRef.current = true;
      return;
    }
    if (!wasStreamingRef.current || !activeAgentId || !activeConvId) return;
    wasStreamingRef.current = false;
    void syncActiveConversation(activeAgentId, activeConvId, { silent: true });
  }, [activeAgentId, activeConvId, streaming, syncActiveConversation]);

  useEffect(
    () => () => {
      for (const timer of runHandoffTimersRef.current.values()) {
        clearTimeout(timer);
      }
      runHandoffTimersRef.current.clear();
      runHandoffStartedAtRef.current.clear();
    },
    [],
  );

  /* ── Scroll to bottom ── */
  const scrollToBottom = useCallback(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
      shouldStickToBottomRef.current = true;
    }
  }, []);

  useEffect(() => {
    requestAutoScrollToBottom();
  }, [activeConversationKey, requestAutoScrollToBottom]);

  useEffect(() => {
    if (!messagesRef.current) {
      return;
    }
    if (!forceScrollToBottomRef.current && !shouldStickToBottomRef.current) {
      return;
    }
    const rafId = window.requestAnimationFrame(() => {
      scrollToBottom();
      forceScrollToBottomRef.current = false;
    });
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [messages, queueItems, scrollToBottom, streaming]);

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
      void fetchAgentEnvVars(settingsAgent.id);
      setAgentEnvVarFormErrors({});
    } else {
      setAgentEnvVars([]);
      setAgentEnvVarFormErrors({});
      setAgentEnvVarFormOpen(false);
      setAgentEnvVarForm(createEmptyAgentEnvVarForm());
    }
  }, [fetchAgentEnvVars, settingsAgent?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Cron job handlers ── */

  async function saveCronJobs(agentId: string, jobs: CronJob[]) {
    setCronSaving(true);
    try {
      const payload = jobs.map(({ id, cron, prompt, enabled }) => ({
        id,
        cron,
        prompt,
        enabled,
      }));
      const updated = await api<Agent>(`/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ cronJobs: payload }),
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
  const selectConversation = useCallback(
    async (agentId: string, convId: string) => {
      if (agentId === activeAgentId && convId === activeConvId) {
        void markConversationRead(agentId, convId);
        return;
      }
      if (autoCollapse) {
        setCollapsedAgents(() => {
          const next = new Set(agentsRef.current.map((agent) => agent.id));
          next.delete(agentId);
          return next;
        });
      }
      setActiveConversation(agentId, convId);
      setMessages([]);
      setChatError(null);
      void markConversationRead(agentId, convId);
      await syncActiveConversation(agentId, convId);
    },
    [
      activeAgentId,
      activeConvId,
      autoCollapse,
      syncActiveConversation,
      markConversationRead,
      setActiveConversation,
    ],
  );

  /* ── Create conversation ── */
  const createConversation = useCallback(
    async (agentId: string) => {
      try {
        const conv = await api<ChatConversation>(`/agents/${agentId}/chat/conversations`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        setConvsByAgent((prev) => ({
          ...prev,
          [agentId]: [conv, ...(prev[agentId] || [])],
        }));
        // Expand the agent so the new conversation is visible
        setCollapsedAgents((prev) => {
          if (prev === 'all') {
            const next = new Set(agentsRef.current.map((agent) => agent.id));
            next.delete(agentId);
            return next;
          }
          if (!prev.has(agentId)) return prev;
          const next = new Set(prev);
          next.delete(agentId);
          return next;
        });
        setActiveConversation(agentId, conv.id);
        setMessages([]);
        isFirstMessageRef.current = true;
        setChatError(null);
      } catch {
        setChatError('Failed to create conversation');
      }
    },
    [setActiveConversation],
  );

  /* ── Delete conversation ── */
  const deleteConversation = useCallback(
    async (agentId: string, convId: string) => {
      try {
        await api(`/agents/${agentId}/chat/conversations/${convId}`, { method: 'DELETE' });
        const deletingActiveConversation = activeAgentId === agentId && activeConvId === convId;
        const remainingConversations = (convsByAgent[agentId] || []).filter((c) => c.id !== convId);

        // Compute next selection from current state before mutating it.
        let nextFocusedConversationId: string | null = null;
        if (deletingActiveConversation) {
          const current = convsByAgent[agentId] || [];
          const deletedIndex = current.findIndex((c) => c.id === convId);
          if (deletedIndex !== -1) {
            const next = current.filter((c) => c.id !== convId);
            // Prefer the chat below; fall back to the chat above if none below.
            nextFocusedConversationId =
              next[deletedIndex]?.id ?? next[deletedIndex - 1]?.id ?? null;
          }
        }

        setConvsByAgent((prev) => ({
          ...prev,
          [agentId]: (prev[agentId] || []).filter((c) => c.id !== convId),
        }));
        pendingConversationCountRef.current.delete(agentConversationKey(agentId, convId));
        clearRunHandoff(agentId, convId);
        setOptimisticResponseParent(agentId, convId, null);
        setPendingConversationKeys((prev) => {
          const key = agentConversationKey(agentId, convId);
          if (!prev.has(key)) return prev;
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        if (remainingConversations.length === 0) {
          collapseAgent(agentId);
        }

        if (!deletingActiveConversation) return;

        if (nextFocusedConversationId) {
          setActiveConversation(agentId, nextFocusedConversationId);
          setMessages([]);
          setChatError(null);
          void fetchMessages(agentId, nextFocusedConversationId);
        } else {
          setActiveConversation(agentId, null);
          setMessages([]);
        }
      } catch {
        setChatError('Failed to delete conversation');
      }
    },
    [
      activeAgentId,
      activeConvId,
      clearRunHandoff,
      collapseAgent,
      convsByAgent,
      fetchMessages,
      pendingConversationKeys,
      setOptimisticResponseParent,
      setActiveConversation,
    ],
  );

  /* ── Clean conversations (delete all except active and unread) ── */
  const cleanConversations = useCallback(
    async (agentId: string) => {
      const convs = convsByAgent[agentId] || [];
      const toDelete = convs.filter((c) => {
        const isActive = activeAgentId === agentId && activeConvId === c.id;
        const isStreaming =
          Boolean(c.isBusy) || pendingConversationKeys.has(agentConversationKey(agentId, c.id));
        return !isActive && !c.isUnread && !isStreaming;
      });
      await Promise.allSettled(
        toDelete.map((c) =>
          api(`/agents/${agentId}/chat/conversations/${c.id}`, { method: 'DELETE' }),
        ),
      );
      const deletedIds = new Set(toDelete.map((c) => c.id));
      const remainingConversations = convs.filter((c) => !deletedIds.has(c.id));
      setConvsByAgent((prev) => ({
        ...prev,
        [agentId]: (prev[agentId] || []).filter((c) => !deletedIds.has(c.id)),
      }));
      for (const c of toDelete) {
        pendingConversationCountRef.current.delete(agentConversationKey(agentId, c.id));
        clearRunHandoff(agentId, c.id);
        setOptimisticResponseParent(agentId, c.id, null);
      }
      setPendingConversationKeys((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const c of toDelete) {
          changed = next.delete(agentConversationKey(agentId, c.id)) || changed;
        }
        return changed ? next : prev;
      });
      if (remainingConversations.length === 0) {
        collapseAgent(agentId);
      }
    },
    [
      activeAgentId,
      activeConvId,
      clearRunHandoff,
      collapseAgent,
      convsByAgent,
      pendingConversationKeys,
      setOptimisticResponseParent,
    ],
  );

  async function cleanAllConversations() {
    await Promise.allSettled(agents.map((a) => cleanConversations(a.id)));
  }

  function openMonitorRun(runId: string) {
    navigate(buildMonitorRunUrl(runId));
  }

  /* ── Send message ── */
  async function stopActiveRun() {
    if (!activeAgentId || !activeConvId || stoppingRun) return;
    setStoppingRun(true);
    try {
      const data = await api<{
        entries: { id: string; agentId: string; conversationId: string | null }[];
      }>('/agent-runs/active');
      const run = data.entries.find(
        (r) => r.agentId === activeAgentId && r.conversationId === activeConvId,
      );
      if (!run) {
        toast.error('No active run found');
        return;
      }
      await api(`/agent-runs/${run.id}`, { method: 'DELETE' });
      toast.success('Run stopped');
      // Refresh state
      await Promise.all([
        fetchMessages(activeAgentId, activeConvId),
        fetchConversations(activeAgentId),
        fetchQueueItems(activeAgentId, activeConvId),
      ]);
    } catch {
      toast.error('Failed to stop run');
    } finally {
      setStoppingRun(false);
    }
  }

  const sendAttachmentMessage = useCallback(
    async (caption: string, files: File[]) => {
      if (!activeAgentId || !activeConvId || files.length === 0) return;
      if (!ensureAgentCliAvailable(activeAgentId)) return;
      const sentAgentId = activeAgentId;
      const sentConvId = activeConvId;
      setChatError(null);
      requestAutoScrollToBottom();

      const wasFirst = isFirstMessageRef.current;
      isFirstMessageRef.current = false;

      try {
        const fd = new FormData();
        fd.append('conversationId', sentConvId);
        if (caption) fd.append('caption', caption);
        for (const file of files) {
          const prepared = isImageFile(file) ? await prepareImageForUpload(file) : file;
          fd.append('files', prepared, prepared.name);
        }
        const imgMsg = await apiUpload<ChatMessage>(`/agents/${sentAgentId}/chat/upload`, fd);
        if (isActiveConversation(sentAgentId, sentConvId)) {
          setActiveConversationMessages(sentAgentId, sentConvId, (prev) => [...prev, imgMsg]);
        }
        setOptimisticResponseParent(sentAgentId, sentConvId, imgMsg.id);

        const optimisticQueueItem: QueueItem = {
          id: `temp-respond-${Date.now()}`,
          agentId: sentAgentId,
          conversationId: sentConvId,
          mode: 'respond_to_message',
          prompt: caption,
          status: 'queued',
          attempts: 0,
          createdAt: new Date().toISOString(),
          targetMessageId: imgMsg.id,
        };
        setActiveConversationQueueItems(sentAgentId, sentConvId, (prev) => [
          ...prev,
          optimisticQueueItem,
        ]);

        beginRunHandoff(sentAgentId, sentConvId);
        setConversationPending(sentAgentId, sentConvId, true);
        try {
          const queueResponse = await api<QueuePromptResponse>(
            `/agents/${sentAgentId}/chat/respond`,
            {
              method: 'POST',
              body: JSON.stringify({ conversationId: sentConvId }),
            },
          );
          const immediateQueuedCount = toQueueCount(queueResponse.queuedCount);
          setConvsByAgent((prev) => {
            const convs = prev[sentAgentId];
            if (!convs || convs.length === 0) return prev;
            let changed = false;
            const nextConvs = convs.map((conv) => {
              if (conv.id !== sentConvId) return conv;
              if (conv.isBusy && toQueueCount(conv.queuedCount) === immediateQueuedCount)
                return conv;
              changed = true;
              return { ...conv, isBusy: true, queuedCount: immediateQueuedCount };
            });
            if (!changed) return prev;
            return { ...prev, [sentAgentId]: nextConvs };
          });
          await Promise.all([
            fetchQueueItems(sentAgentId, sentConvId),
            fetchConversations(sentAgentId),
          ]);
        } catch (err) {
          clearRunHandoff(sentAgentId, sentConvId);
          setActiveConversationQueueItems(sentAgentId, sentConvId, (prev) =>
            prev.filter((item) => item.id !== optimisticQueueItem.id),
          );
          setChatError(err instanceof Error ? err.message : 'Failed to queue agent response');
          throw err;
        } finally {
          setConversationPending(sentAgentId, sentConvId, false);
        }
      } catch (err) {
        setChatError(err instanceof Error ? err.message : 'Failed to upload attachments');
        throw err;
      }

      if (wasFirst) {
        void fetchConversations(sentAgentId);
      }
    },
    [
      activeAgentId,
      activeConvId,
      beginRunHandoff,
      clearRunHandoff,
      ensureAgentCliAvailable,
      fetchConversations,
      fetchQueueItems,
      isActiveConversation,
      requestAutoScrollToBottom,
      setActiveConversationMessages,
      setActiveConversationQueueItems,
      setOptimisticResponseParent,
      setConversationPending,
    ],
  );

  const sendTextMessage = useCallback(
    async (prompt: string) => {
      if (!prompt || !activeAgentId || !activeConvId) return;
      if (!ensureAgentCliAvailable(activeAgentId)) return;

      const sentAgentId = activeAgentId;
      const sentConvId = activeConvId;
      setChatError(null);
      requestAutoScrollToBottom();

      const optimisticQueueItem: QueueItem = {
        id: `temp-${Date.now()}`,
        agentId: sentAgentId,
        conversationId: sentConvId,
        prompt,
        status: 'queued',
        attempts: 0,
        createdAt: new Date().toISOString(),
      };
      setActiveConversationQueueItems(sentAgentId, sentConvId, (prev) => [
        ...prev,
        optimisticQueueItem,
      ]);

      // If the conversation is already busy/streaming, we're just adding to the
      // queue — no need to toggle pending state or force-refetch (the 1.5s poll
      // loop takes care of it).
      const alreadyBusy = streaming;

      const directMessageId = `direct-${Date.now()}-${generateId()}`;
      if (!alreadyBusy) {
        beginRunHandoff(sentAgentId, sentConvId);
        setConversationPending(sentAgentId, sentConvId, true);
      }
      try {
        const queueResponse = await api<QueuePromptResponse>(
          `/agents/${sentAgentId}/chat/message`,
          {
            method: 'POST',
            headers: {
              'Idempotency-Key': `agent-chat-direct:${directMessageId}`,
            },
            body: JSON.stringify({
              prompt,
              conversationId: sentConvId,
            }),
          },
        );
        const immediateQueuedCount = toQueueCount(queueResponse.queuedCount);
        setConvsByAgent((prev) => {
          const convs = prev[sentAgentId];
          if (!convs || convs.length === 0) return prev;
          let changed = false;
          const nextConvs = convs.map((conv) => {
            if (conv.id !== sentConvId) return conv;
            if (conv.isBusy && toQueueCount(conv.queuedCount) === immediateQueuedCount) return conv;
            changed = true;
            return { ...conv, isBusy: true, queuedCount: immediateQueuedCount };
          });
          if (!changed) return prev;
          return { ...prev, [sentAgentId]: nextConvs };
        });
        // Refetch queue items to replace optimistic entry with real data
        await fetchQueueItems(sentAgentId, sentConvId);
        if (!alreadyBusy) {
          const conversations = await fetchConversations(sentAgentId);
          const updatedConversation = conversations.find((conv) => conv.id === sentConvId);
          if (!updatedConversation?.isBusy) {
            await fetchMessages(sentAgentId, sentConvId);
          }
        }
      } catch (err) {
        // Remove optimistic queue item on failure
        clearRunHandoff(sentAgentId, sentConvId);
        setActiveConversationQueueItems(sentAgentId, sentConvId, (prev) =>
          prev.filter((item) => item.id !== optimisticQueueItem.id),
        );
        setChatError(err instanceof Error ? err.message : 'Failed to send message');
        throw err;
      } finally {
        if (!alreadyBusy) {
          setConversationPending(sentAgentId, sentConvId, false);
        }
      }
    },
    [
      activeAgentId,
      activeConvId,
      beginRunHandoff,
      clearRunHandoff,
      ensureAgentCliAvailable,
      fetchConversations,
      fetchMessages,
      fetchQueueItems,
      requestAutoScrollToBottom,
      setActiveConversationQueueItems,
      setConversationPending,
      streaming,
    ],
  );

  async function handleSwitchBranch(messageId: string) {
    if (!activeAgentId || !activeConvId) return;
    try {
      const data = await api<{ entries: ChatMessage[] }>(
        `/agents/${activeAgentId}/chat/conversations/${activeConvId}/switch-branch`,
        {
          method: 'POST',
          body: JSON.stringify({ messageId }),
        },
      );
      cancelEditingMessage();
      setActiveConversationMessages(activeAgentId, activeConvId, data.entries);
    } catch {
      toast.error('Failed to switch branch');
    }
  }

  function startEditingMessage(msg: ChatMessage) {
    if (editingMessage?.isSubmitting) return;
    if (!isEditableChatMessage(msg) || !activeAgentId || !activeConvId) return;
    setEditingMessage({
      agentId: activeAgentId,
      conversationId: activeConvId,
      id: msg.id,
      initialValue: msg.content,
      value: msg.content,
      existingImages: getChatMessageImages(msg),
      isSubmitting: false,
    });
  }

  function cancelEditingMessage() {
    setEditingMessage(null);
  }

  async function submitEditedMessage(files: File[], keepStoragePaths: string[]) {
    if (!editingMessage || editingMessage.isSubmitting) return;
    if (!ensureAgentCliAvailable(editingMessage.agentId)) return;

    const trimmedContent = editingMessage.value.trim();
    if (!trimmedContent && files.length === 0 && keepStoragePaths.length === 0) return;

    const { agentId: sentAgentId, conversationId: sentConvId, id: messageId } = editingMessage;
    const content = trimmedContent;
    const requestId = `edit-${Date.now()}-${generateId()}`;
    const headers = {
      'Idempotency-Key': `agent-chat-edit:${sentAgentId}:${sentConvId}:${messageId}:${requestId}`,
    };

    setEditingMessage((prev) => {
      if (!prev) return prev;
      if (
        prev.agentId !== sentAgentId ||
        prev.conversationId !== sentConvId ||
        prev.id !== messageId
      ) {
        return prev;
      }
      return { ...prev, isSubmitting: true };
    });
    setChatError(null);
    requestAutoScrollToBottom();

    beginRunHandoff(sentAgentId, sentConvId);
    setConversationPending(sentAgentId, sentConvId, true);
    try {
      let response: EditMessageResponse;
      if (files.length > 0) {
        const fd = new FormData();
        fd.append('messageId', messageId);
        if (content) fd.append('content', content);
        for (const storagePath of keepStoragePaths) {
          fd.append('keepStoragePaths', storagePath);
        }
        for (const file of files) {
          const prepared = await prepareImageForUpload(file);
          fd.append('files', prepared, prepared.name);
        }
        response = await apiUpload<EditMessageResponse>(
          `/agents/${sentAgentId}/chat/conversations/${sentConvId}/edit-message-upload`,
          fd,
          { headers },
        );
      } else {
        response = await api<EditMessageResponse>(
          `/agents/${sentAgentId}/chat/conversations/${sentConvId}/edit-message`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ messageId, content, keepStoragePaths }),
          },
        );
      }
      if (response.message) {
        setOptimisticResponseParent(sentAgentId, sentConvId, response.message.id);
      }
      if (isActiveConversation(sentAgentId, sentConvId)) {
        setActiveConversationMessages(sentAgentId, sentConvId, response.entries);
      }
      setEditingMessage((prev) => {
        if (!prev) return prev;
        if (
          prev.agentId !== sentAgentId ||
          prev.conversationId !== sentConvId ||
          prev.id !== messageId
        ) {
          return prev;
        }
        return null;
      });
      await Promise.all([
        fetchConversations(sentAgentId),
        fetchQueueItems(sentAgentId, sentConvId),
        fetchConversationRun(sentAgentId, sentConvId),
      ]);
    } catch (err) {
      clearRunHandoff(sentAgentId, sentConvId);
      setChatError(err instanceof Error ? err.message : 'Failed to edit message');
      throw err;
    } finally {
      setEditingMessage((prev) => {
        if (!prev) return prev;
        if (
          prev.agentId !== sentAgentId ||
          prev.conversationId !== sentConvId ||
          prev.id !== messageId
        ) {
          return prev;
        }
        return { ...prev, isSubmitting: false };
      });
      setConversationPending(sentAgentId, sentConvId, false);
    }
  }

  async function handleSwitchBranchByOffset(
    ids: string[] | undefined,
    index: number | undefined,
    offset: number,
  ) {
    const targetId = getBranchTargetIdByOffset(ids, index, offset);
    if (targetId) void handleSwitchBranch(targetId);
  }

  /* ── Image paste/upload ── */

  /* ── Agent CRUD ── */
  const selectedModel = MODELS.find((m) => m.id === form.model);
  const selectedCli = getCliInfoForModel(cliStatus, form.model);
  const selectedPreset = presets.find((preset) => preset.id === form.preset);
  const cliMissing = selectedCli ? !selectedCli.installed : false;
  const selectedKey = apiKeys.find((k) => k.id === form.apiKeyId);

  function openCreate(presetGroupId?: string) {
    const f = makeEmptyForm();
    if (presetGroupId) f.groupId = presetGroupId;
    setForm(f);
    setFormErrors({});
    setCreateAvatarOpen(false);
    setCreateOpen(true);
    // Fetch supporting data
    (async () => {
      setApiKeysLoading(true);
      try {
        const [apiKeysResult, agentDefaultsResult] = await Promise.allSettled([
          api<ApiKeysResponse>('/api-keys?limit=100'),
          api<AgentDefaultsResponse>('/settings/agent-defaults'),
        ]);
        if (apiKeysResult.status !== 'fulfilled') return;
        const activeKeys = apiKeysResult.value.entries.filter((k) => k.isActive);
        const defaultKeyId =
          agentDefaultsResult.status === 'fulfilled'
            ? agentDefaultsResult.value.defaultAgentKeyId
            : null;
        setApiKeys(activeKeys);
        setForm((current) => {
          if (current.newKey || current.apiKeyId) return current;
          if (!defaultKeyId) return current;
          const hasDefaultKey = activeKeys.some((key) => key.id === defaultKeyId);
          if (!hasDefaultKey) return current;
          return { ...current, apiKeyId: defaultKeyId };
        });
      } catch {
        /* empty */
      } finally {
        setApiKeysLoading(false);
      }
    })();
    (async () => {
      try {
        const data = await api<{ presets: Preset[] }>('/agents/presets');
        setPresets(data.presets);
      } catch {
        /* empty */
      }
    })();
    void fetchCliStatus();
  }

  function closeCreate() {
    setCreateOpen(false);
    setCreateAvatarOpen(false);
    setPickingPresetDirectoryKey(null);
    setForm(makeEmptyForm());
    setFormErrors({});
  }

  function updatePresetParameterValue(key: string, value: string) {
    setForm((f) => ({
      ...f,
      presetParameters: {
        ...f.presetParameters,
        [key]: value,
      },
    }));
    setFormErrors((prev) => {
      const errorKey = `presetParameters.${key}`;
      if (!prev[errorKey]) return prev;
      const next = { ...prev };
      delete next[errorKey];
      return next;
    });
  }

  async function handlePickPresetDirectory(key: string) {
    setPickingPresetDirectoryKey(key);
    try {
      const currentValue = form.presetParameters[key]?.trim();
      const result = await api<{ path: string | null }>('/storage/pick-folder', {
        method: 'POST',
        body: JSON.stringify({
          startPath: currentValue || undefined,
        }),
      });
      if (result.path) {
        updatePresetParameterValue(key, result.path);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to open folder picker');
    } finally {
      setPickingPresetDirectoryKey((current) => (current === key ? null : current));
    }
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
    } catch {
      /* silently fail */
    }
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
    } catch {
      /* silently fail */
    }
  }

  async function handleDeleteGroup(id: string) {
    try {
      await api(`/agent-groups/${id}`, { method: 'DELETE' });
      setGroups((prev) => prev.filter((g) => g.id !== id));
      // Move agents in this group to ungrouped
      setAgents((prev) => prev.map((a) => (a.groupId === id ? { ...a, groupId: null } : a)));
    } catch {
      /* silently fail */
    }
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
    } catch {
      /* silently fail */
    }
    setEditingName(false);
  }

  async function handleChangeAvatar(agentId: string, avatar: AvatarConfig) {
    try {
      const updated = await api<Agent>(`/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          avatarIcon: avatar.icon,
          avatarBgColor: avatar.bgColor,
          avatarLogoColor: avatar.logoColor,
        }),
      });
      setAgents((prev) => prev.map((a) => (a.id === agentId ? updated : a)));
      if (settingsAgent?.id === agentId) setSettingsAgent(updated);
    } catch (error) {
      const message =
        error instanceof ApiError && error.message ? error.message : 'Failed to update avatar';
      toast.error(message);
      throw error;
    }
  }

  async function handleCreateAvatarPreset(input: { name: string; icon: string }) {
    try {
      const created = await api<AvatarPreset>('/agent-avatar-presets', {
        method: 'POST',
        body: JSON.stringify({
          name: input.name,
          avatarIcon: input.icon,
        }),
      });
      setAvatarPresets((prev) => [created, ...prev]);
    } catch (error) {
      const message =
        error instanceof ApiError && error.message
          ? error.message
          : 'Failed to save avatar shape preset';
      toast.error(message);
      throw error;
    }
  }

  async function handleRenameAvatarPreset(presetId: string, name: string) {
    try {
      const updated = await api<AvatarPreset>(`/agent-avatar-presets/${presetId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      setAvatarPresets((prev) => prev.map((preset) => (preset.id === presetId ? updated : preset)));
    } catch (error) {
      const message =
        error instanceof ApiError && error.message
          ? error.message
          : 'Failed to rename avatar preset';
      toast.error(message);
      throw error;
    }
  }

  async function handleDeleteAvatarPreset(presetId: string) {
    try {
      await api(`/agent-avatar-presets/${presetId}`, { method: 'DELETE' });
      setAvatarPresets((prev) => prev.filter((preset) => preset.id !== presetId));
    } catch (error) {
      const message =
        error instanceof ApiError && error.message
          ? error.message
          : 'Failed to delete avatar preset';
      toast.error(message);
      throw error;
    }
  }

  async function handleCreateColorPreset(input: {
    name: string;
    bgColor: string;
    logoColor: string;
  }) {
    try {
      const created = await api<ColorPreset>('/agent-color-presets', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      setColorPresets((prev) => [created, ...prev]);
    } catch (error) {
      const message =
        error instanceof ApiError && error.message ? error.message : 'Failed to save color preset';
      toast.error(message);
      throw error;
    }
  }

  async function handleDeleteColorPreset(presetId: string) {
    try {
      await api(`/agent-color-presets/${presetId}`, { method: 'DELETE' });
      setColorPresets((prev) => prev.filter((preset) => preset.id !== presetId));
    } catch (error) {
      const message =
        error instanceof ApiError && error.message
          ? error.message
          : 'Failed to delete color preset';
      toast.error(message);
      throw error;
    }
  }

  async function handleChangeAgentModel(
    agentId: string,
    field: 'model' | 'modelId' | 'thinkingLevel',
    value: string,
  ) {
    const body: Record<string, unknown> = { [field]: value || null };
    // Clear modelId when switching provider; clear thinkingLevel for CLIs that don't support it.
    if (field === 'model') {
      body.modelId = getAgentModelDefaultId(value) || null;
      if (!supportsThinkingLevel(value)) {
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
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Failed to update agent');
    }
  }

  async function handleChangeAgentGroup(agentId: string, groupId: string | null) {
    try {
      const updated = await api<Agent>(`/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ groupId }),
      });
      setAgents((prev) => prev.map((a) => (a.id === agentId ? updated : a)));
      if (settingsAgent?.id === agentId) setSettingsAgent(updated);
    } catch {
      /* silently fail */
    }
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

  function collapseAgent(id: string) {
    setCollapsedAgents((prev) => {
      if (prev === 'all' || prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  const toggleAgentCollapse = useCallback((id: string) => {
    setCollapsedAgents((prev) => {
      if (prev === 'all') {
        // Expand this one agent, collapse the rest
        const next = new Set(agentsRef.current.map((agent) => agent.id));
        next.delete(id);
        return next;
      }
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const errors: Record<string, string> = {};
    if (!form.name.trim()) errors.name = 'Name is required';
    if (cliMissing && selectedCli) errors.model = getCliUnavailableMessage(selectedCli);
    for (const parameter of selectedPreset?.parameters ?? []) {
      const value = form.presetParameters[parameter.key]?.trim() ?? '';
      if (parameter.required && !value) {
        errors[`presetParameters.${parameter.key}`] = `${parameter.label} is required`;
      }
    }
    if (form.newKey) {
      if (form.newKeyPermissions.length === 0)
        errors.permissions = 'Select at least one permission';
    } else {
      if (!form.apiKeyId) errors.apiKeyId = 'Select a workspace API key';
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
          presetParameters: serializePresetParameters(selectedPreset, form.presetParameters),
          apiKeyId: keyId,
          workspaceId: activeWorkspaceId || undefined,
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
        const conv = await api<ChatConversation>(`/agents/${newAgent.id}/chat/conversations`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        setConvsByAgent((prev) => ({ ...prev, [newAgent.id]: [conv] }));
        setActiveConversation(newAgent.id, conv.id);
        setMessages([]);
        isFirstMessageRef.current = true;
      } catch {
        setConvsByAgent((prev) => ({ ...prev, [newAgent.id]: [] }));
        setActiveConversation(newAgent.id, null);
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
      for (const conversation of convsByAgent[id] || []) {
        clearRunHandoff(id, conversation.id);
      }
      if (activeAgentId === id) {
        setActiveConversation(null, null);
        setMessages([]);
      }
      setDeletingId(null);
      setSettingsAgent(null);
    } catch {
      // silently fail
    }
  }

  function handleOpenAgentEnvVarCreate() {
    setAgentEnvVarForm(createEmptyAgentEnvVarForm());
    setAgentEnvVarFormErrors({});
    setAgentEnvVarFormOpen(true);
  }

  function handleCloseAgentEnvVarForm() {
    setAgentEnvVarFormOpen(false);
    setAgentEnvVarForm(createEmptyAgentEnvVarForm());
    setAgentEnvVarFormErrors({});
  }

  function handleEditAgentEnvVar(envVar: AgentEnvVar) {
    setAgentEnvVarForm({
      id: envVar.id,
      key: envVar.key,
      value: '',
      description: envVar.description ?? '',
      isActive: envVar.isActive,
    });
    setAgentEnvVarFormErrors({});
    setAgentEnvVarFormOpen(true);
  }

  async function handleSubmitAgentEnvVar() {
    if (!settingsAgent) return;

    const errors = validateAgentEnvVarForm(agentEnvVarForm);
    setAgentEnvVarFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const payload: {
      key: string;
      value?: string;
      description?: string;
      isActive: boolean;
    } = {
      key: agentEnvVarForm.key.trim().toUpperCase(),
      description: agentEnvVarForm.description.trim() || undefined,
      isActive: agentEnvVarForm.isActive,
    };

    if (!agentEnvVarForm.id || agentEnvVarForm.value.length > 0) {
      payload.value = agentEnvVarForm.value;
    }

    setAgentEnvVarSaving(true);
    try {
      if (agentEnvVarForm.id) {
        await api(`/agents/${settingsAgent.id}/env-vars/${agentEnvVarForm.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await api(`/agents/${settingsAgent.id}/env-vars`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }

      await fetchAgentEnvVars(settingsAgent.id);
      handleCloseAgentEnvVarForm();
      toast.success(agentEnvVarForm.id ? 'Env var updated' : 'Env var added');
    } catch (error) {
      const formErrors = mapAgentEnvVarApiErrorToFormErrors(error, Boolean(agentEnvVarForm.id));
      if (formErrors) {
        setAgentEnvVarFormErrors(formErrors);
      }
      const message =
        error instanceof ApiError && error.message ? error.message : 'Failed to save env var';
      toast.error(message);
    } finally {
      setAgentEnvVarSaving(false);
    }
  }

  async function handleDeleteAgentEnvVar(envVar: AgentEnvVar) {
    if (!settingsAgent) return;
    const ok = await confirm({
      title: 'Delete environment variable',
      message: `Remove "${envVar.key}" from this agent? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!ok) return;

    try {
      await api(`/agents/${settingsAgent.id}/env-vars/${envVar.id}`, {
        method: 'DELETE',
      });
      await fetchAgentEnvVars(settingsAgent.id);
      if (agentEnvVarForm.id === envVar.id) {
        handleCloseAgentEnvVarForm();
      }
      toast.success('Env var deleted');
    } catch (error) {
      const message =
        error instanceof ApiError && error.message ? error.message : 'Failed to delete env var';
      toast.error(message);
    }
  }

  async function handleToggleAgentEnvVar(envVar: AgentEnvVar) {
    if (!settingsAgent) return;

    try {
      await api(`/agents/${settingsAgent.id}/env-vars/${envVar.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !envVar.isActive }),
      });
      await fetchAgentEnvVars(settingsAgent.id);
    } catch (error) {
      const message =
        error instanceof ApiError && error.message ? error.message : 'Failed to update env var';
      toast.error(message);
    }
  }

  /* ── Derived data ── */
  const activeAgent = agents.find((a) => a.id === activeAgentId) ?? null;
  const deferredSearch = useDeferredValue(search);
  const filteredAgents = useMemo(() => {
    const normalizedSearch = deferredSearch.trim().toLowerCase();
    if (!normalizedSearch) return agents;
    return agents.filter((agent) => agent.name.toLowerCase().includes(normalizedSearch));
  }, [agents, deferredSearch]);
  const sortedAgentEnvVars = useMemo(() => {
    const sorted = [...agentEnvVars].sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      const aLastUsed = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
      const bLastUsed = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
      if (aLastUsed !== bLastUsed) return bLastUsed - aLastUsed;
      return a.key.localeCompare(b.key);
    });
    return sorted;
  }, [agentEnvVars]);
  const visibleAgentEnvVars = useMemo(
    () => sortedAgentEnvVars.filter((envVar) => envVar.id !== agentEnvVarForm.id),
    [agentEnvVarForm.id, sortedAgentEnvVars],
  );
  const isEnvVarEmptyState = !agentEnvVarFormOpen && visibleAgentEnvVars.length === 0;

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
  const handleOpenAgentContextMenu = useCallback((agentId: string, x: number, y: number) => {
    setContextMenu({ agentId, x, y });
  }, []);
  const handleOpenAgentSettings = useCallback((agent: Agent) => {
    setSettingsAgent(agent);
  }, []);

  /* ── Skills manager helpers ── */

  async function mgrFetchSkills() {
    setMgrLoading(true);
    try {
      const data = await api<{ entries: SkillFull[] }>('/skills');
      setMgrSkills(data.entries);
    } catch {
      /* ignore */
    } finally {
      setMgrLoading(false);
    }
  }

  function mgrResetSkillForm() {
    setMgrCreating(false);
    setMgrEditingId(null);
    setMgrFormName('');
    setMgrFormDesc('');
    setMgrFormError('');
  }

  function mgrOpenCreate() {
    setMgrCreating(true);
    setMgrEditingId(null);
    setMgrFormName('');
    setMgrFormDesc('');
    setMgrFormError('');
  }

  function mgrOpenEdit(skill: SkillFull) {
    setMgrCreating(false);
    setMgrEditingId(skill.id);
    setMgrFormName(skill.name);
    setMgrFormDesc(skill.description);
    setMgrFormError('');
    setMgrActiveSkillId(skill.id);
  }

  useEffect(() => {
    if (!skillsManagerOpen || (!mgrCreating && !mgrEditingId)) return;
    mgrNameRef.current?.focus();
    if (mgrEditingId) mgrNameRef.current?.select();
  }, [skillsManagerOpen, mgrCreating, mgrEditingId]);

  useEffect(() => {
    if (!skillsManagerOpen) return;
    const originalBodyOverflow = document.body.style.overflow;
    const originalHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalBodyOverflow;
      document.documentElement.style.overflow = originalHtmlOverflow;
    };
  }, [skillsManagerOpen]);

  function openSkillsManager() {
    setSkillsManagerOpen(true);
    setMgrActiveSkillId(null);
    mgrResetSkillForm();
    void mgrFetchSkills();
  }

  function mgrIsFormDirty() {
    if (mgrCreating) {
      return Boolean(mgrFormName.trim() || mgrFormDesc.trim());
    }

    if (!mgrEditingId) return false;

    const editingSkill = mgrSkills.find((skill) => skill.id === mgrEditingId);
    if (!editingSkill) return false;

    return mgrFormName !== editingSkill.name || mgrFormDesc !== editingSkill.description;
  }

  async function mgrAbandonFormIfConfirmed() {
    if (!mgrCreating && !mgrEditingId) return true;
    if (!mgrIsFormDirty()) {
      mgrResetSkillForm();
      return true;
    }

    const confirmed = await confirm({
      title: 'Discard changes',
      message: 'You have unsaved skill changes. Discard them and continue?',
      confirmLabel: 'Discard',
      variant: 'danger',
    });

    if (!confirmed) return false;

    mgrResetSkillForm();
    return true;
  }

  async function closeSkillsManager() {
    if (!(await mgrAbandonFormIfConfirmed())) return;
    setSkillsManagerOpen(false);
  }

  async function mgrHandleCreateRequest() {
    if (!(await mgrAbandonFormIfConfirmed())) return;
    mgrOpenCreate();
  }

  async function mgrHandleSelectSkill(skillId: string) {
    if (mgrEditingId === skillId && !mgrCreating) return;
    if (mgrActiveSkillId === skillId && !mgrCreating && !mgrEditingId) return;
    if (!(await mgrAbandonFormIfConfirmed())) return;
    setMgrActiveSkillId(skillId);
  }

  async function mgrHandleEditRequest(skill: SkillFull) {
    if (mgrEditingId === skill.id && !mgrCreating) return;
    if (!(await mgrAbandonFormIfConfirmed())) return;
    mgrOpenEdit(skill);
  }

  async function mgrCreateSkill() {
    const trimmed = mgrFormName.trim();
    if (!trimmed) return;
    setMgrSaving(true);
    setMgrFormError('');
    try {
      const s = await api<SkillFull>('/skills', {
        method: 'POST',
        body: JSON.stringify({ name: trimmed, description: mgrFormDesc.trim() }),
      });
      setMgrSkills((prev) => [...prev, s].sort((a, b) => a.name.localeCompare(b.name)));
      mgrResetSkillForm();
      setMgrActiveSkillId(s.id);
      toast.success(`Skill "${trimmed}" created`);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to create skill';
      setMgrFormError(message);
      toast.error(message);
    } finally {
      setMgrSaving(false);
    }
  }

  async function mgrUpdateSkill(id: string) {
    const trimmed = mgrFormName.trim();
    if (!trimmed) return;
    if (!mgrIsFormDirty()) {
      mgrResetSkillForm();
      return;
    }
    setMgrSaving(true);
    setMgrFormError('');
    try {
      const updated = await api<SkillFull>(`/skills/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: trimmed, description: mgrFormDesc.trim() }),
      });
      setMgrSkills((prev) => prev.map((s) => (s.id === id ? updated : s)));
      mgrResetSkillForm();
      setMgrActiveSkillId(updated.id);
      toast.success('Skill updated');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to update skill';
      setMgrFormError(message);
      toast.error(message);
    } finally {
      setMgrSaving(false);
    }
  }

  async function mgrDeleteSkill(id: string) {
    const skill = mgrSkills.find((entry) => entry.id === id);
    const confirmed = await confirm({
      title: 'Delete skill',
      message: `Delete "${skill?.name ?? 'this skill'}" from the preset library? Existing agent-local copies stay in place.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await api(`/skills/${id}`, { method: 'DELETE' });
      setMgrSkills((prev) => prev.filter((s) => s.id !== id));
      if (mgrActiveSkillId === id) setMgrActiveSkillId(null);
      if (mgrEditingId === id) mgrResetSkillForm();
      toast.success('Skill deleted');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to delete skill');
    }
  }

  useEffect(() => {
    if (!skillsManagerOpen) return;

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      const target = event.target;
      if (target instanceof Element && target.closest('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      void (async () => {
        if (mgrCreating || mgrEditingId) {
          await mgrAbandonFormIfConfirmed();
          return;
        }
        setSkillsManagerOpen(false);
      })();
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [mgrAbandonFormIfConfirmed, mgrCreating, mgrEditingId, skillsManagerOpen]);

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
              <div className={styles.headerMenuWrap} ref={headerMenuRef}>
                <Tooltip label="More actions">
                  <button
                    className={styles.addAgentBtn}
                    onClick={() => setHeaderMenuOpen(!headerMenuOpen)}
                    aria-label="More actions"
                  >
                    <MoreHorizontal size={16} />
                  </button>
                </Tooltip>
                {headerMenuOpen && (
                  <div className={styles.headerMenu}>
                    <button
                      className={styles.headerMenuItem}
                      onClick={() => {
                        openSkillsManager();
                        setHeaderMenuOpen(false);
                      }}
                    >
                      <Blocks size={14} />
                      Skills manager
                    </button>
                    <button
                      className={styles.headerMenuItem}
                      onClick={() => {
                        setPageSettingsOpen(!pageSettingsOpen);
                        setHeaderMenuOpen(false);
                      }}
                    >
                      <SlidersHorizontal size={14} />
                      Page settings
                    </button>
                    <button
                      className={styles.headerMenuItem}
                      onClick={() => {
                        setManageGroupsOpen(!manageGroupsOpen);
                        setHeaderMenuOpen(false);
                      }}
                    >
                      <Layers size={14} />
                      Manage groups
                    </button>
                    <div className={styles.headerMenuDivider} />
                    <button
                      className={styles.headerMenuItem}
                      onClick={() => {
                        setCollapsedAgents('all');
                        setHeaderMenuOpen(false);
                      }}
                    >
                      <ChevronsDownUp size={14} />
                      Collapse all
                    </button>
                    <button
                      className={styles.headerMenuItem}
                      onClick={() => {
                        setCollapsedAgents(new Set());
                        setHeaderMenuOpen(false);
                      }}
                    >
                      <ChevronsUpDown size={14} />
                      Expand all
                    </button>
                    <div className={styles.headerMenuDivider} />
                    <button
                      className={styles.headerMenuItem}
                      onClick={() => {
                        void cleanAllConversations();
                        setHeaderMenuOpen(false);
                      }}
                    >
                      <Eraser size={14} />
                      Clean all chats
                    </button>
                  </div>
                )}
              </div>
              <Tooltip label="Add agent">
                <button
                  className={styles.addAgentBtn}
                  onClick={() => openCreate()}
                  aria-label="Add agent"
                >
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
                <button
                  className={styles.modalCloseBtn}
                  onClick={() => setPageSettingsOpen(false)}
                  style={{ width: 24, height: 24 }}
                >
                  <X size={14} />
                </button>
              </div>
              <div className={styles.manageGroupsList}>
                <div className={styles.manageGroupItem}>
                  <span style={{ flex: 1, fontSize: 13, color: 'var(--color-text)' }}>
                    Auto-collapse chats on open
                  </span>
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
                <button
                  className={styles.modalCloseBtn}
                  onClick={() => setManageGroupsOpen(false)}
                  style={{ width: 24, height: 24 }}
                >
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
                        onClick={() => {
                          setEditingGroupId(group.id);
                          setEditingGroupName(group.name);
                        }}
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
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateGroup();
                  }}
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
                          onClick={(e) => {
                            e.stopPropagation();
                            openCreate(group.id);
                          }}
                          title="Add agent to group"
                        >
                          <Plus size={13} />
                        </button>
                      </div>
                      {!isCollapsed &&
                        groupAgents.map((agent) => (
                          <AgentSidebarItem
                            key={agent.id}
                            agent={agent}
                            conversations={convsByAgent[agent.id] || []}
                            collapsed={isAgentCollapsed(agent.id)}
                            isActive={activeAgentId === agent.id}
                            activeConversationId={activeAgentId === agent.id ? activeConvId : null}
                            groupsEnabled={groups.length > 0}
                            pendingConversationKeys={pendingConversationKeys}
                            onToggleCollapse={toggleAgentCollapse}
                            onOpenContextMenu={handleOpenAgentContextMenu}
                            onOpenSettings={handleOpenAgentSettings}
                            onCleanConversations={cleanConversations}
                            onCreateConversation={createConversation}
                            onSelectConversation={selectConversation}
                            onDeleteConversation={deleteConversation}
                          />
                        ))}
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
                          <button
                            className={styles.sidebarGroupAddBtn}
                            onClick={(e) => {
                              e.stopPropagation();
                              openCreate();
                            }}
                            title="Add agent"
                          >
                            <Plus size={13} />
                          </button>
                        </div>
                      )}
                      {(!showHeader || !isCollapsed) &&
                        ungrouped.map((agent) => (
                          <AgentSidebarItem
                            key={agent.id}
                            agent={agent}
                            conversations={convsByAgent[agent.id] || []}
                            collapsed={isAgentCollapsed(agent.id)}
                            isActive={activeAgentId === agent.id}
                            activeConversationId={activeAgentId === agent.id ? activeConvId : null}
                            groupsEnabled={groups.length > 0}
                            pendingConversationKeys={pendingConversationKeys}
                            onToggleCollapse={toggleAgentCollapse}
                            onOpenContextMenu={handleOpenAgentContextMenu}
                            onOpenSettings={handleOpenAgentSettings}
                            onCleanConversations={cleanConversations}
                            onCreateConversation={createConversation}
                            onSelectConversation={selectConversation}
                            onDeleteConversation={deleteConversation}
                          />
                        ))}
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
                  {showChatLoading && messages.length === 0 ? (
                    <div className={styles.emptyPanel}>
                      <Loader size={20} className={styles.chatSpinner} />
                      <div className={styles.emptyText}>Loading messages…</div>
                    </div>
                  ) : messages.length === 0 &&
                    !streaming &&
                    !chatLoading &&
                    orphanErrorItems.length === 0 ? (
                    <div className={styles.emptyPanel}>
                      <MessageSquare size={36} strokeWidth={1.5} className={styles.emptyIcon} />
                      <div className={styles.emptyTitle}>Start a conversation</div>
                      <div className={styles.emptyText}>
                        Send a message to begin chatting with {activeAgent.name}
                      </div>
                    </div>
                  ) : (
                    <div
                      className={styles.messagesArea}
                      ref={messagesRef}
                      onScroll={handleMessagesScroll}
                    >
                      {messages.map((msg) => {
                        const messageMeta = parseAgentMessageMetadata(msg.metadata);
                        const monitorRunId =
                          msg.direction === 'inbound' ? (messageMeta?.runId ?? null) : null;
                        const branchExecutionItems =
                          effectivePendingBranchExecutionsByMessageId.get(msg.id) ?? [];
                        const processingBranchExecutionCount = branchExecutionItems.filter(
                          (item) => item.status === 'processing',
                        ).length;
                        const queuedBranchExecutionCount = branchExecutionItems.filter(
                          (item) => item.status === 'queued',
                        ).length;
                        const branchExecutionLabel =
                          queuedBranchExecutionCount > 0
                            ? queuedBranchExecutionCount === 1
                              ? 'Edit queued to run'
                              : `${queuedBranchExecutionCount} edits queued to run`
                            : null;

                        return (
                          <Fragment key={msg.id}>
                            <div
                              className={`${styles.messageRow} ${
                                msg.direction === 'outbound'
                                  ? styles.messageRowUser
                                  : styles.messageRowAgent
                              }`}
                            >
                              <div className={styles.messageContent}>
                                {/* Branch navigator */}
                                {(msg.siblingCount ?? 0) > 1 && (
                                  <div
                                    className={`${styles.branchNav} ${msg.direction === 'outbound' ? styles.branchNavUser : ''}`}
                                  >
                                    <button
                                      className={styles.branchNavBtn}
                                      disabled={(msg.siblingIndex ?? 0) === 0}
                                      onClick={() =>
                                        void handleSwitchBranchByOffset(
                                          msg.siblingIds,
                                          msg.siblingIndex,
                                          -1,
                                        )
                                      }
                                      aria-label="Previous branch"
                                    >
                                      <ArrowLeft size={12} />
                                    </button>
                                    <span className={styles.branchNavLabel}>
                                      {(msg.siblingIndex ?? 0) + 1}/{msg.siblingCount}
                                    </span>
                                    <button
                                      className={styles.branchNavBtn}
                                      disabled={
                                        (msg.siblingIndex ?? 0) >= (msg.siblingCount ?? 1) - 1
                                      }
                                      onClick={() =>
                                        void handleSwitchBranchByOffset(
                                          msg.siblingIds,
                                          msg.siblingIndex,
                                          1,
                                        )
                                      }
                                      aria-label="Next branch"
                                    >
                                      <ArrowRight size={12} />
                                    </button>
                                  </div>
                                )}
                                <div
                                  className={`${styles.messageBubble} ${
                                    msg.direction === 'outbound'
                                      ? styles.messageBubbleUser
                                      : styles.messageBubbleAgent
                                  } ${msg.attachments?.some((a) => a.type === 'image') ? styles.messageBubbleImage : ''}`}
                                >
                                  {msg.attachments?.map((att, i) =>
                                    att.type === 'image' ? (
                                      <ChatImage
                                        key={i}
                                        storagePath={att.storagePath}
                                        alt={att.fileName}
                                      />
                                    ) : (
                                      <ChatFileAttachment key={i} attachment={att} />
                                    ),
                                  )}
                                  {msg.content &&
                                    (msg.direction === 'inbound' ? (
                                      <MarkdownContent>{msg.content}</MarkdownContent>
                                    ) : (
                                      <div className={styles.messagePlainText}>{msg.content}</div>
                                    ))}
                                </div>
                                {msg.direction === 'inbound' && messageMeta?.fallbackRetry && (
                                  <div className={styles.fallbackNotice} role="status">
                                    <AlertTriangle size={14} aria-hidden />
                                    <span>
                                      Model error — switched to{' '}
                                      <strong>{messageMeta.fallbackModel ?? 'fallback'}</strong>
                                    </span>
                                  </div>
                                )}
                                <div
                                  className={`${styles.messageMeta} ${
                                    msg.direction === 'outbound' ? styles.messageMetaUser : ''
                                  }`}
                                >
                                  {branchExecutionLabel && (
                                    <span
                                      className={`${styles.messageExecutionState} ${styles.messageExecutionStateQueued}`}
                                    >
                                      {branchExecutionLabel}
                                    </span>
                                  )}
                                  {new Date(msg.createdAt).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}
                                  {isEditableChatMessage(msg) && (
                                    <button
                                      className={styles.editMsgBtn}
                                      onClick={() => startEditingMessage(msg)}
                                      aria-label="Edit message"
                                      disabled={editingMessage?.isSubmitting}
                                    >
                                      <Pencil size={12} />
                                    </button>
                                  )}
                                  {msg.direction === 'inbound' && (
                                    <>
                                      {monitorRunId && (
                                        <button
                                          className={styles.messageMonitorBtn}
                                          onClick={() => openMonitorRun(monitorRunId)}
                                          aria-label="Open run in monitor"
                                          title="Open exact run in monitor"
                                        >
                                          <ExternalLink size={12} />
                                          Monitor
                                        </button>
                                      )}
                                      <button
                                        className={styles.copyBtn}
                                        onClick={() => {
                                          navigator.clipboard.writeText(msg.content);
                                          setCopiedId(msg.id);
                                          setTimeout(() => setCopiedId(null), 1500);
                                        }}
                                        aria-label="Copy message"
                                      >
                                        {copiedId === msg.id ? (
                                          <Check size={12} />
                                        ) : (
                                          <Copy size={12} />
                                        )}
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                            {/* Inline errors targeting this specific message */}
                            {errorsByMessageId.get(msg.id)?.map((item) => (
                              <div
                                key={item.id}
                                className={`${styles.messageRow} ${styles.messageRowAgent}`}
                              >
                                <div className={styles.messageContent}>
                                  <div
                                    className={`${styles.errorNotice} ${item.status === 'cancelled' ? styles.stoppedNotice : ''}`}
                                  >
                                    <div className={styles.errorNoticeIcon}>
                                      {item.status === 'cancelled' ? (
                                        <OctagonX size={14} />
                                      ) : (
                                        <AlertTriangle size={14} />
                                      )}
                                    </div>
                                    <div className={styles.errorNoticeBody}>
                                      <div className={styles.errorNoticeTitle}>
                                        {item.status === 'cancelled' ? 'Run stopped' : 'Run failed'}
                                      </div>
                                      {item.status !== 'cancelled' && item.errorMessage && (
                                        <div className={styles.errorNoticeDetail}>
                                          {item.errorMessage}
                                        </div>
                                      )}
                                      {item.status !== 'cancelled' && item.prompt && (
                                        <div className={styles.errorNoticePrompt}>
                                          {item.prompt.length > 100
                                            ? item.prompt.slice(0, 100) + '…'
                                            : item.prompt}
                                        </div>
                                      )}
                                    </div>
                                    <div className={styles.errorNoticeActions}>
                                      {item.status !== 'cancelled' && (
                                        <button
                                          className={styles.errorRetryBtn}
                                          onClick={() => void handleRetryQueueItem(item.id)}
                                        >
                                          <RotateCcw size={12} />
                                          Retry
                                        </button>
                                      )}
                                      <button
                                        className={styles.errorDismissBtn}
                                        onClick={() => void handleDismissQueueItem(item.id)}
                                        aria-label="Dismiss"
                                      >
                                        <X size={12} />
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </Fragment>
                        );
                      })}

                      {/* Pending response bubble */}
                      {showStreamingBubble && (
                        <div className={`${styles.messageRow} ${styles.messageRowAgent}`}>
                          <div className={styles.messageContent}>
                            <div
                              className={`${styles.messageBubble} ${styles.messageBubbleAgent} ${styles.streamingCursor}`}
                            >
                              <span className={styles.streamingQueueInfo}>
                                <Loader size={13} className={styles.spinIcon} />
                                Thinking…
                              </span>
                            </div>
                            <div className={styles.streamingActions}>
                              {activeConversationRun && (
                                <button
                                  className={styles.messageMonitorBtn}
                                  onClick={() => openMonitorRun(activeConversationRun.id)}
                                  title="Open current run in monitor"
                                >
                                  <ExternalLink size={12} />
                                  Monitor
                                </button>
                              )}
                              {activeConversationRun && (
                                <button
                                  className={styles.stopRunBtn}
                                  onClick={stopActiveRun}
                                  disabled={stoppingRun}
                                  title="Stop the current run"
                                >
                                  <Square size={12} />
                                  Stop
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Orphan error items — no target message (append_prompt failures) */}
                      {orphanErrorItems.map((item) => (
                        <div
                          key={item.id}
                          className={`${styles.messageRow} ${styles.messageRowAgent}`}
                        >
                          <div className={styles.messageContent}>
                            <div
                              className={`${styles.errorNotice} ${item.status === 'cancelled' ? styles.stoppedNotice : ''}`}
                            >
                              <div className={styles.errorNoticeIcon}>
                                {item.status === 'cancelled' ? (
                                  <OctagonX size={14} />
                                ) : (
                                  <AlertTriangle size={14} />
                                )}
                              </div>
                              <div className={styles.errorNoticeBody}>
                                <div className={styles.errorNoticeTitle}>
                                  {item.status === 'cancelled' ? 'Run stopped' : 'Run failed'}
                                </div>
                                {item.status !== 'cancelled' && item.errorMessage && (
                                  <div className={styles.errorNoticeDetail}>
                                    {item.errorMessage}
                                  </div>
                                )}
                                {item.status !== 'cancelled' && item.prompt && (
                                  <div className={styles.errorNoticePrompt}>
                                    {item.prompt.length > 100
                                      ? item.prompt.slice(0, 100) + '…'
                                      : item.prompt}
                                  </div>
                                )}
                              </div>
                              <div className={styles.errorNoticeActions}>
                                {item.status !== 'cancelled' && (
                                  <button
                                    className={styles.errorRetryBtn}
                                    onClick={() => void handleRetryQueueItem(item.id)}
                                  >
                                    <RotateCcw size={12} />
                                    Retry
                                  </button>
                                )}
                                <button
                                  className={styles.errorDismissBtn}
                                  onClick={() => void handleDismissQueueItem(item.id)}
                                  aria-label="Dismiss"
                                >
                                  <X size={12} />
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Queue panel */}
                  {queuedQueueItems.length > 0 && (
                    <div className={styles.queuePanel}>
                      <div className={styles.queuePanelHeader}>
                        <button
                          className={styles.queuePanelToggle}
                          onClick={() => setQueuePanelOpen((v) => !v)}
                        >
                          <Clock size={13} />
                          <span>
                            {queuedQueueItems.length} message
                            {queuedQueueItems.length === 1 ? '' : 's'} in queue
                          </span>
                          <ChevronRight
                            size={14}
                            className={`${styles.queuePanelChevron} ${queuePanelOpen ? styles.queuePanelChevronOpen : ''}`}
                          />
                        </button>
                        <button
                          className={styles.queueClearAllBtn}
                          onClick={() => void handleClearQueue()}
                          title="Clear all queued messages"
                        >
                          <Trash2 size={12} />
                          Clear all
                        </button>
                      </div>
                      {queuePanelOpen && (
                        <div className={styles.queuePanelItems}>
                          {queuedQueueItems.map((item, idx) => (
                            <div key={item.id} className={styles.queueItem}>
                              <span className={styles.queueItemIndex}>{idx + 1}</span>
                              {editingQueueItemId === item.id ? (
                                <div className={styles.queueItemEditWrap}>
                                  <textarea
                                    className={styles.queueItemEditInput}
                                    value={editingQueuePrompt}
                                    onChange={(e) => setEditingQueuePrompt(e.target.value)}
                                    rows={2}
                                    autoFocus
                                    onKeyDown={(e) => {
                                      if (e.key === 'Escape') {
                                        setEditingQueueItemId(null);
                                        setEditingQueuePrompt('');
                                      }
                                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                        void handleSaveQueueItem(item.id);
                                      }
                                    }}
                                  />
                                  <div className={styles.queueItemEditActions}>
                                    <button
                                      className={styles.queueItemSaveBtn}
                                      onClick={() => void handleSaveQueueItem(item.id)}
                                      title="Save"
                                    >
                                      <Check size={13} />
                                    </button>
                                    <button
                                      className={styles.queueItemCancelBtn}
                                      onClick={() => {
                                        setEditingQueueItemId(null);
                                        setEditingQueuePrompt('');
                                      }}
                                      title="Cancel"
                                    >
                                      <X size={13} />
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <span className={styles.queueItemPrompt} title={item.prompt}>
                                    {item.prompt}
                                  </span>
                                  <div className={styles.queueItemActions}>
                                    <button
                                      className={styles.queueItemEditBtn}
                                      onClick={() => {
                                        setEditingQueueItemId(item.id);
                                        setEditingQueuePrompt(item.prompt);
                                      }}
                                      title="Edit"
                                    >
                                      <Pencil size={12} />
                                    </button>
                                    <button
                                      className={styles.queueItemDeleteBtn}
                                      onClick={() => void handleDeleteQueueItem(item.id)}
                                      title="Remove from queue"
                                    >
                                      <Trash2 size={12} />
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <ReplyComposer
                    streaming={streaming}
                    editingMessage={
                      editingMessage
                        ? {
                            ...editingMessage,
                            onChange: (value: string) =>
                              setEditingMessage((prev) => (prev ? { ...prev, value } : prev)),
                            onCancel: cancelEditingMessage,
                            onSubmit: submitEditedMessage,
                          }
                        : null
                    }
                    onSendAttachments={sendAttachmentMessage}
                    onSendText={sendTextMessage}
                  />
                </>
              )}
            </>
          ) : activeAgent && !activeConvId ? (
            <div className={styles.emptyPanel}>
              <MessageSquare size={36} strokeWidth={1.5} className={styles.emptyIcon} />
              <div className={styles.emptyTitle}>No conversations yet</div>
              <div className={styles.emptyText}>Start your first chat with {activeAgent.name}</div>
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
              !agents.find((a) => a.id === contextMenu.agentId)?.groupId
                ? styles.contextMenuItemActive
                : ''
            }`}
            onClick={() => {
              handleChangeAgentGroup(contextMenu.agentId, null);
              setContextMenu(null);
            }}
          >
            No group
          </button>
          {groups.map((g) => (
            <button
              key={g.id}
              className={`${styles.contextMenuItem} ${
                agents.find((a) => a.id === contextMenu.agentId)?.groupId === g.id
                  ? styles.contextMenuItemActive
                  : ''
              }`}
              onClick={() => {
                handleChangeAgentGroup(contextMenu.agentId, g.id);
                setContextMenu(null);
              }}
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
                  <div ref={createAvatarPickerRef} className={styles.createAvatarField}>
                    <button
                      type="button"
                      className={styles.createAvatarTrigger}
                      onClick={() => setCreateAvatarOpen((open) => !open)}
                      aria-expanded={createAvatarOpen}
                      aria-label="Customize avatar"
                    >
                      <AgentAvatar
                        icon={form.avatar.icon}
                        bgColor={form.avatar.bgColor}
                        logoColor={form.avatar.logoColor}
                        size={40}
                      />
                      <div className={styles.createAvatarTriggerText}>
                        <span className={styles.createAvatarTriggerTitle}>Customize avatar</span>
                        <span className={styles.createAvatarTriggerHint}>
                          Click to choose shape and colors
                        </span>
                      </div>
                      <ChevronDown
                        size={16}
                        className={`${styles.createAvatarChevron} ${
                          createAvatarOpen ? styles.createAvatarChevronOpen : ''
                        }`}
                      />
                    </button>
                    {createAvatarOpen && (
                      <div className={styles.createAvatarPickerPanel}>
                        <AgentAvatarPicker
                          value={form.avatar}
                          onChange={(avatar) => setForm((f) => ({ ...f, avatar }))}
                          savedPresets={avatarPresets}
                          onCreatePreset={handleCreateAvatarPreset}
                          onRenamePreset={handleRenameAvatarPreset}
                          onDeletePreset={handleDeleteAvatarPreset}
                          savedColorPresets={colorPresets}
                          onCreateColorPreset={handleCreateColorPreset}
                          onDeleteColorPreset={handleDeleteColorPreset}
                        />
                      </div>
                    )}
                  </div>
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
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
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
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          onClick={() =>
                            setForm((f) => ({
                              ...f,
                              preset: preset.id,
                              presetParameters: filterPresetParameterValues(
                                preset,
                                f.presetParameters,
                              ),
                            }))
                          }
                        >
                          <div className={styles.presetName}>{preset.name}</div>
                          <div className={styles.presetDescription}>{preset.description}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {(selectedPreset?.parameters?.length ?? 0) > 0 && (
                  <div>
                    <div className={styles.fieldLabel}>Preset Setup</div>
                    <div className={styles.modelOptionsRow}>
                      {selectedPreset?.parameters?.map((parameter) => (
                        <div key={parameter.key} className={styles.modelOptionField}>
                          {parameter.type === 'directory' ? (
                            <>
                              <div className={styles.fieldLabel}>
                                {parameter.label}
                                {!parameter.required && (
                                  <span className={styles.fieldHint}> (optional)</span>
                                )}
                              </div>
                              <div
                                className={[
                                  styles.directoryPickerField,
                                  formErrors[`presetParameters.${parameter.key}`]
                                    ? styles.directoryPickerFieldError
                                    : '',
                                ]
                                  .filter(Boolean)
                                  .join(' ')}
                              >
                                <div className={styles.directoryPickerValue}>
                                  <Folder size={14} />
                                  <span className={styles.directoryPickerValueText}>
                                    {form.presetParameters[parameter.key]?.trim() ||
                                      'Use current folder'}
                                  </span>
                                </div>
                                <div className={styles.directoryPickerActions}>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => void handlePickPresetDirectory(parameter.key)}
                                    disabled={pickingPresetDirectoryKey !== null}
                                  >
                                    <FolderOpen size={14} />
                                    {pickingPresetDirectoryKey === parameter.key
                                      ? 'Choosing...'
                                      : 'Browse'}
                                  </Button>
                                  {!!form.presetParameters[parameter.key]?.trim() && (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => updatePresetParameterValue(parameter.key, '')}
                                      disabled={pickingPresetDirectoryKey !== null}
                                    >
                                      Clear
                                    </Button>
                                  )}
                                </div>
                              </div>
                              {formErrors[`presetParameters.${parameter.key}`] && (
                                <div className={styles.directoryPickerError}>
                                  {formErrors[`presetParameters.${parameter.key}`]}
                                </div>
                              )}
                            </>
                          ) : (
                            <Input
                              label={`${parameter.label}${parameter.required ? '' : ' (optional)'}`}
                              placeholder={parameter.placeholder}
                              value={form.presetParameters[parameter.key] ?? ''}
                              onChange={(e) =>
                                updatePresetParameterValue(parameter.key, e.target.value)
                              }
                              error={formErrors[`presetParameters.${parameter.key}`]}
                              spellCheck={false}
                            />
                          )}
                          {parameter.description && (
                            <div className={styles.fieldHint}>{parameter.description}</div>
                          )}
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
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onClick={() =>
                          setForm((f) => ({
                            ...f,
                            model: model.id,
                            modelId: getAgentModelDefaultId(model.id),
                            thinkingLevel: supportsThinkingLevel(model.id) ? f.thinkingLevel : '',
                          }))
                        }
                      >
                        <div className={styles.modelName}>{model.name}</div>
                        <div className={styles.modelVendor}>{model.vendor}</div>
                        <div className={styles.modelDescription}>{model.description}</div>
                      </div>
                    ))}
                  </div>
                  {formErrors.model && (
                    <div className={styles.directoryPickerError}>{formErrors.model}</div>
                  )}
                </div>

                <div className={styles.modelOptionsRow}>
                  <div className={styles.modelOptionField}>
                    <div className={styles.fieldLabel}>
                      Model <span className={styles.fieldHint}>(optional)</span>
                    </div>
                    <select
                      className={styles.textInput}
                      value={form.modelId}
                      onChange={(e) => setForm((f) => ({ ...f, modelId: e.target.value }))}
                    >
                      <option value="">Default</option>
                      {getAgentModelOptions(form.model, form.modelId).map((mid) => (
                        <option key={mid} value={mid}>
                          {mid}
                        </option>
                      ))}
                    </select>
                    <div className={styles.fieldHint}>{getModelVariantHint(form.model)}</div>
                  </div>
                  {supportsThinkingLevel(form.model) && (
                    <div className={styles.modelOptionField}>
                      <div className={styles.fieldLabel}>
                        {form.model === 'claude' ? 'Thinking Level' : 'Reasoning Effort'}{' '}
                        <span className={styles.fieldHint}>(optional)</span>
                      </div>
                      <select
                        className={styles.textInput}
                        value={form.thinkingLevel}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            thinkingLevel: e.target.value as ThinkingLevel | '',
                          }))
                        }
                      >
                        <option value="">Default</option>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </select>
                      <div className={styles.fieldHint}>
                        {form.model === 'claude'
                          ? 'Controls reasoning effort via --effort'
                          : 'Controls reasoning effort via model_reasoning_effort'}
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
                    Uses{' '}
                    <code className={styles.settingsCode}>
                      {getSkipPermissionsFlag(form.model)}
                    </code>{' '}
                    for {selectedModel?.name || 'this model'}.
                  </div>
                </div>

                <div>
                  <div className={styles.fieldLabel}>OpenWork API Key</div>
                  <div className={styles.fieldHint}>
                    The agent uses this key to authenticate with your workspace — not a model
                    provider key.
                  </div>
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
                          {apiKeysLoading ? 'Loading keys...' : 'Select a workspace API key'}
                        </option>
                        {apiKeys.map((k) => (
                          <option key={k.id} value={k.id}>
                            {k.name} ({k.keyPrefix}...)
                          </option>
                        ))}
                      </Select>

                      {selectedKey && (
                        <div className={styles.keyPermissions}>
                          <div className={styles.keyPermissionsLabel}>
                            Permissions from this key
                          </div>
                          <div className={styles.keyPermissionsList}>
                            {selectedKey.permissions.map((perm) => (
                              <Badge key={perm} color="info">
                                {perm}
                              </Badge>
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
                          No active workspace API keys. Switch to "Create new" to make one now.
                        </div>
                      )}
                    </>
                  ) : (
                    <ApiKeyFormFields
                      permissionsOnly
                      form={{
                        name: '',
                        description: '',
                        permissions: form.newKeyPermissions,
                        hasExpiration: false,
                        expiresAt: '',
                      }}
                      onChange={(updater) => {
                        setForm((f) => {
                          const next = updater({
                            name: '',
                            description: '',
                            permissions: f.newKeyPermissions,
                            hasExpiration: false,
                            expiresAt: '',
                          });
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
                <Button type="submit" size="md" disabled={creating || cliMissing}>
                  {creating ? 'Creating...' : 'Create Agent'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Agent Settings Modal ── */}
      {settingsAgent && (
        <div
          className={styles.modalOverlay}
          onClick={() => {
            setSettingsAgent(null);
            setDeletingId(null);
            setEditingName(false);
            setEditingAvatar(false);
          }}
        >
          <div className={styles.settingsModalWide} onClick={(e) => e.stopPropagation()}>
            {/* Hero header with avatar, name, status */}
            <div className={styles.settingsHero}>
              <div ref={avatarPickerRef} className={styles.settingsAvatarWrap}>
                <button
                  type="button"
                  className={styles.settingsAvatarBtn}
                  onClick={() => setEditingAvatar((v) => !v)}
                  aria-label="Edit avatar"
                >
                  <AgentAvatar
                    icon={settingsAgent.avatarIcon || 'spark'}
                    bgColor={settingsAgent.avatarBgColor || '#1a1a2e'}
                    logoColor={settingsAgent.avatarLogoColor || '#e94560'}
                    size={56}
                  />
                  <span className={styles.settingsAvatarOverlay}>
                    <Pencil size={16} />
                  </span>
                </button>
                {editingAvatar && (
                  <div className={styles.settingsAvatarPickerDropdown}>
                    <AgentAvatarPicker
                      value={{
                        icon: settingsAgent.avatarIcon || 'spark',
                        bgColor: settingsAgent.avatarBgColor || '#1a1a2e',
                        logoColor: settingsAgent.avatarLogoColor || '#e94560',
                      }}
                      onChange={(avatar) => handleChangeAvatar(settingsAgent.id, avatar)}
                      savedPresets={avatarPresets}
                      onCreatePreset={handleCreateAvatarPreset}
                      onRenamePreset={handleRenameAvatarPreset}
                      onDeletePreset={handleDeleteAvatarPreset}
                      savedColorPresets={colorPresets}
                      onCreateColorPreset={handleCreateColorPreset}
                      onDeleteColorPreset={handleDeleteColorPreset}
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
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleRenameAgent(settingsAgent.id, editNameValue);
                      }
                      if (e.key === 'Escape') setEditingName(false);
                    }}
                    maxLength={255}
                    autoFocus
                  />
                ) : (
                  <h3
                    className={styles.settingsHeroName}
                    onClick={() => {
                      setEditNameValue(settingsAgent.name);
                      setEditingName(true);
                    }}
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
              <button
                className={styles.modalCloseBtn}
                onClick={() => {
                  setSettingsAgent(null);
                  setDeletingId(null);
                  setEditingName(false);
                }}
              >
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
                        onChange={(e) =>
                          handleChangeAgentModel(settingsAgent.id, 'model', e.target.value)
                        }
                      >
                        {MODELS.map((m) => (
                          <option
                            key={m.id}
                            value={m.id}
                            disabled={Boolean(
                              getCliInfoForModel(cliStatus, m.id) &&
                              !getCliInfoForModel(cliStatus, m.id)?.installed &&
                              settingsAgent.model !== m.id,
                            )}
                          >
                            {m.name}
                          </option>
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
                        onChange={(e) =>
                          handleChangeAgentModel(settingsAgent.id, 'modelId', e.target.value)
                        }
                      >
                        <option value="">Default</option>
                        {getAgentModelOptions(settingsAgent.model, settingsAgent.modelId).map(
                          (mid) => (
                            <option key={mid} value={mid}>
                              {mid}
                            </option>
                          ),
                        )}
                      </select>
                    </div>
                  </div>
                  {supportsThinkingLevel(settingsAgent.model) && (
                    <div className={styles.settingsGridItem}>
                      <div className={styles.settingsGridLabel}>
                        {settingsAgent.model === 'claude' ? 'Thinking Level' : 'Reasoning Effort'}
                      </div>
                      <div className={styles.settingsGridValue}>
                        <select
                          className={styles.settingsGroupSelect}
                          value={settingsAgent.thinkingLevel || ''}
                          onChange={(e) =>
                            handleChangeAgentModel(
                              settingsAgent.id,
                              'thinkingLevel',
                              e.target.value,
                            )
                          }
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
                      <code className={styles.settingsCode}>
                        {getSkipPermissionsFlag(settingsAgent.model)}
                      </code>
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
                        onChange={(e) =>
                          handleChangeAgentGroup(settingsAgent.id, e.target.value || null)
                        }
                      >
                        <option value="">No group</option>
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
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
                    <Badge key={cap} color="info">
                      {cap}
                    </Badge>
                  ))}
                  {settingsAgent.capabilities.length === 0 && (
                    <span className={styles.settingsEmpty}>No capabilities assigned</span>
                  )}
                </div>
              </div>

              <div className={styles.settingsSection}>
                <div
                  className={[
                    styles.envVarSectionHeader,
                    isEnvVarEmptyState ? styles.envVarSectionHeaderEmpty : '',
                  ].join(' ')}
                >
                  <div className={styles.envVarSectionIntro}>
                    <div className={styles.settingsSectionTitle}>Environment Variables</div>
                    <span
                      className={[
                        styles.envVarSectionBadge,
                        isEnvVarEmptyState ? styles.envVarSectionBadgeMuted : '',
                      ].join(' ')}
                    >
                      {visibleAgentEnvVars.length > 0
                        ? `${visibleAgentEnvVars.length} configured`
                        : agentEnvVarFormOpen
                          ? 'New variable'
                          : 'Empty'}
                    </span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={handleOpenAgentEnvVarCreate}
                    disabled={agentEnvVarFormOpen && !agentEnvVarForm.id}
                  >
                    <Plus size={13} />
                    Add
                  </Button>
                </div>

                {agentEnvVarFormOpen && (
                  <div className={styles.envVarComposer}>
                    <div className={styles.envVarComposerGrid}>
                      <div>
                        <div className={styles.fieldLabel}>Name</div>
                        <Input
                          value={agentEnvVarForm.key}
                          onChange={(e) => {
                            setAgentEnvVarForm((current) => ({
                              ...current,
                              key: e.target.value.toUpperCase(),
                            }));
                            setAgentEnvVarFormErrors((current) => {
                              const next = { ...current };
                              delete next.key;
                              return next;
                            });
                          }}
                          placeholder="API_KEY"
                          disabled={Boolean(agentEnvVarForm.id)}
                        />
                        {agentEnvVarFormErrors.key && (
                          <div className={styles.envVarFieldError}>{agentEnvVarFormErrors.key}</div>
                        )}
                      </div>

                      <div>
                        <div className={styles.fieldLabel}>
                          {agentEnvVarForm.id ? 'New value' : 'Value'}
                        </div>
                        <Input
                          type="password"
                          value={agentEnvVarForm.value}
                          onChange={(e) => {
                            setAgentEnvVarForm((current) => ({
                              ...current,
                              value: e.target.value,
                            }));
                            setAgentEnvVarFormErrors((current) => {
                              const next = { ...current };
                              delete next.value;
                              return next;
                            });
                          }}
                          placeholder={
                            agentEnvVarForm.id ? 'Leave empty to keep current' : 'Secret value'
                          }
                        />
                        {agentEnvVarFormErrors.value && (
                          <div className={styles.envVarFieldError}>
                            {agentEnvVarFormErrors.value}
                          </div>
                        )}
                      </div>
                    </div>

                    <div>
                      <div className={styles.fieldLabel}>Description</div>
                      <Input
                        value={agentEnvVarForm.description}
                        onChange={(e) =>
                          setAgentEnvVarForm((current) => ({
                            ...current,
                            description: e.target.value,
                          }))
                        }
                        placeholder="Helps the agent know when to use this variable"
                      />
                    </div>

                    <div className={styles.envVarComposerActions}>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={handleCloseAgentEnvVarForm}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={handleSubmitAgentEnvVar}
                        disabled={agentEnvVarSaving}
                      >
                        {agentEnvVarSaving
                          ? 'Saving...'
                          : agentEnvVarForm.id
                            ? 'Save changes'
                            : 'Add variable'}
                      </Button>
                    </div>
                  </div>
                )}

                {agentEnvVarsLoading ? (
                  <div className={styles.settingsEmpty}>Loading...</div>
                ) : visibleAgentEnvVars.length > 0 ? (
                  <div className={styles.envVarList}>
                    {visibleAgentEnvVars.map((envVar) => (
                      <div
                        key={envVar.id}
                        className={[
                          styles.envVarRow,
                          !envVar.isActive ? styles.envVarRowInactive : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        <div className={styles.envVarRowInfo}>
                          <div className={styles.envVarRowHeader}>
                            <code className={styles.envVarKey}>{envVar.key}</code>
                            <code className={styles.envVarPreview}>{envVar.valuePreview}</code>
                          </div>
                          {envVar.description && (
                            <div className={styles.envVarDesc}>{envVar.description}</div>
                          )}
                          {envVar.lastUsedAt && (
                            <div className={styles.envVarMeta}>
                              <Clock size={10} />
                              Used {envVarTimeAgo(envVar.lastUsedAt)}
                            </div>
                          )}
                        </div>

                        <div className={styles.envVarRowControls}>
                          <Tooltip label={envVar.isActive ? 'Disable' : 'Enable'}>
                            <label className={styles.toggleSwitch}>
                              <input
                                type="checkbox"
                                checked={envVar.isActive}
                                aria-label={
                                  envVar.isActive ? 'Disable variable' : 'Enable variable'
                                }
                                onChange={() => handleToggleAgentEnvVar(envVar)}
                              />
                              <span className={styles.toggleTrack} />
                              <span className={styles.toggleKnob} />
                            </label>
                          </Tooltip>

                          <div className={styles.envVarActions}>
                            <Tooltip label="Edit">
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label="Edit variable"
                                onClick={() => handleEditAgentEnvVar(envVar)}
                              >
                                <Pencil size={13} />
                              </Button>
                            </Tooltip>
                            <Tooltip label="Delete">
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label="Delete variable"
                                className={styles.envVarDeleteAction}
                                onClick={() => handleDeleteAgentEnvVar(envVar)}
                              >
                                <Trash2 size={13} />
                              </Button>
                            </Tooltip>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
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
                          {job.enabled ? (
                            <ToggleRight size={20} className={styles.cronToggleOn} />
                          ) : (
                            <ToggleLeft size={20} className={styles.cronToggleOff} />
                          )}
                        </button>
                        <div className={styles.cronJobInfo}>
                          <div className={styles.cronJobExpr}>
                            <code className={styles.settingsCode}>{job.cron}</code>
                            <span className={styles.cronJobDesc}>{describeCron(job.cron)}</span>
                          </div>
                          <div className={styles.cronJobNextRun}>{describeCronNextRun(job)}</div>
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
                        onClick={() => {
                          setCronFormOpen(false);
                          setCronFormCron('');
                          setCronFormPrompt('');
                        }}
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
                    onClick={() => {
                      setCronFormOpen(true);
                      setCronFormCron('* * * * *');
                    }}
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

                <Button size="sm" variant="secondary" onClick={() => handleToggle(settingsAgent)}>
                  {settingsAgent.status === 'active' ? <PowerOff size={13} /> : <Power size={13} />}
                  {settingsAgent.status === 'active' ? 'Disable agent' : 'Enable agent'}
                </Button>

                <div className={styles.settingsActionsSpacer} />

                {deletingId === settingsAgent.id ? (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => setDeletingId(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => handleDelete(settingsAgent.id)}
                    >
                      Confirm Delete
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setDeletingId(settingsAgent.id)}
                  >
                    <Trash2 size={13} />
                    Delete
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Skills Manager Modal (page-level) ── */}
      {skillsManagerOpen &&
        (() => {
          const mgrActiveSkill = mgrSkills.find((s) => s.id === mgrActiveSkillId);
          const mgrEditingSkill = mgrSkills.find((s) => s.id === mgrEditingId);
          const mgrShowingCreateForm = mgrCreating;
          const mgrShowingEditForm = Boolean(mgrEditingSkill);
          const mgrHasDirtyForm = mgrIsFormDirty();

          return (
            <div className={styles.skillsMgrOverlay} onClick={() => void closeSkillsManager()}>
              <div className={styles.skillsMgrModal} onClick={(e) => e.stopPropagation()}>
                {/* Left sidebar: skill list */}
                <div className={styles.skillsMgrSidebar}>
                  <div className={styles.skillsMgrSidebarHeader}>
                    <div className={styles.skillsMgrSidebarHeaderText}>
                      <span className={styles.skillsMgrSidebarTitle}>Skills</span>
                      <p className={styles.skillsMgrSidebarSubtitle}>
                        Reusable preset skills for agents
                      </p>
                    </div>
                    <Tooltip label="New skill">
                      <button
                        className={styles.skillsMgrNewBtn}
                        onClick={() => void mgrHandleCreateRequest()}
                        aria-label="Create skill"
                      >
                        <Plus size={14} />
                      </button>
                    </Tooltip>
                  </div>

                  <div className={styles.skillsMgrList}>
                    {mgrLoading ? (
                      <div className={styles.loadingState} style={{ padding: 'var(--space-4)' }}>
                        Loading...
                      </div>
                    ) : mgrSkills.length === 0 ? (
                      <div className={styles.skillsMgrEmpty}>
                        <Blocks size={24} className={styles.skillsMgrEmptyIcon} />
                        <p className={styles.skillsMgrEmptyTitle}>No skills yet</p>
                        <p className={styles.skillsMgrEmptyDesc}>
                          Create reusable preset-library skills that agents can copy locally.
                        </p>
                      </div>
                    ) : (
                      mgrSkills.map((skill) => (
                        <div
                          key={skill.id}
                          className={`${styles.skillsMgrItem} ${mgrActiveSkillId === skill.id ? styles.skillsMgrItemActive : ''} ${mgrEditingId === skill.id ? styles.skillsMgrItemEditing : ''}`}
                          onClick={() => void mgrHandleSelectSkill(skill.id)}
                        >
                          <div className={styles.skillsMgrItemIcon}>
                            <Blocks size={14} />
                          </div>
                          <div className={styles.skillsMgrItemInfo}>
                            <div className={styles.skillsMgrItemName}>{skill.name}</div>
                            {skill.description && (
                              <div className={styles.skillsMgrItemDesc}>{skill.description}</div>
                            )}
                          </div>
                          <div
                            className={styles.skillsMgrItemActions}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Tooltip label="Edit details">
                              <button
                                className={styles.skillsMgrItemEditBtn}
                                onClick={() => void mgrHandleEditRequest(skill)}
                                aria-label={`Edit ${skill.name}`}
                              >
                                <Pencil size={13} />
                              </button>
                            </Tooltip>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Right panel: detail + files */}
                <div className={styles.skillsMgrMain}>
                  {/* ── Top bar (always visible) ── */}
                  <div className={styles.skillsMgrTopBar}>
                    {mgrShowingEditForm && mgrEditingSkill ? (
                      <form
                        className={styles.skillsMgrTopBarInner}
                        onSubmit={(e) => {
                          e.preventDefault();
                          void mgrUpdateSkill(mgrEditingSkill.id);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            void mgrAbandonFormIfConfirmed();
                          }
                        }}
                      >
                        <div className={styles.skillsMgrTopFields}>
                          <input
                            ref={mgrNameRef}
                            className={styles.skillsMgrInlineInput}
                            type="text"
                            placeholder="Skill name"
                            value={mgrFormName}
                            onChange={(e) => setMgrFormName(e.target.value)}
                            maxLength={100}
                          />
                          <input
                            className={`${styles.skillsMgrInlineInput} ${styles.skillsMgrInlineInputSub}`}
                            type="text"
                            placeholder="Description (optional)"
                            value={mgrFormDesc}
                            onChange={(e) => setMgrFormDesc(e.target.value)}
                            maxLength={500}
                          />
                        </div>
                        {mgrFormError && (
                          <div className={styles.skillsMgrInlineError}>{mgrFormError}</div>
                        )}
                        <div className={styles.skillsMgrTopActions}>
                          <button
                            type="button"
                            className={styles.skillsMgrTopBtnGhost}
                            onClick={() => void mgrAbandonFormIfConfirmed()}
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            className={styles.skillsMgrTopBtnPrimary}
                            disabled={!mgrFormName.trim() || !mgrHasDirtyForm || mgrSaving}
                          >
                            {mgrSaving ? 'Saving...' : 'Save'}
                          </button>
                        </div>
                      </form>
                    ) : mgrShowingCreateForm ? (
                      <form
                        className={styles.skillsMgrTopBarInner}
                        onSubmit={(e) => {
                          e.preventDefault();
                          void mgrCreateSkill();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            void mgrAbandonFormIfConfirmed();
                          }
                        }}
                      >
                        <div className={styles.skillsMgrTopFields}>
                          <input
                            ref={mgrNameRef}
                            className={styles.skillsMgrInlineInput}
                            type="text"
                            placeholder="Skill name"
                            value={mgrFormName}
                            onChange={(e) => setMgrFormName(e.target.value)}
                            maxLength={100}
                          />
                          <input
                            className={`${styles.skillsMgrInlineInput} ${styles.skillsMgrInlineInputSub}`}
                            type="text"
                            placeholder="Description (optional)"
                            value={mgrFormDesc}
                            onChange={(e) => setMgrFormDesc(e.target.value)}
                            maxLength={500}
                          />
                        </div>
                        {mgrFormError && (
                          <div className={styles.skillsMgrInlineError}>{mgrFormError}</div>
                        )}
                        <div className={styles.skillsMgrTopActions}>
                          <button
                            type="button"
                            className={styles.skillsMgrTopBtnGhost}
                            onClick={() => void mgrAbandonFormIfConfirmed()}
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            className={styles.skillsMgrTopBtnPrimary}
                            disabled={!mgrFormName.trim() || mgrSaving}
                          >
                            {mgrSaving ? 'Creating...' : 'Create'}
                          </button>
                        </div>
                      </form>
                    ) : mgrActiveSkill ? (
                      <div className={styles.skillsMgrTopBarInner}>
                        <div className={styles.skillsMgrTopIdentity}>
                          <div className={styles.skillsMgrTopIcon}>
                            <Blocks size={16} />
                          </div>
                          <div className={styles.skillsMgrTopMeta}>
                            <span className={styles.skillsMgrTopName}>{mgrActiveSkill.name}</span>
                            {mgrActiveSkill.description && (
                              <span className={styles.skillsMgrTopDesc}>
                                {mgrActiveSkill.description}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className={styles.skillsMgrTopActions}>
                          <Tooltip label="Edit">
                            <button
                              className={styles.skillsMgrTopBtnIcon}
                              onClick={() => void mgrHandleEditRequest(mgrActiveSkill)}
                              aria-label={`Edit ${mgrActiveSkill.name}`}
                            >
                              <Pencil size={14} />
                            </button>
                          </Tooltip>
                          <Tooltip label="Delete">
                            <button
                              className={`${styles.skillsMgrTopBtnIcon} ${styles.skillsMgrTopBtnDanger}`}
                              onClick={() => void mgrDeleteSkill(mgrActiveSkill.id)}
                              aria-label={`Delete ${mgrActiveSkill.name}`}
                            >
                              <Trash2 size={14} />
                            </button>
                          </Tooltip>
                        </div>
                      </div>
                    ) : (
                      <div className={styles.skillsMgrTopBarInner}>
                        <span className={styles.skillsMgrTopLabel}>Skills Manager</span>
                      </div>
                    )}
                    <button
                      className={styles.skillsMgrClose}
                      onClick={() => void closeSkillsManager()}
                      aria-label="Close skills manager"
                    >
                      <X size={16} />
                    </button>
                  </div>

                  {/* ── Body ── */}
                  <div className={styles.skillsMgrMainBody}>
                    {mgrActiveSkillId && mgrActiveSkill ? (
                      <div className={styles.skillsMgrFileList}>
                        <FileBrowser
                          key={mgrActiveSkill.id}
                          endpoints={mgrFileBrowserEndpoints}
                          rootLabel="Files"
                          rootIcon={Folder}
                        />
                      </div>
                    ) : (
                      <div className={styles.skillsMgrPlaceholder}>
                        <Blocks
                          size={36}
                          strokeWidth={1.2}
                          className={styles.skillsMgrPlaceholderIcon}
                        />
                        <p className={styles.skillsMgrPlaceholderText}>
                          {mgrShowingCreateForm
                            ? 'Save the skill to start adding files'
                            : 'Select a skill to manage its files'}
                        </p>
                        {!mgrShowingCreateForm && (
                          <button
                            className={styles.skillsMgrPlaceholderBtn}
                            onClick={() => void mgrHandleCreateRequest()}
                          >
                            <Plus size={14} />
                            New skill
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })()}
      {confirmDialog}
    </div>
  );
}
