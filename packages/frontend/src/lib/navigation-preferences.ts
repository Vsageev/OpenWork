const PREFERRED_COLLECTION_ID_KEY = 'ws_preferred_collection_id';
const PREFERRED_BOARD_ID_KEY = 'ws_preferred_board_id';

function getStoredId(key: string): string | null {
  try {
    const value = localStorage.getItem(key);
    if (!value || value === 'undefined' || value === 'null') return null;
    return value;
  } catch {
    return null;
  }
}

function setStoredId(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // best-effort
  }
}

function clearStoredId(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // best-effort
  }
}

export function getPreferredCollectionId(): string | null {
  return getStoredId(PREFERRED_COLLECTION_ID_KEY);
}

export function setPreferredCollectionId(collectionId: string): void {
  setStoredId(PREFERRED_COLLECTION_ID_KEY, collectionId);
}

export function clearPreferredCollectionId(): void {
  clearStoredId(PREFERRED_COLLECTION_ID_KEY);
}

export function getPreferredBoardId(): string | null {
  return getStoredId(PREFERRED_BOARD_ID_KEY);
}

export function setPreferredBoardId(boardId: string): void {
  setStoredId(PREFERRED_BOARD_ID_KEY, boardId);
}

export function clearPreferredBoardId(): void {
  clearStoredId(PREFERRED_BOARD_ID_KEY);
}

const ACTIVE_WORKSPACE_ID_KEY = 'ws_active_workspace_id';

export function getActiveWorkspaceId(): string | null {
  return getStoredId(ACTIVE_WORKSPACE_ID_KEY);
}

export function setActiveWorkspaceId(workspaceId: string): void {
  setStoredId(ACTIVE_WORKSPACE_ID_KEY, workspaceId);
}

export function clearActiveWorkspaceId(): void {
  clearStoredId(ACTIVE_WORKSPACE_ID_KEY);
}
