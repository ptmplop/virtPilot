// Symmetric encryption for secrets stored at rest (TOTP secrets, VM passwords).
// AES-256-GCM with the key derived from ENCRYPTION_KEY. Old plaintext values
// stored before this layer existed are passed through transparently — they
// re-encrypt the next time they're written.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const TAG = 'enc:v1:';
const ALGO = 'aes-256-gcm';

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    // Fall back to deriving from JWT_SECRET so existing installs without
    // ENCRYPTION_KEY in .env still get encryption rather than silently
    // skipping it. install.sh writes a dedicated ENCRYPTION_KEY going
    // forward.
    const jwt = process.env.JWT_SECRET ?? '';
    if (jwt.length < 32) {
      throw new Error('Cannot derive encryption key — ENCRYPTION_KEY (recommended) or JWT_SECRET must be set');
    }
    cachedKey = createHash('sha256').update('virtpilot-secrets:' + jwt).digest();
    return cachedKey;
  }
  cachedKey = createHash('sha256').update(raw).digest();
  return cachedKey;
}

export function encryptSecret(plain: string | undefined | null): string | undefined {
  if (plain == null || plain === '') return plain ?? undefined;
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, tag, ct]).toString('base64');
  return TAG + blob;
}

export function decryptSecret(stored: string | undefined | null): string | undefined {
  if (stored == null || stored === '') return undefined;
  if (!stored.startsWith(TAG)) {
    // Legacy plaintext value — return as-is; caller will re-save it encrypted.
    return stored;
  }
  const key = getKey();
  const blob = Buffer.from(stored.slice(TAG.length), 'base64');
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

export function isEncrypted(stored: string | undefined | null): boolean {
  return typeof stored === 'string' && stored.startsWith(TAG);
}
