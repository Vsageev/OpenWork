import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import { Button, MarkdownContent, Tooltip } from '../ui';
import { isMarkdownFile, isImagePreviewable } from '../lib/file-utils';
import styles from './FilePreviewModal.module.css';

const HTML_EXTS = new Set(['.html', '.htm']);

interface FilePreviewModalProps {
  fileName: string;
  downloadUrl: string;
  onClose: () => void;
  onDownload: () => void;
  onLoadTextContent?: () => Promise<string>;
  onSaveTextContent?: (content: string) => Promise<void>;
}

export function FilePreviewModal({
  fileName,
  downloadUrl,
  onClose,
  onDownload,
  onLoadTextContent,
  onSaveTextContent,
}: FilePreviewModalProps) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [draftContent, setDraftContent] = useState('');
  const [saving, setSaving] = useState(false);
  const overlayPressStartedRef = useRef(false);

  const isMarkdown = isMarkdownFile(fileName);
  const fileExt = useMemo(() => {
    const dot = fileName.lastIndexOf('.');
    return dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
  }, [fileName]);
  const isHtml = HTML_EXTS.has(fileExt);
  const canEditMarkdown = isMarkdown && textContent !== null && Boolean(onSaveTextContent);
  const hasUnsavedChanges = isEditing && draftContent !== textContent;

  function getAuthHeaders(): Record<string, string> {
    const token = localStorage.getItem('ws_access_token');
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  }

  async function loadTextContent() {
    if (onLoadTextContent) return onLoadTextContent();

    const res = await fetch(downloadUrl, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw new Error('Failed to fetch');
    return res.text();
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setTextContent(null);
    setBlobUrl(null);
    setIsEditing(false);
    setDraftContent('');

    (async () => {
      try {
        if (isImagePreviewable(fileName)) {
          const res = await fetch(downloadUrl, {
            headers: getAuthHeaders(),
            signal: controller.signal,
          });
          if (!res.ok) throw new Error('Failed to fetch');
          const blob = await res.blob();
          setBlobUrl(URL.createObjectURL(blob));
        } else if (isHtml) {
          const text = await loadTextContent();
          setBlobUrl(URL.createObjectURL(new Blob([text], { type: 'text/html' })));
        } else {
          const text = await loadTextContent();
          setTextContent(text);
          setDraftContent(text);
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setTextContent('Failed to load file preview.');
          setDraftContent('Failed to load file preview.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [downloadUrl, fileName, isHtml, onLoadTextContent]);

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (canEditMarkdown && isEditing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!saving && draftContent !== textContent) {
          void handleSave();
        }
        return;
      }

      if (e.key === 'Escape') {
        if (canEditMarkdown && isEditing) {
          e.preventDefault();
          handleCancelEdit();
          return;
        }
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [canEditMarkdown, draftContent, isEditing, onClose, saving, textContent]);

  async function handleSave() {
    if (!onSaveTextContent || textContent === null || saving || !hasUnsavedChanges) {
      return;
    }

    setSaving(true);
    try {
      await onSaveTextContent(draftContent);
      setTextContent(draftContent);
      setIsEditing(false);
    } finally {
      setSaving(false);
    }
  }

  function handleCancelEdit() {
    setDraftContent(textContent ?? '');
    setIsEditing(false);
  }

  function handleEnableEditMode() {
    if (!canEditMarkdown || isEditing) return;
    setIsEditing(true);
  }

  function handleOverlayPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    overlayPressStartedRef.current = e.target === e.currentTarget;
  }

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget && overlayPressStartedRef.current) {
      onClose();
    }
    overlayPressStartedRef.current = false;
  }

  return (
    <div
      className={styles.previewOverlay}
      onClick={handleOverlayClick}
      onPointerDown={handleOverlayPointerDown}
    >
      <div className={styles.previewPanel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.previewHeader}>
          <span className={styles.previewTitle}>{fileName}</span>
          <div className={styles.previewActions}>
            {canEditMarkdown && (
              <div className={styles.editActions}>
                {isEditing ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={handleCancelEdit}
                      disabled={saving}
                      type="button"
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void handleSave()}
                      disabled={saving || !hasUnsavedChanges}
                      type="button"
                    >
                      {saving ? 'Saving...' : 'Save changes'}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleEnableEditMode}
                    disabled={saving}
                    type="button"
                  >
                    Edit
                  </Button>
                )}
              </div>
            )}
            <Tooltip label="Download">
              <button
                className={styles.iconBtn}
                onClick={onDownload}
                aria-label="Download"
                type="button"
              >
                <Download size={16} />
              </button>
            </Tooltip>
            <Tooltip label="Close">
              <button
                className={styles.iconBtn}
                onClick={onClose}
                aria-label="Close"
                type="button"
              >
                <X size={16} />
              </button>
            </Tooltip>
          </div>
        </div>
        <div className={styles.previewBody}>
          {loading ? (
            <div className={styles.previewLoading}>Loading preview...</div>
          ) : canEditMarkdown && isEditing ? (
            <div className={styles.editorWrap}>
              <textarea
                className={styles.editor}
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
                spellCheck={false}
                autoFocus
              />
            </div>
          ) : blobUrl && isHtml ? (
            <iframe
              src={blobUrl}
              title={fileName}
              className={styles.previewIframe}
              sandbox="allow-scripts allow-forms"
            />
          ) : blobUrl ? (
            <img
              src={blobUrl}
              alt={fileName}
              className={styles.previewImage}
            />
          ) : isMarkdown && textContent !== null ? (
            <div className={styles.previewMarkdown}>
              <MarkdownContent>{textContent}</MarkdownContent>
            </div>
          ) : (
            <pre className={styles.previewText}>{textContent}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
