import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../stores/useAuth';

const POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes

/**
 * Returns the number of overdue (past-due, incomplete) cards assigned to the current user,
 * or null before the first fetch completes. Null lets callers distinguish "loading" from
 * "0 overdue" to avoid false-positive notifications.
 * Polls periodically so the sidebar badge stays fresh.
 */
export function useOverdueCardsCount(): number | null {
  const { user } = useAuth();
  const [count, setCount] = useState<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    if (!user) {
      setCount(null);
      return;
    }

    mountedRef.current = true;

    async function fetchCount() {
      try {
        const now = new Date().toISOString();
        const data = await api<{ total: number }>(
          `/cards?assigneeId=${user!.id}&completed=false&dueDateBefore=${encodeURIComponent(now)}&countOnly=true`,
        );
        if (!mountedRef.current) return;
        setCount(data.total);
      } catch {
        // silently ignore – badge is non-critical
      }
    }

    void fetchCount();
    const id = window.setInterval(() => {
      if (!document.hidden) void fetchCount();
    }, POLL_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      window.clearInterval(id);
    };
  }, [user]);

  return count;
}
