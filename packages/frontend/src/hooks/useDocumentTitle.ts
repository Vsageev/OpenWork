import { useEffect } from 'react';

const BASE_TITLE = 'OpenWork';

/** Extract the leading unread badge (e.g. "(3) ") from the current title, if present. */
function getExistingBadge(): string {
  return document.title.match(/^(\(\d+\)\s*)/)?.[1] ?? '';
}

/**
 * Sets the browser tab title for the current page.
 * Preserves any unread count badge that was prepended by useUnreadBadgeTitle.
 * Resets to the base title on unmount.
 */
export function useDocumentTitle(title?: string) {
  useEffect(() => {
    const badge = getExistingBadge();
    document.title = title ? `${badge}${title} · ${BASE_TITLE}` : `${badge}${BASE_TITLE}`;
    return () => {
      const badge = getExistingBadge();
      document.title = `${badge}${BASE_TITLE}`;
    };
  }, [title]);
}

/**
 * Prepends unread count badge to the document title.
 * Call this once at the app layout level.
 */
export function useUnreadBadgeTitle(unreadCount: number) {
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\)\s*/, '');
    document.title = unreadCount > 0 ? `(${unreadCount}) ${base}` : base;
  }, [unreadCount]);
}
