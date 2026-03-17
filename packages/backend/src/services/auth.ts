import { randomBytes, createHash } from 'node:crypto';
import bcrypt from 'bcrypt';
import type { FastifyInstance } from 'fastify';
import { store } from '../db/index.js';
import { env } from '../config/env.js';

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function parseExpiry(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error(`Invalid duration: ${duration}`);
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * multipliers[unit];
}

function generateAccessToken(app: FastifyInstance, userId: string): string {
  return app.jwt.sign(
    { sub: userId },
    { expiresIn: env.JWT_ACCESS_EXPIRES_IN },
  );
}

export async function generateTokens(app: FastifyInstance, userId: string) {
  const accessToken = generateAccessToken(app, userId);

  const rawRefresh = randomBytes(48).toString('base64url');
  const tokenHash = hashToken(rawRefresh);
  const expiresAt = new Date(Date.now() + parseExpiry(env.JWT_REFRESH_EXPIRES_IN));

  store.insert('refreshTokens', {
    userId,
    tokenHash,
    expiresAt,
  });

  return { accessToken, refreshToken: rawRefresh };
}

export async function refreshAccessToken(app: FastifyInstance, rawRefreshToken: string) {
  const tokenHash = hashToken(rawRefreshToken);

  const stored = store.findOne('refreshTokens', (r: any) =>
    r.tokenHash === tokenHash && new Date(r.expiresAt).getTime() > Date.now(),
  );

  if (!stored) return null;

  const user = store.findOne('users', (r: any) => r.id === stored.userId);

  if (!user || !(user as any).isActive || (user as any).type === 'agent') return null;

  return {
    accessToken: generateAccessToken(app, (user as any).id),
    refreshToken: rawRefreshToken,
  };
}

export async function revokeUserRefreshTokens(userId: string) {
  store.deleteWhere('refreshTokens', (r: any) => r.userId === userId);
}
