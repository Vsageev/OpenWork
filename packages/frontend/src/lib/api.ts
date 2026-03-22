const API_BASE = '/api';

let accessToken: string | null = null;
let refreshToken: string | null = null;
let refreshRequest: Promise<RefreshResult> | null = null;

const TOKEN_KEY = 'ws_access_token';
const REFRESH_KEY = 'ws_refresh_token';
const AUTH_EVENT_KEY = 'ws_auth_event';

type AuthSessionEvent = 'updated' | 'cleared';
type AuthSessionListener = (event: AuthSessionEvent) => void;

const authSessionListeners = new Set<AuthSessionListener>();

function isStoredToken(value: string | null): value is string {
  return Boolean(value && value !== 'undefined' && value !== 'null');
}

export function loadTokens() {
  const storedAccess = localStorage.getItem(TOKEN_KEY);
  const storedRefresh = localStorage.getItem(REFRESH_KEY);

  if (isStoredToken(storedAccess) && isStoredToken(storedRefresh)) {
    accessToken = storedAccess;
    refreshToken = storedRefresh;
    return;
  }

  accessToken = null;
  refreshToken = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

export function setTokens(access: string, refresh: string) {
  if (!isStoredToken(access) || !isStoredToken(refresh)) {
    throw new Error('Invalid authentication tokens received');
  }
  accessToken = access;
  refreshToken = refresh;
  localStorage.setItem(TOKEN_KEY, access);
  localStorage.setItem(REFRESH_KEY, refresh);
  localStorage.setItem(AUTH_EVENT_KEY, JSON.stringify({ type: 'updated', at: Date.now() }));
  notifyAuthSessionListeners('updated');
}

export function clearTokens() {
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.setItem(AUTH_EVENT_KEY, JSON.stringify({ type: 'cleared', at: Date.now() }));
  notifyAuthSessionListeners('cleared');
}

export function getAccessToken() {
  return accessToken;
}

export function subscribeToAuthSession(listener: AuthSessionListener): () => void {
  authSessionListeners.add(listener);

  const onStorage = (event: StorageEvent) => {
    if (event.key !== AUTH_EVENT_KEY || !event.newValue) {
      return;
    }

    try {
      const payload = JSON.parse(event.newValue) as { type?: AuthSessionEvent };
      if (payload.type !== 'updated' && payload.type !== 'cleared') {
        return;
      }

      loadTokens();
      listener(payload.type);
    } catch {
      // ignore malformed auth sync payloads
    }
  };

  window.addEventListener('storage', onStorage);

  return () => {
    authSessionListeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

function notifyAuthSessionListeners(event: AuthSessionEvent) {
  for (const listener of authSessionListeners) {
    listener(event);
  }
}

type RefreshResult = 'success' | 'invalid' | 'unavailable';

async function performTokenRefresh(currentRefreshToken: string): Promise<RefreshResult> {
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: currentRefreshToken }),
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        clearTokens();
        return 'invalid';
      }
      return 'unavailable';
    }

    const data = await res.json();
    setTokens(data.accessToken, data.refreshToken);
    return 'success';
  } catch {
    return 'unavailable';
  }
}

async function refreshAccessToken(): Promise<RefreshResult> {
  if (!refreshToken) return 'invalid';

  if (!refreshRequest) {
    refreshRequest = performTokenRefresh(refreshToken).finally(() => {
      refreshRequest = null;
    });
  }

  return refreshRequest;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.body != null ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers as Record<string, string>),
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch (err) {
    if (err instanceof TypeError && err.message.includes('Failed to fetch')) {
      throw new ApiError(0, 'Unable to connect to the server. Check your internet connection.');
    }
    throw err;
  }

  // If 401 and we have a refresh token, try refreshing
  if (res.status === 401 && refreshToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed === 'success') {
      headers['Authorization'] = `Bearer ${accessToken}`;
      res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    } else if (refreshed === 'unavailable') {
      throw new ApiError(0, 'Unable to refresh the current session. Please try again.');
    }
  }

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    const message =
      (body && typeof body === 'object' && 'message' in body
        ? (body as { message: string }).message
        : undefined) ?? res.statusText;
    throw new ApiError(res.status, message, body);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

/**
 * Upload a file via multipart/form-data.
 * Does NOT set Content-Type — the browser sets it with the boundary.
 */
export async function apiUpload<T = unknown>(
  path: string,
  formData: FormData,
  options: Omit<RequestInit, 'method' | 'body'> = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      method: 'POST',
      headers,
      body: formData,
    });
  } catch (err) {
    if (err instanceof TypeError && err.message.includes('Failed to fetch')) {
      throw new ApiError(0, 'Unable to connect to the server. Check your internet connection.');
    }
    throw err;
  }

  if (res.status === 401 && refreshToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed === 'success') {
      headers['Authorization'] = `Bearer ${accessToken}`;
      res = await fetch(`${API_BASE}${path}`, {
        ...options,
        method: 'POST',
        headers,
        body: formData,
      });
    } else if (refreshed === 'unavailable') {
      throw new ApiError(0, 'Unable to refresh the current session. Please try again.');
    }
  }

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    const message =
      (body && typeof body === 'object' && 'message' in body
        ? (body as { message: string }).message
        : undefined) ?? res.statusText;
    throw new ApiError(res.status, message, body);
  }

  return res.json();
}
