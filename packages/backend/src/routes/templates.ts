import { Router } from 'express';
import path from 'path';
import http from 'http';
import https from 'https';
import fs from 'fs';
import fsp from 'fs/promises';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import * as storageService from '../services/storageService.js';
import { saveUserSettings } from '../services/userSettingsService.js';

export const templatesRouter = Router();

const upload = multer({
  dest: config.templatesDir,
  limits: { fileSize: 100 * 1024 * 1024 * 1024 },
});

interface DownloadJob {
  filename: string;
  partPath: string;
  destPath: string;
  displayName?: string;
  bytesDownloaded: number;
  totalBytes: number;
  status: 'downloading' | 'done' | 'error' | 'cancelled';
  error?: string;
  abort: () => void;
}

const activeDownloads = new Map<string, DownloadJob>();

async function safeUnlink(p: string): Promise<void> {
  try { await fsp.unlink(p); } catch { /* ignore */ }
}

// If the upstream sends headers but then stops feeding bytes, abort the
// request so the job moves to error state instead of sitting forever. Picked
// generously because some mirrors throttle to a trickle but still progress.
const STALL_TIMEOUT_MS = 60_000;
// Guard against a mirror that accepts the connection but never sends headers
// — fail fast so the orchestrator can move on or retry.
const HEADERS_TIMEOUT_MS = 30_000;

function streamUrl(url: string, destPath: string, job: DownloadJob): Promise<void> {
  return new Promise((resolve, reject) => {
    let activeReq: http.ClientRequest | null = null;
    let activeFile: fs.WriteStream | null = null;
    let stallTimer: NodeJS.Timeout | null = null;
    let cancelled = false;

    const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };

    job.abort = () => {
      cancelled = true;
      clearStall();
      activeReq?.destroy(new Error('cancelled'));
      activeFile?.destroy();
    };

    const attempt = (attemptUrl: string) => {
      if (cancelled) { reject(new Error('cancelled')); return; }
      const client = attemptUrl.startsWith('https') ? https : http;
      activeReq = client.get(attemptUrl, (res) => {
        if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          attempt(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        job.totalBytes = parseInt(res.headers['content-length'] ?? '0', 10);
        const file = fs.createWriteStream(destPath);
        activeFile = file;
        // Reset the stall timer on every chunk; if it fires, the upstream
        // has gone silent and we should bail rather than hang the orchestrator.
        const armStall = () => {
          clearStall();
          stallTimer = setTimeout(() => {
            const err = new Error(`Upstream stalled — no bytes for ${STALL_TIMEOUT_MS / 1000}s`);
            activeReq?.destroy(err);
            reject(err);
          }, STALL_TIMEOUT_MS);
        };
        armStall();
        res.on('data', (chunk: Buffer) => { job.bytesDownloaded += chunk.length; armStall(); });
        res.pipe(file);
        file.on('finish', () => { clearStall(); file.close(); resolve(); });
        file.on('error', (err) => { clearStall(); reject(err); });
        res.on('error', (err) => { clearStall(); reject(err); });
      }).on('error', (err) => { clearStall(); reject(err); });
      // Headers must arrive within HEADERS_TIMEOUT_MS or we treat the upstream
      // as dead. setTimeout on the request fires only on socket inactivity,
      // which is exactly what we want here.
      activeReq.setTimeout(HEADERS_TIMEOUT_MS, () => {
        const err = new Error(`Upstream did not send headers within ${HEADERS_TIMEOUT_MS / 1000}s`);
        activeReq?.destroy(err);
        reject(err);
      });
    };
    attempt(url);
  });
}

templatesRouter.get('/', async (_req, res) => {
  try {
    const templates = await storageService.listTemplates();
    res.json({ templates });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

templatesRouter.post('/upload', upload.single('file'), async (req, res) => {
  const tempPath = req.file?.path;
  req.on('aborted', () => { if (tempPath) safeUnlink(tempPath); });
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const originalName = req.file.originalname;
    const destPath = path.join(config.templatesDir, originalName);
    await fsp.rename(req.file.path, destPath);
    const displayName = (req.body as Record<string, string>).name?.trim();
    if (displayName) {
      await storageService.setTemplateDisplayName(originalName, displayName);
    }
    res.json({ filename: originalName });
  } catch (err: unknown) {
    if (tempPath) await safeUnlink(tempPath);
    res.status(500).json({ error: String(err) });
  }
});

templatesRouter.post('/download', async (req, res) => {
  const { url, filename, name } = req.body as { url?: string; filename?: string; name?: string };
  if (!url) return res.status(400).json({ error: 'url is required' });

  let savedFilename: string;
  try {
    savedFilename = filename?.trim() || path.basename(new URL(url).pathname) || `template-${Date.now()}.qcow2`;
    // Accept the common cloud-image and installer-image extensions. Anything
    // else gets `.qcow2` appended as a safe default for the templates dir.
    if (!savedFilename.match(/\.(qcow2|img|raw|iso|iso\.gz)$/)) savedFilename += '.qcow2';
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const jobId = randomUUID();
  const destPath = path.join(config.templatesDir, savedFilename);
  const partPath = `${destPath}.part`;
  const job: DownloadJob = {
    filename: savedFilename,
    partPath,
    destPath,
    displayName: name?.trim() || undefined,
    bytesDownloaded: 0,
    totalBytes: 0,
    status: 'downloading',
    abort: () => { /* replaced once stream starts */ },
  };
  activeDownloads.set(jobId, job);

  res.json({ jobId, filename: savedFilename });

  // Log to stderr so failures are visible via `journalctl -u virtpilot`. The
  // request itself doesn't go through any per-request middleware that records
  // these, and the absence of a trail made the v1.19.1/.2 bulk failures hard
  // to diagnose without backend visibility.
  const startedAt = Date.now();
  console.log(`[template-download] start jobId=${jobId} file=${savedFilename} url=${url}`);

  streamUrl(url, partPath, job)
    .then(async () => {
      await fsp.rename(partPath, destPath);
      job.status = 'done';
      if (job.displayName) {
        await storageService.setTemplateDisplayName(job.filename, job.displayName);
      }
      const durationS = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`[template-download] done  jobId=${jobId} file=${savedFilename} bytes=${job.bytesDownloaded} duration=${durationS}s`);
    })
    .catch(async (err) => {
      await safeUnlink(partPath);
      if (String(err.message ?? err) === 'cancelled') {
        job.status = 'cancelled';
        console.log(`[template-download] cancel jobId=${jobId} file=${savedFilename}`);
      } else {
        job.status = 'error';
        job.error = String(err);
        const durationS = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.error(`[template-download] error jobId=${jobId} file=${savedFilename} duration=${durationS}s err=${String(err)}`);
      }
    })
    .finally(() => { setTimeout(() => activeDownloads.delete(jobId), 60_000); });
});

templatesRouter.get('/download/:jobId', (req, res) => {
  const job = activeDownloads.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or already completed' });
  res.json({
    filename: job.filename,
    bytesDownloaded: job.bytesDownloaded,
    totalBytes: job.totalBytes,
    status: job.status,
    error: job.error,
  });
});

templatesRouter.delete('/download/:jobId', (req, res) => {
  const job = activeDownloads.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or already completed' });
  if (job.status === 'downloading') job.abort();
  res.json({ ok: true });
});

templatesRouter.patch('/:filename', async (req, res) => {
  try {
    const { name } = req.body as { name?: string };
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    await storageService.setTemplateDisplayName(req.params.filename, name.trim());
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

templatesRouter.delete('/:filename', async (req, res) => {
  try {
    await storageService.deleteTemplate(req.params.filename);
    // If that delete emptied the templates directory, clear the starter-set
    // dismissal so the card resurfaces on the next page load — handy for
    // someone wiping their templates and starting over.
    const remaining = await storageService.listTemplates();
    if (remaining.length === 0) {
      await saveUserSettings({ templateSetDismissed: false });
    }
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});
