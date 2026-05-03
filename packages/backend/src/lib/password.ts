// Password hashing with scrypt (Node core — no extra deps). Format:
//   scrypt$N=16384,r=8,p=1$<saltHex>$<derivedHex>
// Hashes are salted and verified with timingSafeEqual.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024; // 64 MiB — comfortably above N*r*128 default cap

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN, { N, r, p, maxmem: MAXMEM });
  return `scrypt$N=${N},r=${r},p=${p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const params = Object.fromEntries(parts[1].split(',').map((kv) => kv.split('=')));
  const sN = parseInt(params.N ?? '0', 10);
  const sR = parseInt(params.r ?? '0', 10);
  const sP = parseInt(params.p ?? '0', 10);
  if (!sN || !sR || !sP) return false;
  const salt = Buffer.from(parts[2], 'hex');
  const expected = Buffer.from(parts[3], 'hex');
  let derived: Buffer;
  try {
    derived = await scrypt(password, salt, expected.length, { N: sN, r: sR, p: sP, maxmem: MAXMEM });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

// Detects the legacy plaintext format (anything not starting with scrypt$).
export function looksHashed(stored: string): boolean {
  return stored.startsWith('scrypt$');
}
