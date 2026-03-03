import { useEffect, useState } from 'react';
import { X, CheckCircle2, AlertCircle, Info, AlertTriangle } from 'lucide-react';
import { useToasts, dismissToast, pauseToast, resumeToast } from '../stores/toast';
import type { ToastItem, ToastVariant } from '../stores/toast';
import styles from './Toast.module.css';

const MAX_VISIBLE = 5;

function ariaRole(variant: ToastVariant): 'alert' | 'status' {
  return variant === 'error' ? 'alert' : 'status';
}

function VariantIcon({ variant }: { variant: ToastVariant }) {
  const size = 16;
  switch (variant) {
    case 'success': return <CheckCircle2 size={size} />;
    case 'error':   return <AlertCircle size={size} />;
    case 'warning': return <AlertTriangle size={size} />;
    case 'info':    return <Info size={size} />;
  }
}

/** Returns a value from 1 (full) to 0 (expired) representing remaining time */
function useCountdownProgress(toast: ToastItem): number {
  const [progress, setProgress] = useState(1);

  useEffect(() => {
    if (toast.duration <= 0 || toast.dismissing) {
      setProgress(1);
      return;
    }

    if (toast.paused) return; // freeze progress when paused

    const tick = () => {
      const elapsed = Date.now() - toast.createdAt;
      const remaining = Math.max(0, 1 - elapsed / toast.duration);
      setProgress(remaining);
    };

    tick();
    const interval = setInterval(tick, 50);
    return () => clearInterval(interval);
  }, [toast.duration, toast.createdAt, toast.paused, toast.dismissing]);

  return progress;
}

function ToastRow({ t }: { t: ToastItem }) {
  const progress = useCountdownProgress(t);
  const showProgress = t.duration > 0 && !t.dismissing;

  return (
    <div
      role={ariaRole(t.variant)}
      className={`${styles.toast} ${styles[t.variant]}${t.dismissing ? ` ${styles.dismissing}` : ''}`}
      onMouseEnter={() => pauseToast(t.id)}
      onMouseLeave={() => resumeToast(t.id)}
    >
      <div className={styles.icon}>
        <VariantIcon variant={t.variant} />
      </div>
      <div className={styles.body}>
        <span className={styles.message}>{t.message}</span>
        {t.action && (
          <div className={styles.actions}>
            <button
              className={styles.action}
              onClick={() => {
                t.action!.onClick();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          </div>
        )}
      </div>

      <button
        className={styles.dismiss}
        onClick={() => dismissToast(t.id)}
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
      {showProgress && (
        <div className={styles.progressTrack}>
          <div
            className={styles.progressBar}
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToasts();

  if (toasts.length === 0) return null;

  const visible = toasts.slice(0, MAX_VISIBLE);
  const hiddenCount = Math.max(0, toasts.length - MAX_VISIBLE);

  return (
    <div className={styles.container} aria-live="polite" aria-relevant="additions removals">
      {visible.map((t) => (
        <ToastRow key={t.id} t={t} />
      ))}
      {hiddenCount > 0 && (
        <div className={styles.overflow}>
          +{hiddenCount} more notification{hiddenCount !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}
