import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';

/**
 * OWASP-aligned security hardening middleware.
 * Registers global hooks and decorators for:
 * - Cache-control on sensitive responses
 * - JWT secret validation in production
 */
export function registerSecurityMiddleware(app: FastifyInstance) {
  // ── Warn if using default JWT secret ─────────────────────────────────
  if (
    env.NODE_ENV === 'production' &&
    env.JWT_SECRET.includes('change-me')
  ) {
    app.log.error(
      'CRITICAL: JWT_SECRET is set to the default value. Change it immediately in production!',
    );
    process.exit(1);
  }

  // ── Add security-relevant response headers ───────────────────────────
  app.addHook('onSend', async (_request, reply) => {
    // Prevent caching of API responses by default
    if (!reply.hasHeader('Cache-Control')) {
      reply.header('Cache-Control', 'no-store');
    }
    // Prevent MIME sniffing (supplement helmet)
    reply.header('X-Content-Type-Options', 'nosniff');
    // Clickjacking protection
    if (!reply.hasHeader('X-Frame-Options')) {
      reply.header('X-Frame-Options', 'DENY');
    }
    // Referrer policy
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Permissions policy — restrict browser features
    reply.header(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=()',
    );
  });
}
