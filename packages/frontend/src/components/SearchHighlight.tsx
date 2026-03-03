import type { ReactNode } from 'react';

/**
 * Highlights the first occurrence of `query` within `text`.
 * Returns plain text when there is no match or the query is too short.
 */
export function highlightMatch(text: string, query: string): ReactNode {
  if (!query || query.length < 2) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: 'rgba(245, 158, 11, 0.2)', color: 'inherit', borderRadius: 2, padding: '0 1px' }}>
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}
