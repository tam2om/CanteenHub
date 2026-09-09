/**
 * Password policy.
 *
 * Deliberately minimal: a length floor and a small list of obviously guessable
 * choices. No composition rules (upper/lower/digit/symbol) - those push people
 * toward "P@ssw0rd1" and measurably weaken outcomes rather than improving them.
 *
 * Hashing lives in lib/auth.ts (PBKDF2-SHA-256, 100k iterations) and is NOT
 * duplicated here. This module only decides whether a candidate is acceptable.
 */

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Rejected outright regardless of length. Short list on purpose: it catches the
 * lazy default an administrator might reach for when creating many accounts,
 * which is the realistic risk here, not an exhaustive breach corpus.
 */
const OBVIOUS_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd123',
  '1234567890',
  '0123456789',
  'qwertyuiop',
  'canteenhub',
  'welcome123',
  'changeme123',
  'letmein123',
  'adminadmin',
]);

export interface PasswordValidationResult {
  valid: boolean;
  error?: string;
}

export function validatePassword(password: unknown): PasswordValidationResult {
  if (typeof password !== 'string' || password.length === 0) {
    return { valid: false, error: 'password is required' };
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return { valid: false, error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    return { valid: false, error: `password must be at most ${MAX_PASSWORD_LENGTH} characters` };
  }

  if (password.trim().length === 0) {
    return { valid: false, error: 'password cannot be only whitespace' };
  }

  if (OBVIOUS_PASSWORDS.has(password.toLowerCase())) {
    return { valid: false, error: 'password is too easily guessed; choose another' };
  }

  return { valid: true };
}
