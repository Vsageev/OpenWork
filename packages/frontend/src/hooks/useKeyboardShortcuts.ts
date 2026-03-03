import { useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Checks whether the keyboard event target is an interactive element
 * where single-key shortcuts should be suppressed.
 */
function isEditableTarget(e: KeyboardEvent): boolean {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((e.target as HTMLElement).isContentEditable) return true;
  return false;
}

interface UseKeyboardShortcutsOptions {
  onOpenPalette: () => void;
  onOpenShortcuts: () => void;
  onQuickCreateCard?: () => void;
  onToggleSidebar?: () => void;
}

/**
 * Global keyboard shortcuts handler.
 *
 * Supports single-key shortcuts and two-key sequences (e.g. g then d).
 * Single-key shortcuts are suppressed when focus is in an editable field.
 */
export function useKeyboardShortcuts({ onOpenPalette, onOpenShortcuts, onQuickCreateCard, onToggleSidebar }: UseKeyboardShortcutsOptions) {
  const navigate = useNavigate();
  const pendingPrefix = useRef<string | null>(null);
  const prefixTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const clearPrefix = useCallback(() => {
    pendingPrefix.current = null;
    if (prefixTimer.current) {
      clearTimeout(prefixTimer.current);
      prefixTimer.current = undefined;
    }
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Let Cmd/Ctrl+K through regardless (handled separately in AppLayout)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') return;

      // Ignore events with modifier keys for single-key shortcuts
      if (e.metaKey || e.ctrlKey || e.altKey) {
        clearPrefix();
        return;
      }

      // Don't handle shortcuts in editable fields
      if (isEditableTarget(e)) {
        clearPrefix();
        return;
      }

      const key = e.key.toLowerCase();

      // Two-key sequence: check if we have a pending prefix
      if (pendingPrefix.current === 'g') {
        clearPrefix();
        const routes: Record<string, string> = {
          d: '/',
          y: '/my-cards',
          c: '/collections',
          b: '/boards',
          i: '/inbox',
          a: '/agents',
          m: '/monitor',
          s: '/storage',
          ',': '/settings',
        };
        const route = routes[key];
        if (route) {
          e.preventDefault();
          navigate(route);
        }
        return;
      }

      // Start a prefix sequence
      if (key === 'g') {
        e.preventDefault();
        pendingPrefix.current = 'g';
        prefixTimer.current = setTimeout(clearPrefix, 800);
        return;
      }

      // Single-key shortcuts
      if (key === '?') {
        e.preventDefault();
        onOpenShortcuts();
        return;
      }

      if (key === '/') {
        e.preventDefault();
        onOpenPalette();
        return;
      }

      if (key === 'c' && onQuickCreateCard) {
        e.preventDefault();
        onQuickCreateCard();
        return;
      }

      if (key === '[' && onToggleSidebar) {
        e.preventDefault();
        onToggleSidebar();
        return;
      }

      clearPrefix();
    };

    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      clearPrefix();
    };
  }, [navigate, onOpenPalette, onOpenShortcuts, onQuickCreateCard, onToggleSidebar, clearPrefix]);
}
