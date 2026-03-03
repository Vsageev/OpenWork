import { useEffect, useState } from 'react';
import { formatTimeAgo } from 'shared';
import { Tooltip } from '../ui';

interface TimeAgoProps {
  date: string;
  /** Tooltip position (default: top) */
  position?: 'top' | 'bottom' | 'left' | 'right';
  /** CSS class for the wrapping span */
  className?: string;
}

function formatExact(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Renders a relative timestamp ("2h ago") that auto-updates every 60 seconds
 * and shows the exact date/time in a tooltip on hover.
 */
export function TimeAgo({ date, position = 'top', className }: TimeAgoProps) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Tooltip label={formatExact(date)} position={position}>
      <span className={className}>{formatTimeAgo(date)}</span>
    </Tooltip>
  );
}
