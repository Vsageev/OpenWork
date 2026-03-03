import { useRef, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Bell, CheckCircle2, XCircle, Info, AlertTriangle, Trash2 } from 'lucide-react';
import {
  useNotificationHistory,
  useUnreadNotificationCount,
  markAllNotificationsRead,
  clearNotificationHistory,
  removeNotification,
} from '../stores/toast';
import type { ToastVariant, NotificationHistoryItem } from '../stores/toast';
import styles from './NotificationPanel.module.css';

const VARIANT_CONFIG: Record<ToastVariant, { icon: typeof CheckCircle2; label: string }> = {
  success: { icon: CheckCircle2, label: 'Success' },
  error: { icon: XCircle, label: 'Error' },
  info: { icon: Info, label: 'Info' },
  warning: { icon: AlertTriangle, label: 'Warning' },
};

type FilterOption = 'all' | ToastVariant;

const FILTER_OPTIONS: { value: FilterOption; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'error', label: 'Errors' },
  { value: 'warning', label: 'Warnings' },
  { value: 'success', label: 'Success' },
  { value: 'info', label: 'Info' },
];

function formatTimestamp(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  const date = new Date(ts);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function groupByDate(items: NotificationHistoryItem[]): { label: string; items: NotificationHistoryItem[] }[] {
  const groups: Map<string, NotificationHistoryItem[]> = new Map();
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  for (const item of items) {
    const date = new Date(item.timestamp);
    let label: string;
    if (date.toDateString() === today.toDateString()) {
      label = 'Today';
    } else if (date.toDateString() === yesterday.toDateString()) {
      label = 'Yesterday';
    } else {
      label = date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    }
    const existing = groups.get(label);
    if (existing) existing.push(item);
    else groups.set(label, [item]);
  }

  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

interface NotificationPanelProps {
  onClose: () => void;
}

export function NotificationPanel({ onClose }: NotificationPanelProps) {
  const history = useNotificationHistory();
  const unreadCount = useUnreadNotificationCount();
  const panelRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<FilterOption>('all');
  const [maxHeight, setMaxHeight] = useState(480);
  const navigate = useNavigate();

  // Compute available vertical space above the panel trigger
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const parent = panel.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    // Space above the trigger minus margin and a small viewport gap
    const available = rect.top - 8 - 8;
    setMaxHeight(Math.min(480, Math.max(200, available)));
  }, []);

  // Mark all as read when panel opens
  useEffect(() => {
    if (unreadCount > 0) {
      markAllNotificationsRead();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    // Delay to avoid the opening click from immediately closing
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const filtered = filter === 'all' ? history : history.filter((item) => item.variant === filter);
  const groups = groupByDate(filtered);

  // Count notifications per variant for filter badges
  const variantCounts: Record<string, number> = {};
  for (const item of history) {
    variantCounts[item.variant] = (variantCounts[item.variant] ?? 0) + 1;
  }

  // Only show filter tabs that have items (plus 'all')
  const visibleFilters = FILTER_OPTIONS.filter(
    (f) => f.value === 'all' || (variantCounts[f.value] ?? 0) > 0,
  );

  return (
    <div ref={panelRef} className={styles.panel} style={{ '--notification-panel-max-height': `${maxHeight}px` } as React.CSSProperties}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Bell size={16} />
          <span className={styles.headerTitle}>Notifications</span>
          {history.length > 0 && (
            <span className={styles.headerCount}>{history.length}</span>
          )}
        </div>
        <div className={styles.headerActions}>
          {history.length > 0 && (
            <button
              className={styles.clearBtn}
              onClick={clearNotificationHistory}
              title="Clear all"
            >
              <Trash2 size={14} />
            </button>
          )}
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
      </div>

      {history.length > 0 && visibleFilters.length > 2 && (
        <div className={styles.filterBar}>
          {visibleFilters.map((f) => (
            <button
              key={f.value}
              className={`${styles.filterTab}${filter === f.value ? ` ${styles.filterTabActive}` : ''}`}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
              {f.value !== 'all' && (variantCounts[f.value] ?? 0) > 0 && (
                <span className={styles.filterCount}>{variantCounts[f.value]}</span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className={styles.body}>
        {history.length === 0 ? (
          <div className={styles.emptyState}>
            <Bell size={32} strokeWidth={1.2} />
            <p className={styles.emptyTitle}>No notifications yet</p>
            <p className={styles.emptyDesc}>Notifications from your actions will appear here</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className={styles.emptyState}>
            <Bell size={32} strokeWidth={1.2} />
            <p className={styles.emptyTitle}>No {FILTER_OPTIONS.find((f) => f.value === filter)?.label.toLowerCase()} notifications</p>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label} className={styles.group}>
              <div className={styles.groupLabel}>{group.label}</div>
              {group.items.map((item) => {
                const config = VARIANT_CONFIG[item.variant];
                const Icon = config.icon;
                const handleItemClick = item.link
                  ? () => { navigate(item.link!); onClose(); }
                  : undefined;
                return (
                  <div
                    key={item.id}
                    className={`${styles.item} ${styles[`item_${item.variant}`]}${item.link ? ` ${styles.itemClickable}` : ''}`}
                    onClick={handleItemClick}
                    role={item.link ? 'button' : undefined}
                    tabIndex={item.link ? 0 : undefined}
                    onKeyDown={item.link ? (e) => { if (e.key === 'Enter' || e.key === ' ') handleItemClick?.(); } : undefined}
                  >
                    <div className={`${styles.itemIcon} ${styles[`itemIcon_${item.variant}`]}`}>
                      <Icon size={14} />
                    </div>
                    <div className={styles.itemContent}>
                      <span className={styles.itemMessage}>{item.message}</span>
                      <span className={styles.itemTime}>{formatTimestamp(item.timestamp)}</span>
                    </div>
                    <button
                      className={styles.itemDismiss}
                      onClick={(e) => { e.stopPropagation(); removeNotification(item.id); }}
                      aria-label="Dismiss notification"
                      title="Dismiss"
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
