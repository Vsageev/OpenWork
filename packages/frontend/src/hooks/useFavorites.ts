import { useCallback, useSyncExternalStore } from 'react';

export interface FavoriteItem {
  id: string;
  type: 'board' | 'collection' | 'card';
  name: string;
}

const STORAGE_KEY = 'favorites';

function getSnapshot(): FavoriteItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as FavoriteItem[]) : [];
  } catch {
    return [];
  }
}

let cachedSnapshot = getSnapshot();

function subscribe(onStoreChange: () => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      cachedSnapshot = getSnapshot();
      onStoreChange();
    }
  };
  // Listen for cross-tab changes
  window.addEventListener('storage', handler);

  // Listen for same-tab changes via custom event
  const customHandler = () => {
    cachedSnapshot = getSnapshot();
    onStoreChange();
  };
  window.addEventListener('favorites-changed', customHandler);

  return () => {
    window.removeEventListener('storage', handler);
    window.removeEventListener('favorites-changed', customHandler);
  };
}

function getSnapshotCached(): FavoriteItem[] {
  return cachedSnapshot;
}

function persist(items: FavoriteItem[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  cachedSnapshot = items;
  window.dispatchEvent(new Event('favorites-changed'));
}

export function useFavorites() {
  const favorites = useSyncExternalStore(subscribe, getSnapshotCached);

  const isFavorite = useCallback(
    (id: string) => favorites.some((f) => f.id === id),
    [favorites],
  );

  const toggleFavorite = useCallback(
    (item: FavoriteItem) => {
      const exists = favorites.some((f) => f.id === item.id);
      if (exists) {
        persist(favorites.filter((f) => f.id !== item.id));
      } else {
        persist([...favorites, item]);
      }
    },
    [favorites],
  );

  const removeFavorite = useCallback(
    (id: string) => {
      persist(favorites.filter((f) => f.id !== id));
    },
    [favorites],
  );

  return { favorites, isFavorite, toggleFavorite, removeFavorite };
}
