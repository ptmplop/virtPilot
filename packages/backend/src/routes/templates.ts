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
import * as storageDirService from '../services/storageDirService.js';
import type { StorageDir } from '../services/storageDirService.js';
import * as vmMetaService from '../services/vmMetaService.js';
import { saveUserSettings } from '../services/userSettingsService.js';
import { assertSafeDownloadUrl } from '../lib/safeUrl.js';
import { validateFilename } from '../lib/validate.js';

// Some mirrors (notably cloud.centos.org) reject requests with no User-Agent
// header — Node's http.get sends none by default, which silently 403s every
// download attempt. Identify ourselves so we play nice with mirror operators
// and so the failure is traceable in their access logs if anything goes wrong.
const USER_AGENT = 'VirtPilot/1.19.4 (+https://github.com/ptmplop/virtPilot)';

export const templatesRouter = Router();

// Uploads stream into a scratch dir on the local system root; the route
// handler then moves the file into the storage dir the operator picked. This
// avoids multer's form-field-ordering pitfall (the destination resolver
// fires before req.body is fully populated, so reading storageDirId from
// inside it isn't reliable).
const SCRATCH_DIR = path.join(config.storageRoot, '.uploads');

const upload = multer({
  dest: SCRATCH_DIR,
  limits: { fileSize: 100 * 1024 * 1024 * 1024 },
});

async function resolveTemplatesUploadDir(storageDirIdRaw: unknown): Promise<StorageDir> {
  const id = typeof storageDirIdRaw === 'string' ? storageDirIdRaw.trim() : '';
  let dir: StorageDir | null;
  if (id) {
    dir = await storageDirService.getDir(id);
    if (!dir) throw new Error(`Storage directory ${id} not found`);
  } else {
    dir = await storageDirService.getDefaultDirFor('templates');
    if (!dir) throw new Error('No templates storage directory configured');
  }
  if (!dir.purposes.includes('templates')) {
    throw new Error(`Storage directory "${dir.name}" is not flagged for templates`);
  }
  const subdir = storageDirService.getTemplatesSubdir(dir);
  await fsp.mkdir(subdir, { recursive: true });
  await fsp.chmod(subdir, 0o770).catch(() => {});
  return dir;
}

// fs.rename throws EXDEV when source and destination are on different mounts
// (the storage dir might be NFS/iSCSI on a separate filesystem from the
// scratch dir). Fall back to a copy+unlink in that case.
async function moveCrossFs(src: string, dest: string): Promise<void> {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fsp.copyFile(src, dest);
    await fsp.unlink(src);
  }
}

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

    let redirectsLeft = 5;
    const attempt = (attemptUrl: string) => {
      if (cancelled) { reject(new Error('cancelled')); return; }
      let safeUrl: URL;
      try {
        safeUrl = assertSafeDownloadUrl(attemptUrl);
      } catch (err) {
        reject(err);
        return;
      }
      const client = safeUrl.protocol === 'https:' ? https : http;
      activeReq = client.get(safeUrl.toString(), { headers: { 'User-Agent': USER_AGENT } }, (res) => {
        if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirectsLeft-- <= 0) { reject(new Error('Too many redirects')); return; }
          // Re-validate every redirect target.
          attempt(new URL(res.headers.location, safeUrl).toString());
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
    // Strip directory components from originalname — multer preserves whatever
    // the client sent, including "../../etc/cron.d/x".
    const originalName = path.basename(req.file.originalname);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(qcow2|img|raw|iso)$/i.test(originalName)) {
      return res.status(400).json({ error: 'Invalid template filename' });
    }
    const body = req.body as Record<string, string>;
    const targetDir = await resolveTemplatesUploadDir(body.storageDirId);
    const destPath = path.join(storageDirService.getTemplatesSubdir(targetDir), originalName);
    await moveCrossFs(req.file.path, destPath);
    const displayName = body.name?.trim();
    if (displayName) {
      await storageService.setTemplateDisplayName(originalName, displayName);
    }
    res.json({ filename: originalName, storageDirId: targetDir.id });
  } catch (err: unknown) {
    if (tempPath) await safeUnlink(tempPath);
    res.status(500).json({ error: String(err) });
  }
});

templatesRouter.post('/download', async (req, res) => {
  const { url, filename, name, storageDirId } = req.body as { url?: string; filename?: string; name?: string; storageDirId?: string };
  if (!url) return res.status(400).json({ error: 'url is required' });

  let savedFilename: string;
  try {
    // Validate the URL up-front so we never construct a destination path
    // from a server-side fetch that's going to be rejected anyway.
    const parsed = assertSafeDownloadUrl(url);
    const fromQuery = filename?.trim() ? path.basename(filename.trim()) : '';
    savedFilename = fromQuery || path.basename(parsed.pathname) || `template-${Date.now()}.qcow2`;
    // Accept the common cloud-image and installer-image extensions. Anything
    // else gets `.qcow2` appended as a safe default for the templates dir.
    if (!savedFilename.match(/\.(qcow2|img|raw|iso|iso\.gz)$/)) savedFilename += '.qcow2';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(qcow2|img|raw|iso|iso\.gz)$/i.test(savedFilename)) {
      throw new Error('Invalid filename');
    }
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid URL' });
  }

  let targetDir: StorageDir;
  try {
    targetDir = await resolveTemplatesUploadDir(storageDirId);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }

  const jobId = randomUUID();
  const destPath = path.join(storageDirService.getTemplatesSubdir(targetDir), savedFilename);
  // Stream into the storage dir's own subfolder; if the mount is healthy a
  // `.part` rename is atomic on the same filesystem. If it isn't, the storage
  // dir is unusable anyway and we want the failure surfaced early.
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

  res.json({ jobId, filename: savedFilename, storageDirId: targetDir.id });

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

// Move a template to a different storage dir. Refuses the move if any VM was
// created from this template — the qcow2 backing-chain reference is encoded
// at create time as the absolute template path, so moving the template would
// silently break those VMs at next start.
templatesRouter.post('/:filename/move', async (req, res) => {
  try {
    const filename = validateFilename(req.params.filename);
    const { storageDirId } = req.body as { storageDirId?: string };
    if (typeof storageDirId !== 'string' || !storageDirId) {
      return res.status(400).json({ error: 'storageDirId is required' });
    }
    const metas = await vmMetaService.listVmMetas();
    const referencing = metas.filter((m) => m.sourceTemplateFilename === filename);
    if (referencing.length > 0) {
      return res.status(409).json({
        error:
          `Cannot move "${filename}": it is the source template for ${referencing.length} VM(s) ` +
          `(${referencing.map((m) => m.name).join(', ')}). Delete those VMs first.`,
      });
    }
    const result = await storageService.moveTemplate(filename, storageDirId);
    res.json({
      ok: true,
      filename,
      from: { id: result.fromDir.id, name: result.fromDir.name },
      to: { id: result.toDir.id, name: result.toDir.name },
    });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

templatesRouter.patch('/:filename', async (req, res) => {
  try {
    const filename = validateFilename(req.params.filename);
    const { name } = req.body as { name?: string };
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    await storageService.setTemplateDisplayName(filename, name.trim());
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

templatesRouter.delete('/:filename', async (req, res) => {
  try {
    const filename = validateFilename(req.params.filename);
    await storageService.deleteTemplate(filename);
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
