// Shared utility functions for consistent development patterns

/**
 * Format bytes to human-readable string
 * @param bytes - Size in bytes
 * @returns Formatted string (e.g., "1.5 MB")
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Format ISO date string to locale date
 * @param iso - ISO date string
 * @returns Formatted date string
 */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Standard API list response shape
 * Ensures consistent response format across all list endpoints
 */
export interface ListResponse<T> {
  entries: T[];
  total: number;
  limit?: number;
  offset?: number;
}

/**
 * Create a standardized list response
 * @param entries - Array of items
 * @param total - Total count of items
 * @param limit - Optional limit used
 * @param offset - Optional offset used
 */
export function createListResponse<T>(
  entries: T[],
  total: number,
  limit?: number,
  offset?: number
): ListResponse<T> {
  const response: ListResponse<T> = { entries, total };
  if (limit !== undefined) response.limit = limit;
  if (offset !== undefined) response.offset = offset;
  return response;
}

/**
 * Safe JSON parse with default value
 * @param str - JSON string to parse
 * @param defaultValue - Default value if parsing fails
 */
export function safeJsonParse<T>(str: string, defaultValue: T): T {
  try {
    return JSON.parse(str) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Format an ISO date string as a human-readable relative time.
 * e.g. "just now", "5m ago", "3h ago", "12d ago", or a locale date string
 * @param iso - ISO date string or timestamp string
 * @returns Relative time string
 */
export function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Debounce function for rate limiting
 * @param fn - Function to debounce
 * @param delay - Delay in milliseconds
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}
