// Token revocation list. JWTs recorded here are rejected by requireAuth and
// verifyWsToken even if their signature is otherwise valid.
//
// Backed by SQLite: JWT_SECRET is stable across restarts and update.sh restarts
// the service on every self-upgrade, so a purely in-memory list handed logged-
// out tokens their remaining TTL back on the next restart. Only the SHA-256 of
// the token is persisted — the raw token never reaches disk.
//
// The in-memory Map is a cache in front of that table. This process is the only
// writer, so it's hydrated once on first use and then served from memory;
// entries are dropped (here and in the table) once past their JWT exp.

import { createHash } from 'crypto';
import { getDb } from '../services/db.js';

interface Entry { exp: number }

const revoked = new Map<string, Entry>();

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// better-sqlite3 is a native module and getDb() throws if it failed to build or
// the storage root isn't writable. Degrade to the in-memory list in that case
// rather than taking logout — and with it every authenticated request — down.
let dbUnavailable = false;
function db(): ReturnType<typeof getDb> | null {
  if (dbUnavailable) return null;
  try {
    return getDb();
  } catch (err) {
    dbUnavailable = true;
    console.warn('[tokenStore] SQLite unavailable - revocations will not survive a restart:', err);
    return null;
  }
}

let hydrated = false;
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const handle = db();
  if (!handle) return;
  try {
    const now = Math.floor(Date.now() / 1000);
    const rows = handle
      .prepare('SELECT token_hash, exp FROM revoked_tokens WHERE exp >= ?')
      .all(now) as { token_hash: string; exp: number }[];
    for (const row of rows) revoked.set(row.token_hash, { exp: row.exp });
  } catch (err) {
    console.warn('[tokenStore] Could not load revoked tokens:', err);
  }
}

setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [hash, entry] of revoked) {
    if (entry.exp < now) revoked.delete(hash);
  }
  const handle = db();
  if (!handle) return;
  try {
    handle.prepare('DELETE FROM revoked_tokens WHERE exp < ?').run(now);
  } catch {
    // transient I/O — the next sweep retries
  }
}, 60_000).unref?.();

export function revokeToken(token: string, exp: number): void {
  hydrate();
  const hash = hashToken(token);
  revoked.set(hash, { exp });
  const handle = db();
  if (!handle) return;
  try {
    handle
      .prepare('INSERT OR REPLACE INTO revoked_tokens (token_hash, exp) VALUES (?, ?)')
      .run(hash, exp);
  } catch (err) {
    console.warn('[tokenStore] Could not persist revocation:', err);
  }
}

export function isRevoked(token: string): boolean {
  hydrate();
  return revoked.has(hashToken(token));
}
