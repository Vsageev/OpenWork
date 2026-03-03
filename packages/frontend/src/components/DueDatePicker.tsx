import { useState, useRef, useEffect } from 'react';
import { CalendarDays, X, ChevronDown, AlertCircle } from 'lucide-react';
import styles from './DueDatePicker.module.css';

function toDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getQuickDates() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const nextWeek = new Date(today);
  nextWeek.setDate(nextWeek.getDate() + 7);

  return [
    { label: 'Today', value: toDateString(today) },
    { label: 'Tomorrow', value: toDateString(tomorrow) },
    { label: '+7 days', value: toDateString(nextWeek) },
  ];
}

type DueDateStatus = 'overdue' | 'soon' | 'normal' | 'none';

function getStatus(dateStr: string | null): DueDateStatus {
  if (!dateStr) return 'none';
  const due = new Date(dateStr);
  const now = new Date();
  const diffMs = due.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / 86400000);
  if (diffDays < 0) return 'overdue';
  if (diffDays <= 2) return 'soon';
  return 'normal';
}

function formatDueLabel(dateStr: string): string {
  const due = new Date(dateStr);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diffMs = due.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / 86400000);
  if (diffDays < 0) {
    const d = Math.abs(diffDays);
    return d === 1 ? 'Overdue 1d' : `Overdue ${d}d`;
  }
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays <= 7) return `In ${diffDays}d`;
  return due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface DueDatePickerProps {
  value: string | null;
  onChange: (value: string | null) => void;
}

export function DueDatePicker({ value, onChange }: DueDatePickerProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

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

  const status = getStatus(value);
  const quickDates = getQuickDates();

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        className={`${styles.trigger} ${styles[`trigger_${status}`]}`}
        onClick={() => setOpen((v) => !v)}
        type="button"
        title={value ? `Due: ${value}` : 'Set due date'}
      >
        {status === 'overdue' ? <AlertCircle size={10} /> : <CalendarDays size={10} />}
        {value ? formatDueLabel(value) : 'Due date'}
        <ChevronDown size={9} className={styles.chevron} />
      </button>

      {open && (
        <div className={styles.dropdown}>
          {quickDates.map((opt) => (
            <button
              key={opt.label}
              className={`${styles.option}${value === opt.value ? ` ${styles.optionActive}` : ''}`}
              onClick={() => { onChange(opt.value); setOpen(false); }}
              type="button"
            >
              {opt.label}
            </button>
          ))}
          <div className={styles.divider} />
          <div className={styles.dateInputRow}>
            <input
              type="date"
              className={styles.dateInput}
              value={value ?? ''}
              onChange={(e) => {
                if (e.target.value) {
                  onChange(e.target.value);
                  setOpen(false);
                }
              }}
            />
          </div>
          {value && (
            <>
              <div className={styles.divider} />
              <button
                className={`${styles.option} ${styles.optionClear}`}
                onClick={() => { onChange(null); setOpen(false); }}
                type="button"
              >
                <X size={11} />
                Remove date
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
