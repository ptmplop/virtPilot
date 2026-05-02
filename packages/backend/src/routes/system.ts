import { spawn } from 'child_process';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { Router } from 'express';
import { config, VERSION } from '../config.js';
import { listPhysicalNics } from '../services/networkService.js';
import { getHistory, takeSample } from '../services/statsService.js';
import * as logService from '../services/logService.js';

const execAsync = promisify(exec);
export const systemRouter = Router();

const GITHUB_REPO = 'ptmplop/virtPilot';
const EXPECTED_REMOTE_PATTERNS = [
  'github.com/ptmplop/virtPilot',
  'github.com:ptmplop/virtPilot',
];
const UPDATE_UNIT = 'virtpilot-update';

systemRouter.get('/info', async (_req, res) => {
  try {
    const [cpuRaw, loadRaw] = await Promise.all([
      fs.readFile('/proc/cpuinfo', 'utf8'),
      fs.readFile('/proc/loadavg', 'utf8'),
    ]);

    const modelMatch = cpuRaw.match(/^model name\s*:\s*(.+)$/m);
    const cpuModel = modelMatch ? modelMatch[1].trim() : 'Unknown';

    // Count distinct physical-id+core-id pairs; fall back to logical count
    const cores = new Set<string>();
    for (const block of cpuRaw.split('\n\n')) {
      const phys = block.match(/^physical id\s*:\s*(\d+)/m)?.[1];
      const core = block.match(/^core id\s*:\s*(\d+)/m)?.[1];
      if (phys !== undefined && core !== undefined) cores.add(`${phys}-${core}`);
    }
    const cpuCores = cores.size > 0 ? cores.size : (cpuRaw.match(/^processor\s*:/gm) ?? []).length;

    const loadParts = loadRaw.trim().split(/\s+/);
    const load: [number, number, number] = [
      parseFloat(loadParts[0] ?? '0'),
      parseFloat(loadParts[1] ?? '0'),
      parseFloat(loadParts[2] ?? '0'),
    ];

    let kernelVersion = 'unknown';
    try {
      const { stdout } = await execAsync('uname -r', { timeout: 3000 });
      kernelVersion = stdout.trim();
    } catch { /* non-Linux or restricted */ }

    res.json({ hostname: os.hostname(), cpuModel, cpuCores, load, kernelVersion });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

systemRouter.get('/nics', async (_req, res) => {
  try {
    const nics = await listPhysicalNics();
    res.json({ nics });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

systemRouter.get('/stats', async (_req, res) => {
  try {
    const current = await takeSample();
    const history = getHistory();
    res.json({ current, history });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

systemRouter.get('/apt', async (_req, res) => {
  try {
    const { stdout } = await execAsync('apt list --upgradable 2>/dev/null', { timeout: 15_000 });
    const packages = stdout
      .split('\n')
      .filter((l) => l.includes('/'))
      .map((l) => {
        const m = l.match(/^([^/]+)\/\S+\s+(\S+)\s+(\S+)\s+\[upgradable from: ([^\]]+)\]/);
        if (!m) return null;
        return { name: m[1], version: m[2], arch: m[3], currentVersion: m[4] };
      })
      .filter(Boolean);
    res.json({ packages });
  } catch {
    // apt not available or timed out
    res.json({ packages: [] });
  }
});

interface UpgradeEvent { type: string; text: string }
interface UpgradeJob {
  buffer: UpgradeEvent[];
  done: boolean;
  exitCode: number | null;
  listeners: Set<(e: UpgradeEvent) => void>;
}

let currentUpgrade: UpgradeJob | null = null;

systemRouter.get('/apt/upgrade', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const write = (type: string, text: string) =>
    res.write(`data: ${JSON.stringify({ type, text })}\n\n`);

  // Start a new job only if none is active
  if (!currentUpgrade || currentUpgrade.done) {
    const job: UpgradeJob = { buffer: [], done: false, exitCode: null, listeners: new Set() };
    currentUpgrade = job;

    const start = Date.now();
    const emit = (type: string, text: string) => {
      job.buffer.push({ type, text });
      for (const l of job.listeners) l({ type, text });
    };

    const proc = spawn('apt-get', ['-y', 'upgrade'], {
      env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive', PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
    });

    proc.stdout.on('data', (chunk: Buffer) => emit('out', chunk.toString()));
    proc.stderr.on('data', (chunk: Buffer) => emit('err', chunk.toString()));
    proc.on('close', (code) => {
      job.done = true;
      job.exitCode = code ?? 1;
      emit('done', String(job.exitCode));
      void logService.appendLog({
        type: 'system.apt.upgrade',
        subject: 'host',
        status: code === 0 ? 'success' : 'error',
        output: job.buffer.filter((e) => e.type !== 'done').map((e) => e.text).join('').slice(0, 50_000),
        durationMs: Date.now() - start,
      });
    });
    proc.on('error', (err) => {
      job.done = true;
      job.exitCode = 1;
      emit('err', `Failed to start upgrade: ${err.message}\n`);
      emit('done', '1');
      void logService.appendLog({
        type: 'system.apt.upgrade',
        subject: 'host',
        status: 'error',
        output: job.buffer.filter((e) => e.type !== 'done').map((e) => e.text).join(''),
        durationMs: Date.now() - start,
      });
    });
  }

  const job = currentUpgrade;

  // Replay buffered output to this client
  for (const event of job.buffer) write(event.type, event.text);

  if (job.done) { res.end(); return; }

  // Subscribe to live events
  const listener = (event: UpgradeEvent) => {
    write(event.type, event.text);
    if (event.type === 'done') res.end();
  };
  job.listeners.add(listener);
  req.on('close', () => job.listeners.delete(listener));
});

// ─── VirtPilot self-upgrade ──────────────────────────────────────────────────

interface CachedRelease {
  tag: string;
  version: string;
  body: string;
  htmlUrl: string;
  publishedAt: string;
  fetchedAt: number;
}

let releaseCache: CachedRelease | null = null;
const RELEASE_CACHE_TTL_MS = 10 * 60 * 1000;

async function getLatestRelease(force = false): Promise<CachedRelease | null> {
  if (!force && releaseCache && Date.now() - releaseCache.fetchedAt < RELEASE_CACHE_TTL_MS) {
    return releaseCache;
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'virtpilot' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return releaseCache;
    const data = (await res.json()) as {
      tag_name?: string; body?: string; html_url?: string; published_at?: string;
    };
    if (!data.tag_name) return releaseCache;
    releaseCache = {
      tag: data.tag_name,
      version: data.tag_name.replace(/^v/, ''),
      body: data.body ?? '',
      htmlUrl: data.html_url ?? '',
      publishedAt: data.published_at ?? '',
      fetchedAt: Date.now(),
    };
    return releaseCache;
  } catch {
    return releaseCache;
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

async function inspectRepo(): Promise<{ ok: boolean; reason?: string; remoteUrl?: string }> {
  try {
    await fs.access(path.join(config.repoDir, '.git'));
  } catch {
    return { ok: false, reason: `No .git directory at ${config.repoDir}` };
  }
  try {
    const { stdout } = await execAsync('git remote get-url origin', {
      cwd: config.repoDir, timeout: 5_000,
    });
    const url = stdout.trim();
    const matches = EXPECTED_REMOTE_PATTERNS.some((p) => url.includes(p));
    if (!matches) return { ok: false, reason: `Unexpected git remote: ${url}`, remoteUrl: url };
    return { ok: true, remoteUrl: url };
  } catch (err) {
    return { ok: false, reason: `git remote check failed: ${String(err)}` };
  }
}

systemRouter.get('/version', async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  const [latest, repo] = await Promise.all([getLatestRelease(force), inspectRepo()]);
  const updateAvailable = !!latest && compareVersions(latest.version, VERSION) > 0;
  res.json({
    current: VERSION,
    latest: latest?.version ?? null,
    latestTag: latest?.tag ?? null,
    releaseUrl: latest?.htmlUrl ?? null,
    releaseNotes: latest?.body ?? null,
    publishedAt: latest?.publishedAt ?? null,
    updateAvailable,
    repoOk: repo.ok,
    repoReason: repo.reason ?? null,
    repoPath: config.repoDir,
  });
});

// SSE upgrade endpoint. Spawns update.sh inside a transient systemd unit
// (`virtpilot-update.service`) so it escapes virtpilot.service's cgroup and
// survives the `systemctl restart virtpilot` that update.sh issues at the end.
// We tail `journalctl -fu` to stream output. Multiple clients can attach and
// will see the same live output.
systemRouter.get('/upgrade', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const write = (type: string, text: string) =>
    res.write(`data: ${JSON.stringify({ type, text })}\n\n`);

  let closed = false;
  const safeEnd = () => { if (!closed) { closed = true; res.end(); } };

  const repo = await inspectRepo();
  if (!repo.ok) {
    write('err', `Cannot upgrade: ${repo.reason}\n`);
    write('done', '1');
    safeEnd();
    return;
  }

  // Clear any prior failed state
  try { await execAsync(`systemctl reset-failed ${UPDATE_UNIT}.service`); } catch { /* may not exist */ }

  const isActive = await execAsync(`systemctl is-active ${UPDATE_UNIT}.service`)
    .then(() => true).catch(() => false);

  const start = Date.now();
  if (!isActive) {
    write('meta', `Starting upgrade in transient unit ${UPDATE_UNIT}…\n`);
    const updateScript = path.join(config.repoDir, 'update.sh');
    try {
      await execAsync(
        `systemd-run --unit=${UPDATE_UNIT} --collect --no-block ` +
        `--property=Type=oneshot --property=StandardOutput=journal ` +
        `--property=StandardError=journal --property=WorkingDirectory=${config.repoDir} ` +
        `bash ${updateScript}`,
        { timeout: 10_000 },
      );
    } catch (err) {
      write('err', `Failed to start upgrade: ${String(err)}\n`);
      write('done', '1');
      safeEnd();
      return;
    }
  } else {
    write('meta', `Upgrade already in progress — attaching to live output…\n`);
  }

  // Stream the unit's journal
  const tail = spawn('journalctl', ['-fu', `${UPDATE_UNIT}.service`, '-n', 'all', '-o', 'cat'], {
    env: { ...process.env, PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
  });
  tail.stdout.on('data', (chunk: Buffer) => write('out', chunk.toString()));
  tail.stderr.on('data', (chunk: Buffer) => write('err', chunk.toString()));

  // Poll the unit's state — when it goes inactive, emit `done` with exit code
  const poll = setInterval(async () => {
    if (closed) return;
    try {
      await execAsync(`systemctl is-active ${UPDATE_UNIT}.service`);
      // still active
    } catch {
      // Inactive — read exit status, then close
      clearInterval(poll);
      let exitCode = 0;
      try {
        const { stdout } = await execAsync(
          `systemctl show -p ExecMainStatus --value ${UPDATE_UNIT}.service`,
        );
        exitCode = parseInt(stdout.trim(), 10) || 0;
      } catch { /* keep 0 */ }
      // Allow journalctl 1s to drain final output
      setTimeout(() => {
        if (!closed) {
          write('done', String(exitCode));
          tail.kill();
          safeEnd();
        }
      }, 1000);
      void logService.appendLog({
        type: 'system.virtpilot.upgrade',
        subject: 'host',
        status: exitCode === 0 ? 'success' : 'error',
        output: `Upgrade unit ${UPDATE_UNIT} exited ${exitCode}`,
        durationMs: Date.now() - start,
      });
    }
  }, 2_000);

  req.on('close', () => {
    closed = true;
    clearInterval(poll);
    tail.kill();
  });
});
