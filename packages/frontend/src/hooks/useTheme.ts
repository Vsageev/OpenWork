import { useSyncExternalStore, useCallback } from 'react';

type Theme = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'theme';

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getStoredTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system';
}

function resolve(theme: Theme): ResolvedTheme {
  return theme === 'system' ? getSystemTheme() : theme;
}

function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.setAttribute('data-theme', resolved);
}

// ── Tiny external store ──

let currentTheme: Theme = getStoredTheme();
applyTheme(resolve(currentTheme));

const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function emit() {
  for (const cb of listeners) cb();
}

function setTheme(next: Theme) {
  currentTheme = next;
  localStorage.setItem(STORAGE_KEY, next);
  applyTheme(resolve(next));
  emit();
}

// React to OS-level theme changes when preference is "system"
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (currentTheme === 'system') {
    applyTheme(resolve(currentTheme));
    emit();
  }
});

function getSnapshot(): Theme {
  return currentTheme;
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot);

  return {
    /** The user's stored preference: light | dark | system */
    theme,
    /** The resolved actual theme applied to the page */
    resolved: resolve(theme) as ResolvedTheme,
    setTheme: useCallback((t: Theme) => setTheme(t), []),
  };
}
