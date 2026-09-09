/**
 * Authentication Library
 * Password hashing and verification using Web Crypto API
 */

/**
 * Hash a password using PBKDF2-SHA-256
 * 
 * Cloudflare Workers support the Web Crypto API which includes PBKDF2.
 * We use PBKDF2 with SHA-256, 100,000 iterations, and a random salt.
 * 
 * Format: $pbkdf2-sha256$iterations$salt$hash
 */
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const passwordData = encoder.encode(password);
  
  // Generate random salt (16 bytes)
  const salt = crypto.getRandomValues(new Uint8Array(16));
  
  // Import password as key
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordData,
    'PBKDF2',
    false,
    ['deriveBits']
  );
  
  // Derive key using PBKDF2
  const iterations = 100000;
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256 // 32 bytes = 256 bits
  );
  
  // Convert to hex strings
  const saltHex = Array.from(salt)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  const hashHex = Array.from(new Uint8Array(derivedBits))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  // Return formatted hash string
  return `$pbkdf2-sha256$${iterations}$${saltHex}$${hashHex}`;
}

/**
 * Verify a password against a stored hash
 * Handles malformed hashes safely by always returning false
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    // Validate stored hash format before processing
    if (!storedHash || typeof storedHash !== 'string') {
      console.error('Invalid stored hash: not a string');
      return false;
    }
    
    // Parse stored hash
    const parts = storedHash.split('$');
    
    // Expected format: $pbkdf2-sha256$iterations$salt$hash (5 parts with leading empty string)
    if (parts.length !== 5 || parts[0] !== '' || parts[1] !== 'pbkdf2-sha256') {
      console.error('Invalid hash format: expected $pbkdf2-sha256$iterations$salt$hash');
      return false;
    }
    
    const iterations = parseInt(parts[2], 10);
    const saltHex = parts[3];
    const expectedHashHex = parts[4];
    
    // Validate iterations is a positive number
    if (isNaN(iterations) || iterations <= 0) {
      console.error('Invalid hash format: iterations must be a positive number');
      return false;
    }
    
    // Validate salt hex string (must be even length, valid hex characters)
    if (!saltHex || saltHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(saltHex)) {
      console.error('Invalid hash format: salt is not valid hex');
      return false;
    }
    
    // Validate expected hash hex string
    if (!expectedHashHex || expectedHashHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(expectedHashHex)) {
      console.error('Invalid hash format: hash is not valid hex');
      return false;
    }
    
    // Convert salt from hex to Uint8Array
    const salt = new Uint8Array(saltHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    
    // Derive key from provided password
    const encoder = new TextEncoder();
    const passwordData = encoder.encode(password);
    
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      passwordData,
      'PBKDF2',
      false,
      ['deriveBits']
    );
    
    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: iterations,
        hash: 'SHA-256',
      },
      keyMaterial,
      256
    );
    
    const computedHashHex = Array.from(new Uint8Array(derivedBits))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    
    // Constant-time comparison to prevent timing attacks
    return constantTimeCompare(computedHashHex, expectedHashHex);
    
  } catch (error) {
    // Any error during verification results in failure
    // This prevents leaking information about hash format issues
    console.error('Password verification error:', error);
    return false;
  }
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  
  return result === 0;
}
