import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

const POLL_INTERVAL_MS = 30_000;

/**
 * Returns the number of unread conversations, or null before the first fetch completes.
 * Null lets callers distinguish "loading" from "0 unread" to avoid false-positive notifications.
 */
export function useUnreadCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    async function fetch() {
      try {
        const data = await api<{ total: number }>(
          '/conversations?isUnread=true&countOnly=true',
        );
        if (mountedRef.current) setCount(data.total);
      } catch {
        // silently ignore – badge is non-critical
      }
    }

    void fetch();
    const id = window.setInterval(() => {
      if (!document.hidden) void fetch();
    }, POLL_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      window.clearInterval(id);
    };
  }, []);

  return count;
}
