import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { config } from './config.js';
import { authRouter } from './routes/auth.js';
import { vmsRouter } from './routes/vms.js';
import { networksRouter } from './routes/networks.js';
import { templatesRouter } from './routes/templates.js';
import { isosRouter } from './routes/isos.js';
import { settingsRouter } from './routes/settings.js';
import { systemRouter } from './routes/system.js';
import { logsRouter } from './routes/logs.js';
import { devicesRouter } from './routes/devices.js';
import { sshKeysRouter } from './routes/sshKeys.js';
import { totpRouter } from './routes/totp.js';
import { backupsRouter } from './routes/backups.js';
import { requireAuth, verifyWsToken, isIpAllowed } from './middleware/auth.js';
import { getUserSettings } from './services/userSettingsService.js';
import { createConsoleWss } from './console.js';
import { createSshWss } from './ssh.js';
import { createVncWss } from './vnc.js';
import { ensureDirs } from './services/storageService.js';
import { applyAllRules } from './services/portForwardService.js';
import { startSampling } from './services/statsService.js';
import { startVmMetricsSampling } from './services/vmMetricsService.js';
import { startBackupScheduler } from './services/backupSchedulerService.js';
import { getDb } from './services/db.js';

const app = express();

// Trust the first proxy if running behind nginx/Caddy. Without this, req.ip is
// the proxy IP and rate-limit + ipWhitelist key off the wrong address.
app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : 1);

app.use(
  helmet({
    // CSP: keep self-only by default. The frontend bundle is served from the
    // same origin so no external script/style sources are required.
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        // Vite-built CSS includes inline styles (CSS-in-JS); keep style-src
        // permissive enough for that. Scripts stay strict.
        'style-src': ["'self'", "'unsafe-inline'"],
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

// CORS: same-origin by default. Operators can opt in to additional origins
// via ALLOWED_ORIGINS env var when the frontend is served from a different
// domain than the backend.
const allowedOrigins = new Set(config.allowedOrigins);
app.use(
  cors({
    origin(origin, cb) {
      // Same-origin / non-CORS request (no Origin header) — always allow.
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);
      cb(new Error('Origin not allowed'));
    },
    credentials: true,
  }),
);
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRouter);

app.use('/api/vms', requireAuth, vmsRouter);
app.use('/api/networks', requireAuth, networksRouter);
app.use('/api/templates', requireAuth, templatesRouter);
app.use('/api/isos', requireAuth, isosRouter);
app.use('/api/settings', requireAuth, settingsRouter);
app.use('/api/system', requireAuth, systemRouter);
app.use('/api/logs', requireAuth, logsRouter);
app.use('/api/devices', requireAuth, devicesRouter);
app.use('/api/ssh-keys', requireAuth, sshKeysRouter);
app.use('/api/2fa', requireAuth, totpRouter);
app.use('/api/backups', requireAuth, backupsRouter);

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

const consoleWss = createConsoleWss();
const sshWss = createSshWss();
const vncWss = createVncWss();

// WebSocket auth pulls the JWT from the Sec-WebSocket-Protocol header. The
// browser passes this when calling `new WebSocket(url, ['virtpilot.token.<jwt>'])`,
// so the token rides in HTTP headers rather than the URL — meaning it doesn't
// hit nginx access logs, browser history, or the `journalctl` HTTP log.
//
// Backwards-compat: we still accept the legacy `?token=` query param for now
// so the dashboard keeps working during the upgrade window. New connections
// from updated clients use the header form.
function extractWsToken(req: http.IncomingMessage): string | null {
  const protoHeader = req.headers['sec-websocket-protocol'];
  if (typeof protoHeader === 'string') {
    for (const proto of protoHeader.split(',').map((s) => s.trim())) {
      if (proto.startsWith('virtpilot.token.')) return proto.slice('virtpilot.token.'.length);
    }
  }
  const url = new URL(req.url ?? '', 'http://localhost');
  return url.searchParams.get('token');
}

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const token = extractWsToken(req);
  if (!verifyWsToken(token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const { ipWhitelist } = await getUserSettings();
  if (!isIpAllowed(req.socket.remoteAddress, ipWhitelist)) {
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
  startSampling();
  startVmMetricsSampling();
  startBackupScheduler();
  server.listen(config.port, config.bindAddress, () => {
    const proto = tlsAvailable ? 'https' : 'http';
    console.log(`VirtPilot backend listening on ${proto}://${config.bindAddress}:${config.port}`);
  });
}

main().catch(console.error);
