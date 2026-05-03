// Tracks recently-accepted TOTP codes so the same code can't be reused inside
// its 90-second tolerance window. Keyed by secret+code so multiple users with
// distinct secrets don't collide.

const used = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of used) {
    if (now - ts > 120_000) used.delete(k);
  }
}, 60_000).unref?.();

export function isReplay(secret: string, code: string): boolean {
  const k = `${secret}:${code}`;
  return used.has(k);
}

export function markUsed(secret: string, code: string): void {
  used.set(`${secret}:${code}`, Date.now());
}
