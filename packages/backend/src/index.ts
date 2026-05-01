import http from 'http';
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
import { startBackupScheduler } from './services/backupSchedulerService.js';

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
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

// Serve built frontend in production
const frontendDist = path.resolve(__dirname, '../../frontend/dist');
app.use(express.static(frontendDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

const server = http.createServer(app);

const consoleWss = createConsoleWss();
const sshWss = createSshWss();
const vncWss = createVncWss();

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const token = url.searchParams.get('token');
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
  if (pathname === '/ws/console') {
    consoleWss.handleUpgrade(req, socket, head, (ws) => consoleWss.emit('connection', ws, req));
  } else if (pathname === '/ws/ssh') {
    sshWss.handleUpgrade(req, socket, head, (ws) => sshWss.emit('connection', ws, req));
  } else if (pathname === '/ws/vnc') {
    vncWss.handleUpgrade(req, socket, head, (ws) => vncWss.emit('connection', ws, req));
  } else {
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
  startSampling();
  startBackupScheduler();
  server.listen(config.port, () => {
    console.log(`VirtPilot backend listening on port ${config.port}`);
  });
}

main().catch(console.error);
