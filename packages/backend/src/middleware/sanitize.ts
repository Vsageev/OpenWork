import type { FastifyInstance, FastifyRequest } from 'fastify';

type SanitizedRequestPart = 'body' | 'query' | 'params';

interface RouteSanitizationConfig {
  preserve?: Partial<Record<SanitizedRequestPart, string[]>>;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    sanitization?: RouteSanitizationConfig;
  }
}

/** Keys that could be used for prototype pollution attacks */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursively sanitize all string values in an object:
 * - Trim leading/trailing whitespace
 * - Remove null-byte characters
 * - Strip control characters (except tab, newline, carriage return)
 * - Strip HTML-like tags from URL-derived inputs
 * - Block prototype pollution via dangerous keys
 */
function sanitizeValue(
  value: unknown,
  preservePaths: Set<string>,
  currentPath = '',
  stripHtmlTags = false,
): unknown {
  if (typeof value === 'string') {
    if (currentPath && preservePaths.has(currentPath)) {
      return value;
    }

    const sanitized = value
      .replace(/\0/g, '') // Remove null bytes
      // eslint-disable-next-line no-control-regex
      .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Strip control chars (keep \t \n \r)
      .trim();

    return stripHtmlTags ? sanitized.replace(/<[^>]*>/g, '') : sanitized;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      sanitizeValue(
        item,
        preservePaths,
        currentPath ? `${currentPath}.${index}` : String(index),
        stripHtmlTags,
      ),
    );
  }

  if (value !== null && typeof value === 'object') {
    return sanitizeObject(
      value as Record<string, unknown>,
      preservePaths,
      currentPath,
      stripHtmlTags,
    );
  }

  return value;
}

function sanitizeObject(
  obj: Record<string, unknown>,
  preservePaths: Set<string>,
  currentPath = '',
  stripHtmlTags = false,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    // Prototype pollution protection (OWASP Mass Assignment)
    if (DANGEROUS_KEYS.has(key)) continue;
    const nextPath = currentPath ? `${currentPath}.${key}` : key;
    result[key] = sanitizeValue(obj[key], preservePaths, nextPath, stripHtmlTags);
  }
  return result;
}

function getPreservePaths(request: FastifyRequest, part: SanitizedRequestPart): Set<string> {
  return new Set(request.routeOptions.config.sanitization?.preserve?.[part] ?? []);
}

/**
 * Register a global `preHandler` hook that sanitizes request body, query, and params.
 * Body values may contain user-authored content, so HTML-like tags are only stripped from query/params.
 */
export function registerSanitization(app: FastifyInstance) {
  app.addHook('preHandler', async (request) => {
    if (request.body && typeof request.body === 'object') {
      request.body = sanitizeObject(
        request.body as Record<string, unknown>,
        getPreservePaths(request, 'body'),
        '',
        false,
      );
    }

    if (request.query && typeof request.query === 'object') {
      request.query = sanitizeObject(
        request.query as Record<string, unknown>,
        getPreservePaths(request, 'query'),
        '',
        true,
      );
    }

    if (request.params && typeof request.params === 'object') {
      request.params = sanitizeObject(
        request.params as Record<string, unknown>,
        getPreservePaths(request, 'params'),
        '',
        true,
      );
    }
  });
}
