import { useState, useRef, useEffect } from 'react';
import { Flag, ChevronDown, Check } from 'lucide-react';
import styles from './PriorityBadge.module.css';

export type Priority = 'high' | 'medium' | 'low';

const PRIORITIES: { value: Priority; label: string; color: string }[] = [
  { value: 'high', label: 'High', color: '#EF4444' },
  { value: 'medium', label: 'Medium', color: '#F59E0B' },
  { value: 'low', label: 'Low', color: '#60A5FA' },
];

interface PriorityBadgeProps {
  priority: Priority | null;
  /** If true, renders a button that opens a dropdown to change priority */
  editable?: boolean;
  onChange?: (priority: Priority | null) => void;
  size?: 'sm' | 'md';
}

/** Read-only badge or editable picker for card priority */
export function PriorityBadge({ priority, editable = false, onChange, size = 'md' }: PriorityBadgeProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const config = priority ? PRIORITIES.find((p) => p.value === priority) ?? null : null;

  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  // Read-only mode
  if (!editable) {
    if (!config) return null;
    return (
      <span
        className={`${styles.badge} ${size === 'sm' ? styles.badgeSm : styles.badgeMd}`}
        style={{ '--priority-color': config.color } as React.CSSProperties}
      >
        <span className={styles.dot} />
        {config.label}
      </span>
    );
  }

  // Editable mode
  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        className={`${styles.trigger} ${size === 'sm' ? styles.triggerSm : styles.triggerMd}${!config ? ` ${styles.triggerEmpty}` : ''}`}
        style={config ? ({ '--priority-color': config.color } as React.CSSProperties) : undefined}
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        {config ? (
          <>
            <span className={styles.dot} />
            {config.label}
          </>
        ) : (
          <>
            <Flag size={10} className={styles.flagIcon} />
            Set priority
          </>
        )}
        <ChevronDown size={9} className={styles.chevron} />
      </button>

      {open && (
        <div className={styles.dropdown}>
          {priority && (
            <button
              className={styles.option}
              onClick={() => { onChange?.(null); setOpen(false); }}
              type="button"
            >
              <span className={styles.optionDot} style={{ background: 'var(--color-text-muted, #9CA3AF)' }} />
              None
            </button>
          )}
          {PRIORITIES.map((p) => (
            <button
              key={p.value}
              className={`${styles.option}${priority === p.value ? ` ${styles.optionActive}` : ''}`}
              onClick={() => { onChange?.(p.value); setOpen(false); }}
              type="button"
            >
              <span className={styles.optionDot} style={{ background: p.color }} />
              {p.label}
              {priority === p.value && <Check size={11} className={styles.optionCheck} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
