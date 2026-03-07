import type { ClassAttributes, ComponentProps, HTMLAttributes, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import styles from './MarkdownContent.module.css';

interface MarkdownContentProps {
  children: string;
  /** Use compact sizing for comments and tight spaces */
  compact?: boolean;
  className?: string;
}

function CodeBlock({ className, children, ...props }: ClassAttributes<HTMLElement> & HTMLAttributes<HTMLElement> & ExtraProps) {
  const match = /language-(\w+)/.exec(className || '');
  const code = String(children).replace(/\n$/, '');
  if (match) {
    return (
      <SyntaxHighlighter style={oneDark} language={match[1]} PreTag="div">
        {code}
      </SyntaxHighlighter>
    );
  }
  return <code className={className} {...props}>{children}</code>;
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
  const [resolvedSrc, setResolvedSrc] = useState(src ?? '');

  useEffect(() => {
    if (!storagePath) {
      setResolvedSrc(src ?? '');
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
        setResolvedSrc(revokeUrl);
      })
      .catch(() => {
        if (!cancelled) setResolvedSrc(src ?? '');
      });

    return () => {
      cancelled = true;
      if (revokeUrl) URL.revokeObjectURL(revokeUrl);
    };
  }, [src, storagePath]);

  if (!resolvedSrc) {
    return <div className={styles.imagePlaceholder}>Loading image...</div>;
  }

  return <img src={resolvedSrc} alt={alt} {...rest} />;
}

export function MarkdownContent({ children, compact, className }: MarkdownContentProps) {
  const cls = [styles.markdown, compact && styles.compact, className].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock, img: MarkdownImage }}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
