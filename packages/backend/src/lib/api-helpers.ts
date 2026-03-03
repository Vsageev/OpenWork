// API helpers for consistent response shapes and common patterns

import type { ListResponse } from 'shared';

/**
 * Create a standardized API list response
 * Ensures all list endpoints return consistent shapes
 */
export function apiListResponse<T>(
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
 * Safe handler wrapper that catches errors and returns consistent format
 */
export async function safeHandler<T>(
  handler: () => Promise<T>
): Promise<{ data?: T; error?: string }> {
  try {
    const data = await handler();
    return { data };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { error };
  }
}

/**
 * Simple in-memory rate limiter
 * Use for development-speed rate limiting without external dependencies
 */
export class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  
  constructor(
    private maxRequests: number,
    private windowMs: number
  ) {}

  /**
   * Check if request is allowed
   * @param key - Identifier (e.g., userId, agentId, IP)
   * @returns true if allowed, false if rate limited
   */
  isAllowed(key: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    
    const timestamps = this.requests.get(key) || [];
    const recentTimestamps = timestamps.filter(t => t > windowStart);
    
    if (recentTimestamps.length >= this.maxRequests) {
      return false;
    }
    
    recentTimestamps.push(now);
    this.requests.set(key, recentTimestamps);
    
    // Cleanup old entries periodically
    if (recentTimestamps.length % 10 === 0) {
      this.requests.set(key, recentTimestamps.filter(t => t > windowStart));
    }
    
    return true;
  }

  /**
   * Reset rate limit for a key
   */
  reset(key: string): void {
    this.requests.delete(key);
  }
}

/**
 * Create a rate limiter for agent prompt execution
 * Default: 10 requests per minute per agent
 */
export function createAgentRateLimiter(): RateLimiter {
  return new RateLimiter(10, 60 * 1000); // 10 req/min
}
