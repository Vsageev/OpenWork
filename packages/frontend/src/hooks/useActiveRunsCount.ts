import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

const POLL_INTERVAL_MS = 8_000; // 8 seconds — slightly more frequent since runs are time-sensitive

/**
 * Returns the number of currently active (running) agent runs,
 * or null before the first fetch completes.
 * Polls periodically so the sidebar badge stays fresh.
 */
export function useActiveRunsCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    async function fetchCount() {
      try {
        const data = await api<{ entries: { id: string }[] }>('/agent-runs/active');
        if (mountedRef.current) setCount(data.entries.length);
      } catch {
        // silently ignore — badge is non-critical
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
  }, []);

  return count;
}
