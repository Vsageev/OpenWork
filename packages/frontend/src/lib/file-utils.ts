// Re-export shared utilities for frontend convenience
export { formatBytes as formatFileSize, formatDate as formatFileDate } from 'shared';

// Frontend-specific file utilities

/**
 * Strip common Markdown syntax for plain-text previews.
 * Removes bold, italic, headers, code, links, images, blockquotes, and lists
 * so board card descriptions render as clean text rather than raw symbols.
 */
export function stripMarkdown(text: string): string {
  return text
    // Images: ![alt](url)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Links: [text](url)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Headers: # ## ###
    .replace(/^#{1,6}\s+/gm, '')
    // Bold + italic: ***text*** or ___text___
    .replace(/\*{3}(.+?)\*{3}/g, '$1')
    .replace(/_{3}(.+?)_{3}/g, '$1')
    // Bold: **text** or __text__
    .replace(/\*{2}(.+?)\*{2}/g, '$1')
    .replace(/_{2}(.+?)_{2}/g, '$1')
    // Italic: *text* or _text_
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    // Inline code: `code`
    .replace(/`([^`]+)`/g, '$1')
    // Fenced code blocks
    .replace(/```[\s\S]*?```/g, '')
    // Blockquotes
    .replace(/^>\s+/gm, '')
    // Unordered list markers
    .replace(/^[-*+]\s+/gm, '')
    // Ordered list markers
    .replace(/^\d+\.\s+/gm, '')
    // Horizontal rules
    .replace(/^[-*_]{3,}$/gm, '')
    // Collapse multiple spaces
    .replace(/  +/g, ' ')
    .trim();
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'folder';
  size: number;
  createdAt: string;
}

export function getFileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

export const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.xml', '.yaml', '.yml',
  '.log', '.ini', '.cfg', '.conf', '.env', '.sh', '.bash',
  '.js', '.ts', '.jsx', '.tsx', '.css', '.html', '.htm', '.svg',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.cpp', '.h',
  '.sql', '.graphql', '.toml', '.hbs',
]);

export const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
]);

export function isTextPreviewable(name: string): boolean {
  return TEXT_EXTS.has(getFileExt(name));
}

export function isImagePreviewable(name: string): boolean {
  return IMAGE_EXTS.has(getFileExt(name));
}

export function isPreviewable(name: string): boolean {
  return isTextPreviewable(name) || isImagePreviewable(name);
}
