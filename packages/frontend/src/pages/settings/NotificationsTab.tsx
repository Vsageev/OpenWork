import { useState } from 'react';
import { Bell, BellOff, Trash2 } from 'lucide-react';
import { areNotificationsEnabled, setNotificationsEnabled, clearNotificationHistory } from '../../stores/toast';
import styles from './AppearanceTab.module.css';

function Toggle({ checked, onChange, id }: { checked: boolean; onChange: (val: boolean) => void; id: string }) {
  return (
    <button
      id={id}
      role="switch"
      aria-checked={checked}
      className={`${styles.toggle}${checked ? ` ${styles.toggleOn}` : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.toggleThumb} />
    </button>
  );
}

export function NotificationsTab() {
  const [enabled, setEnabled] = useState(() => areNotificationsEnabled());

  function handleToggle(val: boolean) {
    setEnabled(val);
    setNotificationsEnabled(val);
  }

  function handleClearHistory() {
    clearNotificationHistory();
  }

  return (
    <div className={styles.container}>
      <div className={styles.section}>
        <div>
          <h3 className={styles.sectionTitle}>In-app notifications</h3>
          <p className={styles.sectionDesc}>Control whether toast notifications appear on screen.</p>
        </div>
        <div className={styles.prefList}>
          <div className={styles.prefRow}>
            {enabled ? (
              <Bell size={16} className={styles.prefIcon} />
            ) : (
              <BellOff size={16} className={styles.prefIcon} />
            )}
            <label className={styles.prefLabel} htmlFor="notifications-enabled-pref">
              <span className={styles.prefLabelText}>Show notification toasts</span>
              <span className={styles.prefLabelDesc}>
                {enabled
                  ? 'Notifications appear as pop-ups in the corner of the screen'
                  : 'Notifications are silenced — check the bell icon to review them'}
              </span>
            </label>
            <Toggle id="notifications-enabled-pref" checked={enabled} onChange={handleToggle} />
          </div>
        </div>
      </div>

      <div className={styles.sectionDivider} />

      <div className={styles.section}>
        <div>
          <h3 className={styles.sectionTitle}>Notification history</h3>
          <p className={styles.sectionDesc}>Manage your stored notification history.</p>
        </div>
        <div className={styles.prefList}>
          <div className={styles.prefRow}>
            <Trash2 size={16} className={styles.prefIcon} />
            <label className={styles.prefLabel}>
              <span className={styles.prefLabelText}>Clear notification history</span>
              <span className={styles.prefLabelDesc}>Remove all notifications from the history panel</span>
            </label>
            <button
              onClick={handleClearHistory}
              style={{
                fontSize: 12,
                padding: '5px 12px',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-surface)',
                color: 'var(--color-text)',
                cursor: 'pointer',
                flexShrink: 0,
                whiteSpace: 'nowrap',
              }}
            >
              Clear all
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
