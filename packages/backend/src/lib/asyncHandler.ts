// Express 4 does NOT forward a rejected promise from an async middleware or
// handler to the error middleware — the rejection is dropped, no response is
// ever written, and the request hangs until the reverse proxy times out. (The
// process-level `unhandledRejection` handler logs it but keeps the daemon
// "healthy", so nothing recovers on its own.)
//
// Wrapping a handler here routes its rejection to `next(err)`, which the
// app-level error handler in index.ts turns into a real 500. Express 5 does
// this natively; this module can be deleted when we upgrade.

import type { NextFunction, Request, RequestHandler, Response } from 'express';

type MaybeAsyncHandler = (req: Request, res: Response, next: NextFunction) => unknown;

// Marks an already-wrapped function so mounting the same router twice (or
// wrapping a router that contains an already-wrapped handler) is a no-op.
const WRAPPED = Symbol.for('virtpilot.asyncWrapped');

function isWrapped(fn: unknown): boolean {
  return Boolean((fn as Record<symbol, unknown> | null)?.[WRAPPED]);
}

export function asyncHandler(fn: MaybeAsyncHandler): RequestHandler {
  if (isWrapped(fn)) return fn as RequestHandler;
  const wrapped: RequestHandler = (req, res, next) => {
    let out: unknown;
    try {
      out = fn(req, res, next);
    } catch (err) {
      // Synchronous throw before the first await.
      next(err);
      return;
    }
    if (out && typeof (out as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(out as PromiseLike<unknown>).catch(next);
    }
  };
  (wrapped as unknown as Record<symbol, boolean>)[WRAPPED] = true;
  return wrapped;
}

// Express's Layer internals we rely on. Deliberately narrow and optional so a
// shape change degrades to "leave it alone" rather than a boot-time crash.
interface RouterLayer {
  handle?: unknown;
  route?: { stack?: RouterLayer[] } | null;
}

interface RouterLike {
  stack?: RouterLayer[];
}

/**
 * Wrap every handler registered on a Router (and any sub-routers) so the whole
 * class of "async handler rejects → hung request" is closed at the mount
 * boundary, rather than relying on every route file remembering to wrap.
 * Returns the same router instance — the wrapping is in-place.
 */
export function wrapRouterAsync<T>(router: T): T {
  const stack = (router as unknown as RouterLike | undefined)?.stack;
  if (!Array.isArray(stack)) return router;
  for (const layer of stack) wrapLayer(layer);
  return router;
}

function wrapLayer(layer: RouterLayer): void {
  // A route layer holds the actual method handlers one level down.
  const routeStack = layer.route?.stack;
  if (Array.isArray(routeStack)) {
    for (const inner of routeStack) wrapLayer(inner);
    return;
  }
  const handle = layer.handle;
  if (typeof handle !== 'function') return;
  // Arity 4 is error middleware — wrapping it to arity 3 would change how
  // Express dispatches it, so leave it alone.
  if (handle.length === 4) return;
  // A mounted sub-router is itself a function carrying a `stack`; recurse
  // instead of wrapping, or its own layers would never be reached.
  if (Array.isArray((handle as unknown as RouterLike).stack)) {
    wrapRouterAsync(handle);
    return;
  }
  if (isWrapped(handle)) return;
  layer.handle = asyncHandler(handle as unknown as MaybeAsyncHandler);
}
