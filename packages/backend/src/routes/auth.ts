import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { store } from '../db/index.js';
import {
  hashPassword,
  verifyPassword,
  generateTokens,
  refreshAccessToken,
  revokeUserRefreshTokens,
} from '../services/auth.js';
import {
  generateTotpSecret,
  generateTotpUri,
  verifyTotpToken,
  generateRecoveryCodes,
  enableTotp,
  disableTotp,
  consumeRecoveryCode,
  regenerateRecoveryCodes,
} from '../services/totp.js';
import { createAuditLog } from '../services/audit-log.js';
import { authRateLimitConfig } from '../plugins/rate-limit.js';
import { validatePasswordStrength } from '../utils/password-policy.js';
import { ApiError } from '../utils/api-errors.js';

const registerBody = z.object({
  email: z.email(),
  password: z.string().min(8).max(128),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
});

const loginBody = z.object({
  email: z.email(),
  password: z.string().min(1),
});

const refreshBody = z.object({
  refreshToken: z.string().min(1),
});

const totpTokenBody = z.object({
  token: z.string().length(6),
});

const twoFactorVerifyBody = z.object({
  twoFactorToken: z.string().min(1),
  code: z.string().min(1),
});

const disableTotpBody = z.object({
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // Register
  typedApp.post('/api/auth/register', { config: { rateLimit: authRateLimitConfig() }, schema: { tags: ['Auth'], summary: 'Register a new user', body: registerBody } }, async (request, reply) => {
    const { email, password, firstName, lastName } = request.body;

    // Enforce password complexity policy (OWASP A07:2021)
    const passwordCheck = validatePasswordStrength(password);
    if (!passwordCheck.valid) {
      throw ApiError.badRequest('weak_password', passwordCheck.errors.join('. '), 'Password must be at least 8 characters with uppercase, lowercase, number, and special character');
    }

    const existing = store.findOne('users', (u) => u.email === email.toLowerCase());

    if (existing) {
      throw ApiError.conflict('duplicate_email', 'User with this email already exists', 'Use POST /api/auth/login to sign in instead');
    }

    const passwordHash = await hashPassword(password);

    const user = store.insert('users', {
      email: email.toLowerCase(),
      passwordHash,
      firstName,
      lastName,
      isActive: true,
      type: 'human',
      totpEnabled: false,
    });

    const tokens = await generateTokens(app, user.id as string);

    return reply.status(201).send({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        type: (user.type as string | undefined) ?? 'human',
        createdAt: user.createdAt,
      },
      ...tokens,
    });
  });

  // Login
  typedApp.post('/api/auth/login', { config: { rateLimit: authRateLimitConfig() }, schema: { tags: ['Auth'], summary: 'Login', body: loginBody } }, async (request, reply) => {
    const { email, password } = request.body;

    const user = store.findOne('users', (u) => u.email === email.toLowerCase());

    if (!user) {
      throw ApiError.unauthorized('invalid_credentials', 'Invalid email or password');
    }

    if (user.type === 'agent') {
      throw ApiError.forbidden('agent_account_login_forbidden', 'Agent users cannot sign in interactively');
    }

    if (!user.isActive) {
      throw ApiError.forbidden('account_deactivated', 'Account is deactivated', 'Contact an administrator to reactivate your account');
    }

    const valid = await verifyPassword(password, user.passwordHash as string);
    if (!valid) {
      // Audit failed login attempt (OWASP A07:2021)
      createAuditLog({
        userId: user.id as string,
        action: 'login_failed',
        entityType: 'user',
        entityId: user.id as string,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      }).catch(() => {});

      throw ApiError.unauthorized('invalid_credentials', 'Invalid email or password');
    }

    // If 2FA is enabled, return a temporary token for 2FA verification
    if (user.totpEnabled) {
      const twoFactorToken = app.jwt.sign(
        { sub: user.id as string, twoFactor: true },
        { expiresIn: '5m' },
      );

      return reply.send({
        twoFactorRequired: true,
        twoFactorToken,
      });
    }

    const tokens = await generateTokens(app, user.id as string);

    // Audit successful login
    createAuditLog({
      userId: user.id as string,
      action: 'login',
      entityType: 'user',
      entityId: user.id as string,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    }).catch(() => {});

    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        type: (user.type as string | undefined) ?? 'human',
        createdAt: user.createdAt,
      },
      ...tokens,
    });
  });

  // Verify 2FA during login
  typedApp.post('/api/auth/2fa/verify', { config: { rateLimit: authRateLimitConfig() }, schema: { tags: ['Auth'], summary: 'Verify 2FA during login', body: twoFactorVerifyBody } }, async (request, reply) => {
    const { twoFactorToken, code } = request.body;

    let payload: { sub: string; twoFactor?: boolean };
    try {
      payload = app.jwt.verify(twoFactorToken);
    } catch {
      throw ApiError.unauthorized('invalid_2fa_token', 'Invalid or expired two-factor token', 'Re-authenticate via POST /api/auth/login to obtain a new twoFactorToken');
    }

    if (!payload.twoFactor) {
      throw ApiError.unauthorized('invalid_2fa_token', 'Invalid two-factor token');
    }

    const user = store.getById('users', payload.sub);

    if (!user || !user.isActive || !user.totpEnabled || !user.totpSecret) {
      throw ApiError.unauthorized('2fa_not_configured', 'Two-factor authentication not configured', 'Enable 2FA first via POST /api/auth/2fa/setup');
    }

    // Try TOTP code first (6 digits), then try recovery code
    let verified = false;
    if (/^\d{6}$/.test(code)) {
      verified = verifyTotpToken(user.totpSecret as string, code, user.email as string);
    }

    if (!verified) {
      // Try as recovery code
      verified = await consumeRecoveryCode(user.id as string, code);
    }

    if (!verified) {
      // Audit failed 2FA attempt
      createAuditLog({
        userId: user.id as string,
        action: 'two_factor_failed',
        entityType: 'user',
        entityId: user.id as string,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      }).catch(() => {});

      throw ApiError.unauthorized('invalid_2fa_code', 'Invalid two-factor code', 'Provide a valid 6-digit TOTP code from your authenticator app, or a recovery code');
    }

    const tokens = await generateTokens(app, user.id as string);

    // Audit successful 2FA login
    createAuditLog({
      userId: user.id as string,
      action: 'login',
      entityType: 'user',
      entityId: user.id as string,
      changes: { method: 'totp_2fa' },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    }).catch(() => {});

    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        type: (user.type as string | undefined) ?? 'human',
        createdAt: user.createdAt,
      },
      ...tokens,
    });
  });

  // Refresh token
  typedApp.post('/api/auth/refresh', { config: { rateLimit: authRateLimitConfig() }, schema: { tags: ['Auth'], summary: 'Refresh access token', body: refreshBody } }, async (request, reply) => {
    const tokens = await refreshAccessToken(app, request.body.refreshToken);
    if (!tokens) {
      throw ApiError.unauthorized('invalid_refresh_token', 'Invalid or expired refresh token', 'Re-authenticate via POST /api/auth/login');
    }

    return reply.send(tokens);
  });

  // Get current user
  typedApp.get('/api/auth/me', { onRequest: [app.authenticate], schema: { tags: ['Auth'], summary: 'Get current user' } }, async (request, reply) => {
    const { sub } = request.user;

    const user = store.getById('users', sub);

    if (!user) {
      throw ApiError.unauthorized('user_not_found', 'User not found', 'The JWT subject references a user that no longer exists');
    }

    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        type: (user.type as string | undefined) ?? 'human',
        isActive: user.isActive,
        totpEnabled: user.totpEnabled,
        createdAt: user.createdAt,
      },
    });
  });

  // Logout (revoke all refresh tokens)
  typedApp.post('/api/auth/logout', { onRequest: [app.authenticate], schema: { tags: ['Auth'], summary: 'Logout' } }, async (request, reply) => {
    const { sub } = request.user;
    await revokeUserRefreshTokens(sub);
    return reply.send({ message: 'Logged out successfully' });
  });

  // Change password
  const changePasswordBody = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8).max(128),
  });

  typedApp.patch('/api/auth/password', { onRequest: [app.authenticate], schema: { tags: ['Auth'], summary: 'Change password', body: changePasswordBody } }, async (request, reply) => {
    const { sub } = request.user;
    const { currentPassword, newPassword } = request.body;

    const user = store.getById('users', sub);
    if (!user) {
      throw ApiError.unauthorized('user_not_found', 'User not found');
    }

    const valid = await verifyPassword(currentPassword, user.passwordHash as string);
    if (!valid) {
      throw ApiError.unauthorized('invalid_password', 'Current password is incorrect');
    }

    const passwordCheck = validatePasswordStrength(newPassword);
    if (!passwordCheck.valid) {
      throw ApiError.badRequest('weak_password', passwordCheck.errors.join('. '), 'Password must be at least 8 characters with uppercase, lowercase, number, and special character');
    }

    const newHash = await hashPassword(newPassword);
    store.update('users', sub, { passwordHash: newHash });

    await createAuditLog({
      userId: sub,
      action: 'password_changed',
      entityType: 'user',
      entityId: sub,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return reply.send({ message: 'Password changed successfully' });
  });

  // Update profile
  const updateProfileBody = z.object({
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
  });

  typedApp.patch('/api/auth/profile', { onRequest: [app.authenticate], schema: { tags: ['Auth'], summary: 'Update profile', body: updateProfileBody } }, async (request, reply) => {
    const { sub } = request.user;
    const updates: Record<string, unknown> = {};

    if (request.body.firstName !== undefined) updates.firstName = request.body.firstName;
    if (request.body.lastName !== undefined) updates.lastName = request.body.lastName;

    if (Object.keys(updates).length === 0) {
      throw ApiError.badRequest('no_updates', 'No fields to update');
    }

    const user = store.getById('users', sub);
    if (!user) {
      throw ApiError.unauthorized('user_not_found', 'User not found');
    }

    store.update('users', sub, updates);
    const updated = store.getById('users', sub);

    await createAuditLog({
      userId: sub,
      action: 'profile_updated',
      entityType: 'user',
      entityId: sub,
      changes: updates,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return reply.send({
      user: {
        id: updated!.id,
        email: updated!.email,
        firstName: updated!.firstName,
        lastName: updated!.lastName,
        type: (updated!.type as string | undefined) ?? 'human',
        createdAt: updated!.createdAt,
      },
    });
  });

  // --- TOTP 2FA Management (requires auth) ---

  // Begin TOTP setup - generates secret and returns QR URI
  typedApp.post('/api/auth/2fa/setup', { onRequest: [app.authenticate], schema: { tags: ['Auth'], summary: 'Begin TOTP 2FA setup' } }, async (request, reply) => {
    const { sub } = request.user;

    const user = store.getById('users', sub);

    if (!user) {
      throw ApiError.unauthorized('user_not_found', 'User not found');
    }

    if (user.totpEnabled) {
      throw ApiError.conflict('2fa_already_enabled', 'Two-factor authentication is already enabled');
    }

    const secret = generateTotpSecret();
    const otpauthUri = generateTotpUri(secret, user.email as string);

    // Store the secret temporarily (not yet enabled)
    store.update('users', sub, { totpSecret: secret });

    return reply.send({
      secret,
      otpauthUri,
    });
  });

  // Confirm TOTP setup - verifies the user can generate valid codes
  typedApp.post('/api/auth/2fa/confirm', { onRequest: [app.authenticate], schema: { tags: ['Auth'], summary: 'Confirm TOTP 2FA setup', body: totpTokenBody } }, async (request, reply) => {
    const { sub } = request.user;

    const user = store.getById('users', sub);

    if (!user || !user.totpSecret) {
      throw ApiError.badRequest('2fa_setup_not_initiated', 'TOTP setup has not been initiated', 'Call POST /api/auth/2fa/setup first to generate a secret');
    }

    if (user.totpEnabled) {
      throw ApiError.conflict('2fa_already_enabled', 'Two-factor authentication is already enabled');
    }

    const valid = verifyTotpToken(user.totpSecret as string, request.body.token, user.email as string);
    if (!valid) {
      throw ApiError.unauthorized('invalid_totp_code', 'Invalid TOTP code', 'Enter the 6-digit code from your authenticator app');
    }

    const recoveryCodes = generateRecoveryCodes();
    await enableTotp(sub, user.totpSecret as string, recoveryCodes);

    await createAuditLog({
      userId: sub,
      action: 'two_factor_enabled',
      entityType: 'user',
      entityId: sub,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return reply.send({
      message: 'Two-factor authentication enabled',
      recoveryCodes,
    });
  });

  // Disable TOTP (requires password confirmation)
  typedApp.post('/api/auth/2fa/disable', { onRequest: [app.authenticate], schema: { tags: ['Auth'], summary: 'Disable TOTP 2FA', body: disableTotpBody } }, async (request, reply) => {
    const { sub } = request.user;

    const user = store.getById('users', sub);

    if (!user) {
      throw ApiError.unauthorized('user_not_found', 'User not found');
    }

    if (!user.totpEnabled) {
      throw ApiError.badRequest('2fa_not_enabled', 'Two-factor authentication is not enabled');
    }

    const valid = await verifyPassword(request.body.password, user.passwordHash as string);
    if (!valid) {
      throw ApiError.unauthorized('invalid_password', 'Invalid password');
    }

    await disableTotp(sub);

    await createAuditLog({
      userId: sub,
      action: 'two_factor_disabled',
      entityType: 'user',
      entityId: sub,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return reply.send({ message: 'Two-factor authentication disabled' });
  });

  // Regenerate recovery codes
  typedApp.post('/api/auth/2fa/recovery-codes', { onRequest: [app.authenticate], schema: { tags: ['Auth'], summary: 'Regenerate recovery codes' } }, async (request, reply) => {
    const { sub } = request.user;

    const user = store.getById('users', sub);

    if (!user || !user.totpEnabled) {
      throw ApiError.badRequest('2fa_not_enabled', 'Two-factor authentication is not enabled', 'Enable 2FA first via POST /api/auth/2fa/setup and POST /api/auth/2fa/confirm');
    }

    const codes = await regenerateRecoveryCodes(sub);

    return reply.send({ recoveryCodes: codes });
  });
}
