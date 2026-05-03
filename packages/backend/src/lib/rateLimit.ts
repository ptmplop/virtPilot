// Tiny in-memory rate limiter — sufficient for a single-instance VirtPilot
// install. Sliding window per key, dropped on process restart (acceptable
// because failed attempts also reset). For multi-instance deployments swap
// this for Redis or similar.

import type { Request, Response, NextFunction } from 'express';

interface Bucket {
  hits: number[];
  blockedUntil: number;
}

interface Options {
  windowMs: number;
  max: number;
  blockMs?: number;
  keyFn?: (req: Request) => string;
  message?: string;
  // When true, only successful (non-2xx) responses count. We default to false
  // because for /login we want to count *all* attempts; the auth route can
  // call .reset(key) on success to release the bucket.
  countSuccess?: boolean;
}

const stores = new Map<string, Map<string, Bucket>>();

function defaultKey(req: Request): string {
  return (req.ip ?? req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
}

export function createRateLimiter(name: string, opts: Options) {
  const store = new Map<string, Bucket>();
  stores.set(name, store);
  const blockMs = opts.blockMs ?? opts.windowMs;
  const keyFn = opts.keyFn ?? defaultKey;
  const message = opts.message ?? 'Too many requests';

  // Periodic GC so abandoned IPs don't keep the map growing.
  setInterval(() => {
    const now = Date.now();
    for (const [k, bucket] of store) {
      bucket.hits = bucket.hits.filter((t) => now - t < opts.windowMs);
      if (bucket.hits.length === 0 && bucket.blockedUntil < now) store.delete(k);
    }
  }, Math.max(opts.windowMs, 60_000)).unref?.();

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn(req);
    const now = Date.now();
    let bucket = store.get(key);
    if (!bucket) {
      bucket = { hits: [], blockedUntil: 0 };
      store.set(key, bucket);
    }
    if (now < bucket.blockedUntil) {
      const retryAfter = Math.ceil((bucket.blockedUntil - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: message, retryAfter });
      return;
    }
    bucket.hits = bucket.hits.filter((t) => now - t < opts.windowMs);
    if (bucket.hits.length >= opts.max) {
      bucket.blockedUntil = now + blockMs;
      const retryAfter = Math.ceil(blockMs / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: message, retryAfter });
      return;
    }
    bucket.hits.push(now);
    next();
  };

  const reset = (key: string): void => {
    store.delete(key);
  };

  return Object.assign(middleware, { reset, keyFor: keyFn });
}
