import { useSyncExternalStore } from 'react';

export type ToastVariant = 'error' | 'success' | 'info' | 'warning';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  action?: ToastAction;
  dismissing?: boolean;
  /** Total auto-dismiss duration in ms (0 = no auto-dismiss) */
  duration: number;
  /** Timestamp when the toast was created (for progress calculation) */
  createdAt: number;
  /** Whether the countdown is paused (e.g. on hover) */
  paused?: boolean;
  /** Remaining ms when paused */
  remainingMs?: number;
}

let nextId = 1;
let toasts: ToastItem[] = [];
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ToastItem[] {
  return toasts;
}

export interface ShowToastOptions {
  variant?: ToastVariant;
  duration?: number;
  action?: ToastAction;
  /** Optional route to navigate to when the notification history item is clicked */
  link?: string;
}

function scheduleAutoDismiss(id: number, delay: number) {
  const timer = setTimeout(() => dismissToast(id), delay);
  timers.set(id, timer);
}

const NOTIFICATIONS_ENABLED_KEY = 'notifications-enabled';

export function areNotificationsEnabled(): boolean {
  return localStorage.getItem(NOTIFICATIONS_ENABLED_KEY) !== 'false';
}

export function setNotificationsEnabled(enabled: boolean) {
  localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, String(enabled));
}

export function showToast(message: string, variantOrOpts: ToastVariant | ShowToastOptions = 'info', duration = 5000) {
  const id = nextId++;
  let variant: ToastVariant;
  let action: ToastAction | undefined;
  let dur: number;
  let link: string | undefined;

  if (typeof variantOrOpts === 'string') {
    variant = variantOrOpts;
    dur = duration;
  } else {
    variant = variantOrOpts.variant ?? 'info';
    dur = variantOrOpts.duration ?? duration;
    action = variantOrOpts.action;
    link = variantOrOpts.link;
  }

  // Always persist to history; only show the visual toast if notifications are enabled
  addToHistory(message, variant, link);

  if (!areNotificationsEnabled()) {
    return id;
  }

  toasts = [...toasts, { id, message, variant, action, duration: dur, createdAt: Date.now() }];
  notify();

  if (dur > 0) {
    scheduleAutoDismiss(id, dur);
  }

  return id;
}

/** Pause the auto-dismiss countdown (e.g. on hover) */
export function pauseToast(id: number) {
  const item = toasts.find((t) => t.id === id);
  if (!item || item.paused || item.dismissing || item.duration <= 0) return;

  // Clear the pending timer
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }

  // Calculate how much time is left
  const elapsed = Date.now() - item.createdAt;
  const remaining = Math.max(0, item.duration - elapsed);

  toasts = toasts.map((t) => (t.id === id ? { ...t, paused: true, remainingMs: remaining } : t));
  notify();
}

/** Resume the auto-dismiss countdown (e.g. on mouse leave) */
export function resumeToast(id: number) {
  const item = toasts.find((t) => t.id === id);
  if (!item || !item.paused || item.dismissing) return;

  const remaining = item.remainingMs ?? 0;

  // Reset createdAt so progress bar resumes correctly
  toasts = toasts.map((t) =>
    t.id === id ? { ...t, paused: false, remainingMs: undefined, createdAt: Date.now() - (item.duration - remaining), duration: item.duration } : t,
  );
  notify();

  if (remaining > 0) {
    scheduleAutoDismiss(id, remaining);
  } else {
    dismissToast(id);
  }
}

const DISMISS_ANIMATION_MS = 200;

export function dismissToast(id: number) {
  // If already dismissing or not found, skip
  const existing = toasts.find((t) => t.id === id);
  if (!existing || existing.dismissing) return;

  // Clear any pending timer
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }

  // Mark as dismissing to trigger exit animation
  toasts = toasts.map((t) => (t.id === id ? { ...t, dismissing: true } : t));
  notify();

  // Remove after animation completes
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
  }, DISMISS_ANIMATION_MS);
}

export const toast = {
  error: (message: string) => showToast(message, 'error', 10000),
  success: (message: string, opts?: { action?: ToastAction; link?: string }) =>
    showToast(message, { variant: 'success', action: opts?.action, link: opts?.link }),
  info: (message: string, opts?: { action?: ToastAction; link?: string }) =>
    showToast(message, { variant: 'info', action: opts?.action, link: opts?.link }),
  warning: (message: string, opts?: { action?: ToastAction; duration?: number; link?: string }) =>
    showToast(message, { variant: 'warning', duration: opts?.duration ?? 8000, action: opts?.action, link: opts?.link }),
};

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/* ── Notification History ── */

const HISTORY_STORAGE_KEY = 'notification-history';
const HISTORY_UNREAD_KEY = 'notification-history-unread';
const MAX_HISTORY = 50;

export interface NotificationHistoryItem {
  id: number;
  message: string;
  variant: ToastVariant;
  timestamp: number;
  link?: string;
}

let history: NotificationHistoryItem[] = loadHistory();
let unreadCount: number = loadUnreadCount();
const historyListeners = new Set<() => void>();

function notifyHistory() {
  for (const listener of historyListeners) listener();
}

function subscribeHistory(listener: () => void) {
  historyListeners.add(listener);
  return () => historyListeners.delete(listener);
}

function getHistorySnapshot(): NotificationHistoryItem[] {
  return history;
}

function getUnreadCountSnapshot(): number {
  return unreadCount;
}

function loadHistory(): NotificationHistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function loadUnreadCount(): number {
  try {
    const raw = localStorage.getItem(HISTORY_UNREAD_KEY);
    return raw ? parseInt(raw, 10) : 0;
  } catch {
    return 0;
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
    localStorage.setItem(HISTORY_UNREAD_KEY, String(unreadCount));
  } catch {
    // localStorage full — silently ignore
  }
}

function addToHistory(message: string, variant: ToastVariant, link?: string) {
  const item: NotificationHistoryItem = {
    id: Date.now(),
    message,
    variant,
    timestamp: Date.now(),
    ...(link ? { link } : {}),
  };
  history = [item, ...history].slice(0, MAX_HISTORY);
  unreadCount++;
  saveHistory();
  notifyHistory();
}

export function markAllNotificationsRead() {
  unreadCount = 0;
  saveHistory();
  notifyHistory();
}

export function removeNotification(id: number) {
  history = history.filter((item) => item.id !== id);
  saveHistory();
  notifyHistory();
}

export function clearNotificationHistory() {
  history = [];
  unreadCount = 0;
  saveHistory();
  notifyHistory();
}

export function useNotificationHistory(): NotificationHistoryItem[] {
  return useSyncExternalStore(subscribeHistory, getHistorySnapshot);
}

export function useUnreadNotificationCount(): number {
  return useSyncExternalStore(subscribeHistory, getUnreadCountSnapshot);
}
