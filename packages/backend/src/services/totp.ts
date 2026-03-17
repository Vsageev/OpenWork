import { randomBytes, createHash } from 'node:crypto';
import { TOTP, Secret } from 'otpauth';
import { store } from '../db/index.js';

const ISSUER = 'OpenWork';
const RECOVERY_CODE_COUNT = 8;

function createTotpInstance(secret: string, userEmail: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label: userEmail,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
}

export function generateTotpSecret(): string {
  const secret = new Secret({ size: 20 });
  return secret.base32;
}

export function generateTotpUri(secret: string, userEmail: string): string {
  const totp = createTotpInstance(secret, userEmail);
  return totp.toString();
}

export function verifyTotpToken(secret: string, token: string, userEmail: string): boolean {
  const totp = createTotpInstance(secret, userEmail);
  const delta = totp.validate({ token, window: 1 });
  return delta !== null;
}

export function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const code = randomBytes(4).toString('hex'); // 8-char hex codes
    codes.push(code);
  }
  return codes;
}

function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.toLowerCase()).digest('hex');
}

export function hashRecoveryCodes(codes: string[]): string {
  return JSON.stringify(codes.map(hashRecoveryCode));
}

export function verifyRecoveryCode(code: string, hashedCodesJson: string): { valid: boolean; remaining: string } {
  const hashes: string[] = JSON.parse(hashedCodesJson);
  const inputHash = hashRecoveryCode(code);
  const index = hashes.indexOf(inputHash);

  if (index === -1) {
    return { valid: false, remaining: hashedCodesJson };
  }

  // Remove used code
  hashes.splice(index, 1);
  return { valid: true, remaining: JSON.stringify(hashes) };
}

export async function enableTotp(userId: string, secret: string, recoveryCodes: string[]) {
  store.update('users', userId, {
    totpSecret: secret,
    totpEnabled: true,
    recoveryCodes: hashRecoveryCodes(recoveryCodes),
  });
}

export async function disableTotp(userId: string) {
  store.update('users', userId, {
    totpSecret: null,
    totpEnabled: false,
    recoveryCodes: null,
  });
}

export async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const user = store.getById('users', userId);

  if (!user?.recoveryCodes) return false;

  const { valid, remaining } = verifyRecoveryCode(code, user.recoveryCodes as string);
  if (!valid) return false;

  store.update('users', userId, { recoveryCodes: remaining });

  return true;
}

export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  store.update('users', userId, { recoveryCodes: hashRecoveryCodes(codes) });
  return codes;
}
