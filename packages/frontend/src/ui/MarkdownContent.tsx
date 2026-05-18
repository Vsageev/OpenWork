import type { ClassAttributes, ComponentProps, HTMLAttributes, MouseEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ImageLightbox } from './ImageLightbox';
import ReactMarkdown from 'react-markdown';
import type { ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { api, ApiError } from '../lib/api';
import { showToast } from '../stores/toast';
import styles from './MarkdownContent.module.css';

interface MarkdownContentProps {
  children: string;
  /** Use compact sizing for comments and tight spaces */
  compact?: boolean;
  className?: string;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  return (
    <button className={styles.copyButton} onClick={handleCopy} title="Copy to clipboard" type="button">
      {copied ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.5 4.5L6 12L2.5 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2"/><path d="M10.5 5.5V3a1.5 1.5 0 00-1.5-1.5H3A1.5 1.5 0 001.5 3v6A1.5 1.5 0 003 10.5h2.5" stroke="currentColor" strokeWidth="1.2"/></svg>
      )}
    </button>
  );
}

function CodeBlock({ className, children, node, ...props }: ClassAttributes<HTMLElement> & HTMLAttributes<HTMLElement> & ExtraProps) {
  const match = /language-(\w+)/.exec(className || '');
  const code = String(children).replace(/\n$/, '');
  // Inline code — no wrapper needed
  const isInline = node?.position?.start.line === node?.position?.end.line && !match;
  if (isInline) {
    return <code className={className} {...props}>{children}</code>;
  }
  // Block code (fenced) — with or without language
  if (match) {
    return (
      <div className={styles.codeBlockWrapper}>
        <CopyButton text={code} />
        <SyntaxHighlighter style={oneDark} language={match[1]} PreTag="div">
          {code}
        </SyntaxHighlighter>
      </div>
    );
  }
  return (
    <div className={styles.codeBlockWrapper}>
      <CopyButton text={code} />
      <code className={className} {...props}>{children}</code>
    </div>
  );
}


function getInternalStoragePath(src: string | undefined): string | null {
  if (!src) return null;

  try {
    const url = new URL(src, window.location.origin);
    if (url.pathname !== '/api/storage/download') return null;
    return url.searchParams.get('path');
  } catch {
    return null;
  }
}

function MarkdownImage(props: ComponentProps<'img'>) {
  const { src, alt = '', ...rest } = props;
  const storagePath = getInternalStoragePath(src);
  const [loadedStorageImage, setLoadedStorageImage] = useState<{
    storagePath: string;
    src: string;
  } | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => {
    if (!storagePath) {
      return;
    }

    let revokeUrl: string | null = null;
    let cancelled = false;
    const token = localStorage.getItem('ws_access_token');

    fetch(`/api/storage/download?path=${encodeURIComponent(storagePath)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load image');
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        revokeUrl = URL.createObjectURL(blob);
        setLoadedStorageImage({ storagePath, src: revokeUrl });
      })
      .catch(() => {
        if (!cancelled) setLoadedStorageImage({ storagePath, src: src ?? '' });
      });

    return () => {
      cancelled = true;
      if (revokeUrl) URL.revokeObjectURL(revokeUrl);
    };
  }, [src, storagePath]);

  const resolvedSrc =
    storagePath
      ? loadedStorageImage?.storagePath === storagePath
        ? loadedStorageImage.src
        : ''
      : src ?? '';

  if (!resolvedSrc) {
    return <div className={styles.imagePlaceholder}>Loading image...</div>;
  }

  return (
    <>
      <img src={resolvedSrc} alt={alt} style={{ cursor: 'zoom-in' }} onClick={() => setLightboxOpen(true)} {...rest} />
      {lightboxOpen && <ImageLightbox src={resolvedSrc} alt={alt} onClose={() => setLightboxOpen(false)} />}
    </>
  );
}

interface FileLinkInfo {
  filePath: string;
  line?: number;
  column?: number;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseFileLink(url: string | undefined): FileLinkInfo | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.origin);
    const pathname = decodeURI(parsed.pathname);
    if (!pathname.match(/^\/(?:Users|home|tmp|var|opt|etc)\//)) return null;

    const pathMatch = pathname.match(/^(.+?)(?::(\d+))?(?::(\d+))?$/);
    if (!pathMatch) return null;

    const hashMatch = parsed.hash.match(/^#L(\d+)(?:C(\d+))?$/i);
    return {
      filePath: pathMatch[1],
      line: parsePositiveInt(pathMatch[2]) ?? parsePositiveInt(hashMatch?.[1]),
      column: parsePositiveInt(pathMatch[3]) ?? parsePositiveInt(hashMatch?.[2]),
    };
  } catch {
    return null;
  }
}

function getRevealLabel() {
  if (typeof navigator === 'undefined') return 'Reveal in file manager';
  const platform = navigator.platform.toLowerCase();
  if (platform.includes('mac')) return 'Reveal in Finder';
  if (platform.includes('win')) return 'Reveal in Explorer';
  return 'Reveal in file manager';
}

/**
 * Detects links that point to local file paths (e.g. /Users/vlad/file.ts:61)
 * and offers local actions instead of navigating in the browser.
 */
function FileLink(props: ComponentProps<'a'>) {
  const { href, children, ...rest } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);

  const fileInfo = parseFileLink(href);
  const revealLabel = getRevealLabel();

  useEffect(() => {
    if (!menuOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  function openInEditor(editor: 'cursor' | 'vscode') {
    if (!fileInfo) return;
    const position = fileInfo.line ? `:${fileInfo.line}${fileInfo.column ? `:${fileInfo.column}` : ''}` : '';
    window.location.href = `${editor}://file${fileInfo.filePath}${position}`;
    setMenuOpen(false);
  }

  async function revealInFileManager() {
    if (!fileInfo) return;
    try {
      await api('/storage/reveal-local', {
        method: 'POST',
        body: JSON.stringify({ path: fileInfo.filePath }),
      });
      setMenuOpen(false);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Failed to reveal file', 'error');
    }
  }

  async function copyPath() {
    if (!fileInfo) return;
    try {
      await navigator.clipboard.writeText(fileInfo.filePath);
      showToast('Path copied', 'success');
      setMenuOpen(false);
    } catch {
      showToast('Failed to copy path', 'error');
    }
  }

  function handleClick(e: MouseEvent<HTMLAnchorElement>) {
    if (!fileInfo) return;
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen((open) => !open);
  }

  if (!fileInfo) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  }

  return (
    <span className={styles.fileLinkWrapper} ref={menuRef}>
      <a href={href} onClick={handleClick} {...rest}>
        {children}
      </a>
      {menuOpen && (
        <span className={styles.fileLinkMenu} role="menu">
          <button type="button" role="menuitem" onClick={() => openInEditor('cursor')}>
            Open in Cursor
          </button>
          <button type="button" role="menuitem" onClick={() => openInEditor('vscode')}>
            Open in VS Code
          </button>
          <button type="button" role="menuitem" onClick={() => void revealInFileManager()}>
            {revealLabel}
          </button>
          <button type="button" role="menuitem" onClick={() => void copyPath()}>
            Copy path
          </button>
        </span>
      )}
    </span>
  );
}

export function MarkdownContent({ children, compact, className }: MarkdownContentProps) {
  const cls = [styles.markdown, compact && styles.compact, className].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock, img: MarkdownImage, a: FileLink }}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
