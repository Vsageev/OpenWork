import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import { MarkdownContent, Tooltip } from '../ui';
import { getFileExt, isImagePreviewable } from '../lib/file-utils';
import styles from './FilePreviewModal.module.css';

const MD_EXTS = new Set(['.md', '.markdown']);
const HTML_EXTS = new Set(['.html', '.htm']);

interface FilePreviewModalProps {
  fileName: string;
  downloadUrl: string;
  onClose: () => void;
  onDownload: () => void;
}

export function FilePreviewModal({ fileName, downloadUrl, onClose, onDownload }: FilePreviewModalProps) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const isMarkdown = MD_EXTS.has(getFileExt(fileName));
  const isHtml = HTML_EXTS.has(getFileExt(fileName));

  useEffect(() => {
    let cancelled = false;
    const token = localStorage.getItem('ws_access_token');

    (async () => {
      try {
        const res = await fetch(downloadUrl, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error('Failed to fetch');
        if (cancelled) return;

        if (isImagePreviewable(fileName)) {
          const blob = await res.blob();
          if (!cancelled) setBlobUrl(URL.createObjectURL(blob));
        } else if (isHtml) {
          const text = await res.text();
          if (!cancelled) setBlobUrl(URL.createObjectURL(new Blob([text], { type: 'text/html' })));
        } else {
          const text = await res.text();
          if (!cancelled) setTextContent(text);
        }
      } catch {
        if (!cancelled) setTextContent('Failed to load file preview.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [downloadUrl, fileName]);

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className={styles.previewOverlay} onClick={onClose}>
      <div className={styles.previewPanel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.previewHeader}>
          <span className={styles.previewTitle}>{fileName}</span>
          <div className={styles.previewActions}>
            <Tooltip label="Download">
              <button
                className={styles.iconBtn}
                onClick={onDownload}
                aria-label="Download"
              >
                <Download size={16} />
              </button>
            </Tooltip>
            <Tooltip label="Close">
              <button
                className={styles.iconBtn}
                onClick={onClose}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </Tooltip>
          </div>
        </div>
        <div className={styles.previewBody}>
          {loading ? (
            <div className={styles.previewLoading}>Loading preview...</div>
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
          ) : isMarkdown && textContent ? (
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
