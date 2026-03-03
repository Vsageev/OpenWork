import { useEffect, useCallback } from 'react';
import { X } from 'lucide-react';
import styles from './KeyboardShortcutsDialog.module.css';

interface ShortcutEntry {
  label: string;
  keys: (string | { then: string })[];
}

interface ShortcutGroup {
  group: string;
  shortcuts: ShortcutEntry[];
}

const isMac = navigator.platform.toUpperCase().includes('MAC');
const mod = isMac ? '\u2318' : 'Ctrl';

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    group: 'General',
    shortcuts: [
      { label: 'Open command palette', keys: [mod, 'K'] },
      { label: 'Quick create card', keys: ['C'] },
      { label: 'Toggle sidebar', keys: ['['] },
      { label: 'Show keyboard shortcuts', keys: ['?'] },
    ],
  },
  {
    group: 'Inbox',
    shortcuts: [
      { label: 'Navigate conversations up/down', keys: ['j / k'] },
      { label: 'Open selected conversation', keys: ['Enter'] },
      { label: 'Deselect conversation', keys: ['Esc'] },
      { label: 'Toggle read/unread', keys: ['U'] },
      { label: 'Archive conversation', keys: ['E'] },
      { label: 'Close/reopen conversation', keys: ['X'] },
      { label: 'Pin/unpin conversation', keys: ['P'] },
      { label: 'Focus reply', keys: ['R'] },
      { label: 'Open template picker', keys: ['/'] },
    ],
  },
  {
    group: 'Collection',
    shortcuts: [
      { label: 'Navigate cards up/down', keys: ['j / k'] },
      { label: 'Open card quick view', keys: ['Enter'] },
      { label: 'Open card full page', keys: ['o'] },
      { label: 'Toggle card completion', keys: ['x'] },
      { label: 'Rename card', keys: ['F2'] },
      { label: 'Move card to collection', keys: ['m'] },
      { label: 'Delete card', keys: ['Del'] },
      { label: 'Deselect card', keys: ['Esc'] },
    ],
  },
  {
    group: 'My Cards',
    shortcuts: [
      { label: 'Navigate cards up/down', keys: ['j / k'] },
      { label: 'Open card quick view', keys: ['Enter'] },
      { label: 'Open card full page', keys: ['o'] },
      { label: 'Toggle card completion', keys: ['x'] },
      { label: 'Toggle card selection', keys: ['Space'] },
      { label: 'Select / deselect all', keys: ['⌘ A'] },
      { label: 'Clear selection / deselect', keys: ['Esc'] },
    ],
  },
  {
    group: 'Card Quick View',
    shortcuts: [
      { label: 'Toggle card completion', keys: ['x'] },
      { label: 'Focus comment input', keys: ['m'] },
      { label: 'Navigate cards up/down', keys: ['j / k'] },
      { label: 'Close panel', keys: ['Esc'] },
    ],
  },
  {
    group: 'Card Detail',
    shortcuts: [
      { label: 'Toggle card completion', keys: ['x'] },
      { label: 'Focus comment input', keys: ['m'] },
      { label: 'Edit description', keys: ['e'] },
    ],
  },
  {
    group: 'Navigation',
    shortcuts: [
      { label: 'Go to Dashboard', keys: ['g', { then: 'd' }] },
      { label: 'Go to My Cards', keys: ['g', { then: 'y' }] },
      { label: 'Go to Collections', keys: ['g', { then: 'c' }] },
      { label: 'Go to Boards', keys: ['g', { then: 'b' }] },
      { label: 'Go to Inbox', keys: ['g', { then: 'i' }] },
      { label: 'Go to Agents', keys: ['g', { then: 'a' }] },
      { label: 'Go to Monitor', keys: ['g', { then: 'm' }] },
      { label: 'Go to Storage', keys: ['g', { then: 's' }] },
      { label: 'Go to Settings', keys: ['g', { then: ',' }] },
    ],
  },
];

interface KeyboardShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsDialog({ open, onClose }: KeyboardShortcutsDialogProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>Keyboard Shortcuts</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className={styles.body}>
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.group} className={styles.group}>
              <div className={styles.groupLabel}>{group.group}</div>
              {group.shortcuts.map((shortcut) => (
                <div key={shortcut.label} className={styles.row}>
                  <span className={styles.rowLabel}>{shortcut.label}</span>
                  <span className={styles.keys}>
                    {shortcut.keys.map((k, i) => {
                      if (typeof k === 'string') {
                        return <kbd key={i}>{k}</kbd>;
                      }
                      return (
                        <span key={i} style={{ display: 'contents' }}>
                          <span className={styles.thenLabel}>then</span>
                          <kbd>{k.then}</kbd>
                        </span>
                      );
                    })}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className={styles.footer}>
          Press <kbd style={{
            padding: '0 4px',
            fontSize: 10,
            border: '1px solid var(--color-border)',
            borderRadius: 3,
            background: 'var(--color-surface)',
          }}>?</kbd> anytime to show this dialog
        </div>
      </div>
    </div>
  );
}
