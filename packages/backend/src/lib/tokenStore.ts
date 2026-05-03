// In-memory token revocation list. JWTs added here are rejected by requireAuth
// and verifyWsToken even if their signature is otherwise valid. Cleared on
// process restart (acceptable: restart invalidates all sessions anyway because
// JWT_SECRET could be regenerated, and restarts are rare).
//
// Tokens self-expire after their JWT exp anyway; we only keep them in this
// list until that time so the set doesn't grow indefinitely.

interface Entry { exp: number }

const revoked = new Map<string, Entry>();

setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [token, entry] of revoked) {
    if (entry.exp < now) revoked.delete(token);
  }
}, 60_000).unref?.();

export function revokeToken(token: string, exp: number): void {
  revoked.set(token, { exp });
}

export function isRevoked(token: string): boolean {
  return revoked.has(token);
}
