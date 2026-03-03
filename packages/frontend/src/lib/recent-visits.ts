const STORAGE_KEY = 'ws_recent_visits';
const MAX_ITEMS = 8;

export interface RecentVisit {
  type: 'card' | 'board' | 'collection';
  id: string;
  name: string;
  path: string;
  visitedAt: number;
}

export function getRecentVisits(): RecentVisit[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const items: RecentVisit[] = JSON.parse(raw);
    return items.slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

export function addRecentVisit(visit: Omit<RecentVisit, 'visitedAt'>): void {
  try {
    const existing = getRecentVisits();
    const filtered = existing.filter(
      (v) => !(v.type === visit.type && v.id === visit.id),
    );
    const updated: RecentVisit[] = [
      { ...visit, visitedAt: Date.now() },
      ...filtered,
    ].slice(0, MAX_ITEMS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // best-effort
  }
}

export function removeRecentVisit(type: RecentVisit['type'], id: string): void {
  try {
    const existing = getRecentVisits();
    const updated = existing.filter((v) => !(v.type === type && v.id === id));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // best-effort
  }
}

export function clearRecentVisits(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // best-effort
  }
}
