/**
 * Session Token Generation
 * Cryptographically secure random token generation using Web Crypto API
 */

/**
 * Generate a cryptographically secure random session token
 * Uses Web Crypto API for sufficient entropy (32 bytes = 256 bits)
 * This provides 2^256 possible tokens, making brute-force attacks infeasible
 */
export function generateSessionToken(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(randomBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Hash a session token using Web Crypto API
 * Uses SHA-256 for hashing before storing in database
 */
export async function hashSessionToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
