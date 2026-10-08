import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { config } from './config.js';
import { authRouter } from './routes/auth.js';
import { vmsRouter } from './routes/vms.js';
import { networksRouter } from './routes/networks.js';
import { templatesRouter } from './routes/templates.js';
import { isosRouter } from './routes/isos.js';
import { storageRouter } from './routes/storage.js';
import { settingsRouter } from './routes/settings.js';
import { systemRouter } from './routes/system.js';
import { logsRouter } from './routes/logs.js';
import { devicesRouter } from './routes/devices.js';
import { sshKeysRouter } from './routes/sshKeys.js';
import { totpRouter } from './routes/totp.js';
import { backupsRouter } from './routes/backups.js';
import { downloadsRouter } from './routes/downloads.js';
import { requireAuth, verifyWsToken, isIpAllowed } from './middleware/auth.js';
import { asyncHandler, wrapRouterAsync } from './lib/asyncHandler.js';
import { getUserSettings } from './services/userSettingsService.js';
import { createConsoleWss } from './console.js';
import { createSshWss } from './ssh.js';
import { createVncWss } from './vnc.js';
import { ensureDirs } from './services/storageService.js';
import { seedDefault as seedDefaultStorageDir } from './services/storageDirService.js';
import { applyAllRules } from './services/portForwardService.js';
import { startSampling } from './services/statsService.js';
import { startVmMetricsSampling } from './services/vmMetricsService.js';
import { startBackupScheduler } from './services/backupSchedulerService.js';
import { getDb } from './services/db.js';

const app = express();

// How many proxy hops to trust for X-Forwarded-For.
//
// Trusting one hop unconditionally was a real hole: an install listening on a
// routable address with no reverse proxy would take X-Forwarded-For straight
// from the client, defeating login/TOTP rate limiting and the IP allowlist with
// one header. But refusing to trust anything unless TRUST_PROXY is set is just
// as broken in the other direction — it locks operators out of nginx-fronted
// installs, because every request then resolves to 127.0.0.1 and an IP
// allowlist matches nobody.
//
// The bind address settles it without guessing. A backend bound to loopback is
// unreachable from the network, so the only thing that can deliver a request —
// and therefore the only thing that can set X-Forwarded-For — is a proxy on
// this host. Trusting one hop there is safe. A routable bind might be exposed
// directly, so it trusts nothing until the operator says otherwise.
//
// TRUST_PROXY always wins when set. A malformed value (TRUST_PROXY=yes → NaN)
// or a negative count is treated as untrusted rather than silently trusting.
function isLoopbackBind(addr: string): boolean {
  return addr === 'localhost' || addr === '::1' || /^127\./.test(addr);
}
function trustedProxyHops(): number {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === '') return isLoopbackBind(config.bindAddress) ? 1 : 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}
const trustProxyHops = trustedProxyHops();
app.set('trust proxy', trustProxyHops > 0 ? trustProxyHops : false);

if (!process.env.TRUST_PROXY && !isLoopbackBind(config.bindAddress)) {
  console.warn(
    `[startup] TRUST_PROXY is unset and BIND_ADDRESS=${config.bindAddress} — X-Forwarded-For is ignored, ` +
    'so rate limiting and the IP allowlist use the direct connection address. ' +
    'If a reverse proxy fronts VirtPilot, set TRUST_PROXY=1 in .env.',
  );
}

app.use(
  helmet({
    // CSP: everything same-origin. Fonts are bundled with the SPA (no font CDN —
    // installs are often air-gapped, and a CDN is a third party seeing every
    // dashboard load). Connect-src is locked to same-origin (HTTP + WS) so a
    // compromised script can't exfiltrate to an attacker-controlled host.
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'style-src-elem': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'connect-src': ["'self'", 'ws:', 'wss:'],
        'font-src': ["'self'", 'data:'],
        'object-src': ["'none'"],
        'frame-ancestors': ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

// CORS: explicitly allow same-origin (the browser sends an Origin header for
// `<script crossorigin>` tags even on same-origin pages, and we serve the SPA
// from the backend itself). Cross-origin is gated on ALLOWED_ORIGINS.
const allowedOrigins = new Set(config.allowedOrigins);
function isSameOrigin(originHeader: string | string[] | undefined, host: string | undefined): boolean {
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (!origin || !host) return false;
  try {
    // Compare hostnames only — nginx's `proxy_set_header Host $host` strips
    // the port, so the backend would see "89.167.48.215" while the Origin URL
    // still says "89.167.48.215:3001". Comparing hostname dodges that.
    const originHost = new URL(origin).hostname;
    const reqHost = host.split(':')[0];
    return originHost === reqHost;
  } catch {
    return false;
  }
}
app.use((req, res, next) => {
  const sameOrigin = isSameOrigin(req.headers.origin, req.headers.host);
  return cors({
    origin(origin, cb) {
      // No Origin header (non-CORS request, e.g. same-origin GET without
      // crossorigin attr) — allow.
      if (!origin) return cb(null, true);
      // Browser-recognised same-origin — always allow regardless of allowlist.
      if (sameOrigin) return cb(null, true);
      // Cross-origin must be on the explicit allowlist.
      if (allowedOrigins.has(origin)) return cb(null, true);
      cb(new Error(`Origin not allowed: ${origin}`));
    },
    credentials: true,
  })(req, res, next);
});
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// Every router is mounted through wrapRouterAsync and requireAuth through
// asyncHandler, so a rejected async handler reaches the error middleware below
// instead of silently hanging the request (see lib/asyncHandler.ts). Doing it
// at the mount boundary closes the whole class in one place rather than
// depending on each route file remembering to wrap.
const auth = asyncHandler(requireAuth);

app.use('/api/auth', wrapRouterAsync(authRouter));

app.use('/api/vms', auth, wrapRouterAsync(vmsRouter));
app.use('/api/networks', auth, wrapRouterAsync(networksRouter));
app.use('/api/templates', auth, wrapRouterAsync(templatesRouter));
app.use('/api/isos', auth, wrapRouterAsync(isosRouter));
app.use('/api/storage', auth, wrapRouterAsync(storageRouter));
app.use('/api/settings', auth, wrapRouterAsync(settingsRouter));
app.use('/api/system', auth, wrapRouterAsync(systemRouter));
app.use('/api/logs', auth, wrapRouterAsync(logsRouter));
app.use('/api/devices', auth, wrapRouterAsync(devicesRouter));
app.use('/api/ssh-keys', auth, wrapRouterAsync(sshKeysRouter));
app.use('/api/2fa', auth, wrapRouterAsync(totpRouter));
app.use('/api/backups', auth, wrapRouterAsync(backupsRouter));
// Disk downloads use signed tickets in the URL (issued by /api/vms/:uuid/disk-files/.../download-ticket)
// rather than the Bearer token — so the route is mounted outside requireAuth.
app.use('/api/downloads', wrapRouterAsync(downloadsRouter));

// Reject API paths that didn't match a router so the SPA fallback below
// doesn't return 200/HTML for unknown /api/ requests.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Serve built frontend in production
const frontendDist = path.resolve(__dirname, '../../frontend/dist');
app.use(
  express.static(frontendDist, {
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  }),
);
app.get('*', (_req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

// Last-resort error handler. Registered after every router *and* the SPA
// fallback because Express matches error middleware by registration order —
// anything registered later would never see these errors. A thrown handler
// (or a rejected async one, which Express 4 surfaces here only when the route
// forwards it) becomes a 500 instead of a hung socket. The stack goes to the
// journal, never to the client.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // A body the client sent in the wrong shape is the client's fault, not ours.
  // body-parser raises these before any route runs, so without this every
  // malformed request — a multipart upload posted as JSON, a truncated body —
  // came back as a 500 "Internal server error" and filled the journal with
  // "Unhandled error" stacks that look like a crash.
  const e = err as { type?: string; status?: number; statusCode?: number };
  const badBody = err instanceof SyntaxError && (e.status === 400 || e.statusCode === 400) && 'body' in (err as object);
  if (badBody || e.type === 'entity.parse.failed' || e.type === 'entity.too.large') {
    if (res.headersSent) return;
    const tooLarge = e.type === 'entity.too.large';
    res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'Request body is too large' : 'Request body could not be parsed',
    });
    return;
  }

  console.error('[express] Unhandled error:', err instanceof Error ? err.stack ?? err.message : err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

// Never let a stray rejection or throw take the daemon down: a killed process
// drops every live console/SSH/VNC session and any in-flight VM operation. Log
// with the full stack and keep serving — the request that caused it has already
// failed, but the rest of the install stays up.
// Flipped once the server is actually accepting connections. Until then a
// fault is a *boot* failure, and swallowing it is far worse than dying: the
// sampler intervals keep the event loop alive, so systemd reports
// `active (running)` with nothing listening and never restarts us.
let ready = false;

process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled promise rejection:', reason instanceof Error ? reason.stack ?? reason.message : reason);
  if (!ready) {
    console.error('[process] Rejection occurred before the server was listening — exiting so systemd can restart.');
    process.exit(1);
  }
});
process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught exception:', err.stack ?? err.message);
  if (!ready) {
    console.error('[process] Exception occurred before the server was listening — exiting so systemd can restart.');
    process.exit(1);
  }
});

// Run HTTPS when both cert files exist (production install path); otherwise
// fall back to HTTP for dev mode where the installer hasn't generated certs.
const tlsAvailable =
  fs.existsSync(config.tlsCertPath) && fs.existsSync(config.tlsKeyPath);
const server = tlsAvailable
  ? https.createServer(
      {
        cert: fs.readFileSync(config.tlsCertPath),
        key: fs.readFileSync(config.tlsKeyPath),
      },
      app,
    )
  : http.createServer(app);

// A listen failure (EADDRINUSE while the previous process releases the port
// during an update.sh restart, EACCES on a privileged port) has no other
// listener, so without this it reaches uncaughtException. Exit non-zero and
// let systemd's Restart=on-failure retry in a few seconds — staying up with a
// dead listener turns a self-healing transient into a permanent outage.
server.on('error', (err: Error) => {
  const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
  console.error(`[server] Fatal server error (${code}): ${err.message}`);
  process.exit(1);
});

const consoleWss = createConsoleWss();
const sshWss = createSshWss();
const vncWss = createVncWss();

// WebSocket auth pulls the JWT from the Sec-WebSocket-Protocol header. The
// browser passes this when calling `new WebSocket(url, ['virtpilot.token.<jwt>'])`,
// so the token rides in HTTP headers rather than the URL — meaning it doesn't
// hit nginx access logs, browser history, or the `journalctl` HTTP log.
//
// The legacy `?token=` query-string fallback was removed: it leaked tokens
// into proxy/CDN/journal logs and stuck around in browser history. Any
// dashboard build before v1.21.7 needs to refresh to use the header form.
function extractWsToken(req: http.IncomingMessage): string | null {
  const protoHeader = req.headers['sec-websocket-protocol'];
  if (typeof protoHeader === 'string') {
    for (const proto of protoHeader.split(',').map((s) => s.trim())) {
      if (proto.startsWith('virtpilot.token.')) return proto.slice('virtpilot.token.'.length);
    }
  }
  return null;
}

// Mirror Express's `trust proxy` behaviour for raw http upgrade events. The
// `app.set('trust proxy', N)` call only rewrites `req.ip` on Express requests
// — the IncomingMessage handed to the upgrade handler still reports the
// nginx loopback as `remoteAddress`. Without this, a non-empty ipWhitelist
// 403s every console/SSH/VNC WebSocket because 127.0.0.1 never matches a
// real client whitelist entry.
function clientIpFromUpgrade(req: http.IncomingMessage): string | undefined {
  const direct = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  const trust = trustProxyHops;
  if (trust < 1 || !direct) return direct;
  const header = req.headers['x-forwarded-for'];
  const chain = (typeof header === 'string' ? header : '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (chain.length === 0) return direct;
  // With `trust proxy=N`, Express skips N hops from the right (hop 0 is the
  // direct connection, hop k is chain[chain.length-k]) and reports the next
  // address. Clamps to chain[0] when the chain is shorter than the trust count.
  const idx = Math.max(0, chain.length - trust);
  return chain[idx] ?? direct;
}

// Anything that throws in here must still close the socket. There is no
// Express error middleware on the upgrade path: an escaping rejection leaves
// the raw TCP socket open waiting for a 101 that never arrives, and the
// console/SSH/VNC reconnect loop then leaks a socket and a file descriptor per
// retry, forever.
server.on('upgrade', async (req, socket, head) => {
  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    const token = extractWsToken(req);
    if (!verifyWsToken(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const { ipWhitelist } = await getUserSettings();
    if (!isIpAllowed(clientIpFromUpgrade(req), ipWhitelist)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const pathname = url.pathname;
    const handle = (wss: ReturnType<typeof createConsoleWss>) =>
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    if (pathname === '/ws/console') handle(consoleWss);
    else if (pathname === '/ws/ssh') handle(sshWss);
    else if (pathname === '/ws/vnc') handle(vncWss);
    else { socket.destroy(); }
  } catch (err) {
    console.error('[ws] Upgrade failed:', err instanceof Error ? err.stack ?? err.message : err);
    // Fail closed: the client gets a definitive status and the fd is released.
    if (socket.writable) socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    socket.destroy();
  }
});

async function main() {
  try {
    await ensureDirs();
  } catch (err) {
    console.warn('Could not initialise storage dirs:', err);
  }
  try {
    await applyAllRules();
  } catch (err) {
    console.warn('Could not apply port forward iptables rules:', err);
  }
  try {
    getDb();
  } catch (err) {
    console.warn('Could not initialise SQLite database:', err);
  }
  // Seed the default storage directory row pointing at config.storageRoot.
  // No-op once any rows exist (and after the first boot of v2.2+).
  try {
    await seedDefaultStorageDir();
  } catch (err) {
    console.warn('Could not seed default storage directory:', err);
  }
  startSampling();
  startVmMetricsSampling();
  startBackupScheduler();
  server.listen(config.port, config.bindAddress, () => {
    // Boot is done — from here on, request-scoped faults are logged and
    // swallowed rather than taking every live console/SSH/VNC session with them.
    ready = true;
    const proto = tlsAvailable ? 'https' : 'http';
    console.log(`VirtPilot backend listening on ${proto}://${config.bindAddress}:${config.port}`);
  });
}

// Same reasoning as the uncaughtException gate: if boot itself fails we must
// exit non-zero, because the sampler intervals would otherwise hold the
// process open with no listener and systemd would never restart it.
main().catch((err) => {
  console.error('[startup] Boot failed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
