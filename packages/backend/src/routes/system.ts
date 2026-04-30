import { spawn } from 'child_process';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import { Router } from 'express';
import { listPhysicalNics } from '../services/networkService.js';
import { getHistory, takeSample } from '../services/statsService.js';
import * as logService from '../services/logService.js';

const execAsync = promisify(exec);
export const systemRouter = Router();

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
