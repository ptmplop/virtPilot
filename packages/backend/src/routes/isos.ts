import { Router } from 'express';
import path from 'path';
import http from 'http';
import https from 'https';
import fs from 'fs';
import fsp from 'fs/promises';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import multer from 'multer';
import * as tar from 'tar';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import * as storageService from '../services/storageService.js';
import * as storageDirService from '../services/storageDirService.js';
import type { StorageDir } from '../services/storageDirService.js';
import * as vmService from '../services/vmService.js';
import { assertSafeDownloadUrl } from '../lib/safeUrl.js';
import { validateFilename, ValidationError } from '../lib/validate.js';

export const isosRouter = Router();

// Same scratch-then-move pattern as templates: stream to a local scratch dir
// and move into the operator-picked storage dir after the body is parsed.
const SCRATCH_DIR = path.join(config.storageRoot, '.uploads');

const upload = multer({
  dest: SCRATCH_DIR,
  limits: { fileSize: 50 * 1024 * 1024 * 1024 },
});

async function resolveIsosUploadDir(storageDirIdRaw: unknown): Promise<StorageDir> {
  const id = typeof storageDirIdRaw === 'string' ? storageDirIdRaw.trim() : '';
  let dir: StorageDir | null;
  if (id) {
    dir = await storageDirService.getDir(id);
    if (!dir) throw new Error(`Storage directory ${id} not found`);
  } else {
    dir = await storageDirService.getDefaultDirFor('isos');
    if (!dir) throw new Error('No ISOs storage directory configured');
  }
  if (!dir.purposes.includes('isos')) {
    throw new Error(`Storage directory "${dir.name}" is not flagged for ISOs`);
  }
  const subdir = storageDirService.getIsosSubdir(dir);
  await fsp.mkdir(subdir, { recursive: true });
  await fsp.chmod(subdir, 0o770).catch(() => {});
  return dir;
}

async function moveCrossFs(src: string, dest: string): Promise<void> {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fsp.copyFile(src, dest);
    await fsp.unlink(src);
  }
}

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

async function readMagic(filePath: string): Promise<Buffer> {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(2);
    await fh.read(buf, 0, 2, 0);
    return buf;
  } finally {
    await fh.close();
  }
}

function isGzip(magic: Buffer): boolean {
  return magic.length >= 2 && magic[0] === GZIP_MAGIC[0] && magic[1] === GZIP_MAGIC[1];
}

// Strip archive extensions and ensure the result ends with .iso. Always runs
// path.basename() first so an attacker-supplied "originalname" containing
// path separators ("../../etc/cron.d/x") collapses to a leaf name before we
// build a destination path.
// foo.iso.gz → foo.iso, foo.iso.tar.gz → foo.iso, foo.tar.gz → foo.iso, foo.gz → foo.iso
function deriveIsoFilename(originalName: string): string {
  let name = path.basename(originalName);
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz')) name = name.slice(0, -'.tar.gz'.length);
  else if (lower.endsWith('.tgz')) name = name.slice(0, -'.tgz'.length);
  else if (lower.endsWith('.gz')) name = name.slice(0, -'.gz'.length);
  if (!name.toLowerCase().endsWith('.iso')) name += '.iso';
  // Reject anything that still contains a path separator after stripping,
  // a control char, or is the empty string.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.iso$/i.test(name)) {
    throw new Error('Invalid ISO filename');
  }
  return name;
}

// Extract the first .iso entry from a gzipped tar into destPath.
// Zip-slip defence: tar entry paths can contain `../` and absolute paths.
// The destination is fixed (destPath) regardless of the entry's stored path,
// but we still reject entries whose normalised path escapes a single name
// component so a malicious archive can't trick the loop into creating
// auxiliary files outside isosDir via symlinks or hardlinks.
async function extractIsoFromTarGz(srcPath: string, destPath: string): Promise<void> {
  let extracted = false;
  let writeDone: Promise<void> = Promise.resolve();

  await tar.t({
    file: srcPath,
    onentry: (entry) => {
      if (extracted) { entry.resume(); return; }
      // Reject anything that's not a regular file (Symlinks/Links/Dirs/etc.
      // can be used to escape the destination tree).
      if (entry.type !== 'File') { entry.resume(); return; }
      // Reject absolute paths and parent-references in the entry path.
      const entryPath = entry.path ?? '';
      const norm = path.posix.normalize(entryPath);
      if (norm.startsWith('/') || norm.startsWith('..') || norm.includes('/../')) {
        entry.resume();
        return;
      }
      if (!norm.toLowerCase().endsWith('.iso')) { entry.resume(); return; }
      extracted = true;
      const ws = fs.createWriteStream(destPath);
      writeDone = new Promise((resolve, reject) => {
        ws.on('finish', () => resolve());
        ws.on('error', reject);
        entry.on('error', reject);
      });
      entry.pipe(ws);
    },
  });

  await writeDone;
  if (!extracted) throw new Error('No .iso file found in archive');
}

// Detect format and write to a `.iso` file inside the chosen storage dir's
// isos subfolder. Returns the final filename. Removes the source temp file
// once finished. originalName is treated as untrusted: we only ever use its
// leaf-name and re-validate the result.
async function processUploadedFile(srcPath: string, originalNameRaw: string, targetDir: StorageDir): Promise<string> {
  const originalName = path.basename(originalNameRaw);
  const lower = originalName.toLowerCase();
  const magic = await readMagic(srcPath);
  const looksGzipped = isGzip(magic);
  const isTarGzExt = lower.endsWith('.tar.gz') || lower.endsWith('.tgz');
  const isosSubdir = storageDirService.getIsosSubdir(targetDir);

  if (looksGzipped && isTarGzExt) {
    const destName = deriveIsoFilename(originalName);
    const destPath = path.join(isosSubdir, destName);
    try {
      await extractIsoFromTarGz(srcPath, destPath);
    } catch (err) {
      await safeUnlink(destPath);
      throw err;
    } finally {
      await safeUnlink(srcPath);
    }
    return destName;
  }

  if (looksGzipped) {
    const destName = deriveIsoFilename(originalName);
    const destPath = path.join(isosSubdir, destName);
    try {
      await pipeline(
        fs.createReadStream(srcPath),
        zlib.createGunzip(),
        fs.createWriteStream(destPath),
      );
    } catch (err) {
      await safeUnlink(destPath);
      throw err;
    } finally {
      await safeUnlink(srcPath);
    }
    return destName;
  }

  // Plain ISO — keep as-is. Force .iso extension so listing picks it up.
  const destName = lower.endsWith('.iso') ? originalName : `${originalName}.iso`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.iso$/i.test(destName)) {
    throw new Error('Invalid ISO filename');
  }
  const destPath = path.join(isosSubdir, destName);
  await moveCrossFs(srcPath, destPath);
  return destName;
}

interface DownloadJob {
  filename: string;
  partPath: string;
  destPath: string;
  displayName?: string;
  bytesDownloaded: number;
  totalBytes: number;
  status: 'downloading' | 'processing' | 'done' | 'error' | 'cancelled';
  error?: string;
  abort: () => void;
}

const activeDownloads = new Map<string, DownloadJob>();

async function safeUnlink(p: string): Promise<void> {
  try { await fsp.unlink(p); } catch { /* ignore */ }
}

function streamUrl(url: string, destPath: string, job: DownloadJob): Promise<void> {
  return new Promise((resolve, reject) => {
    let activeReq: http.ClientRequest | null = null;
    let activeFile: fs.WriteStream | null = null;
    let cancelled = false;
    let redirectsLeft = 5;

    job.abort = () => {
      cancelled = true;
      activeReq?.destroy(new Error('cancelled'));
      activeFile?.destroy();
    };

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
      activeReq = client.get(safeUrl.toString(), (res) => {
        if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirectsLeft-- <= 0) { reject(new Error('Too many redirects')); return; }
          // Re-validate the redirect target — defends against an upstream that
          // 302s us to http://169.254.169.254/ etc.
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
        res.on('data', (chunk: Buffer) => { job.bytesDownloaded += chunk.length; });
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', reject);
        res.on('error', reject);
      }).on('error', reject);
    };
    attempt(url);
  });
}

isosRouter.get('/', async (_req, res) => {
  try {
    const isos = await storageService.listIsos();
    res.json({ isos });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

isosRouter.post('/upload', upload.single('file'), async (req, res) => {
  const tempPath = req.file?.path;
  // If the client aborts mid-upload, multer leaves the temp file behind. Clean it up.
  req.on('aborted', () => { if (tempPath) safeUnlink(tempPath); });
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const body = req.body as Record<string, string>;
    const targetDir = await resolveIsosUploadDir(body.storageDirId);
    const finalName = await processUploadedFile(req.file.path, req.file.originalname, targetDir);
    const displayName = body.name?.trim();
    if (displayName) {
      await storageService.setIsoDisplayName(finalName, displayName);
    }
    res.json({ filename: finalName, storageDirId: targetDir.id });
  } catch (err: unknown) {
    if (tempPath) await safeUnlink(tempPath);
    res.status(500).json({ error: String(err) });
  }
});

isosRouter.post('/download', async (req, res) => {
  const { url, filename, name, storageDirId } = req.body as { url?: string; filename?: string; name?: string; storageDirId?: string };
  if (!url) return res.status(400).json({ error: 'url is required' });

  // Preserve archive extensions (.gz/.tar.gz/.tgz) on the raw download name so
  // we can detect format. The user-visible name shown in the list is the
  // decompressed .iso name.
  let rawFilename: string;
  try {
    rawFilename = filename?.trim() || path.basename(new URL(url).pathname) || `download-${Date.now()}.iso`;
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  const finalFilename = deriveIsoFilename(rawFilename);

  let targetDir: StorageDir;
  try {
    targetDir = await resolveIsosUploadDir(storageDirId);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }

  const jobId = randomUUID();
  // Hidden temp path inside the target dir so it's not picked up by the .iso
  // listing filter and the final rename is intra-fs (atomic).
  const isosSubdir = storageDirService.getIsosSubdir(targetDir);
  const tempPath = path.join(isosSubdir, `.${jobId}.download`);
  const destPath = path.join(isosSubdir, finalFilename);
  const job: DownloadJob = {
    filename: finalFilename,
    partPath: tempPath,
    destPath,
    displayName: name?.trim() || undefined,
    bytesDownloaded: 0,
    totalBytes: 0,
    status: 'downloading',
    abort: () => { /* replaced once stream starts */ },
  };
  activeDownloads.set(jobId, job);

  res.json({ jobId, filename: finalFilename, storageDirId: targetDir.id });

  streamUrl(url, tempPath, job)
    .then(async () => {
      job.status = 'processing';
      const written = await processUploadedFile(tempPath, rawFilename, targetDir);
      job.filename = written;
      job.status = 'done';
      if (job.displayName) {
        await storageService.setIsoDisplayName(written, job.displayName);
      }
    })
    .catch(async (err) => {
      await safeUnlink(tempPath);
      if (String(err.message ?? err) === 'cancelled') {
        job.status = 'cancelled';
      } else {
        job.status = 'error';
        job.error = String(err);
      }
    })
    .finally(() => { setTimeout(() => activeDownloads.delete(jobId), 60_000); });
});

isosRouter.get('/download/:jobId', (req, res) => {
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

isosRouter.delete('/download/:jobId', (req, res) => {
  const job = activeDownloads.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or already completed' });
  if (job.status === 'downloading') job.abort();
  res.json({ ok: true });
});

// Move an ISO to a different storage dir. Refuses the move if any VM has the
// ISO attached as a CDROM — their domain XML has the old absolute path baked
// in, and silently moving the file would break boot-from-ISO and live
// CDROM mounts the next time the VM starts.
isosRouter.post('/:filename/move', async (req, res) => {
  try {
    const filename = validateFilename(req.params.filename);
    const { storageDirId } = req.body as { storageDirId?: string };
    if (typeof storageDirId !== 'string' || !storageDirId) {
      return res.status(400).json({ error: 'storageDirId is required' });
    }

    // Walk every defined VM and check whether the ISO is attached. We compare
    // by basename so this catches the ISO regardless of which storage dir it
    // currently lives in.
    const attached: string[] = [];
    try {
      const vms = await vmService.listVmsRaw();
      for (const v of vms) {
        try {
          const disks = await vmService.getVmDisks(v.id);
          if (disks.some((d) => d.type === 'cdrom' && d.source && path.basename(d.source) === filename)) {
            attached.push(v.name);
          }
        } catch { /* per-VM probe failure shouldn't block the move check */ }
      }
    } catch { /* libvirt unavailable — proceed without the guard */ }
    if (attached.length > 0) {
      return res.status(409).json({
        error:
          `Cannot move "${filename}": attached as CDROM on ${attached.length} VM(s) ` +
          `(${attached.join(', ')}). Detach the ISO from those VMs first.`,
      });
    }

    const result = await storageService.moveIso(filename, storageDirId);
    res.json({
      ok: true,
      filename,
      from: { id: result.fromDir.id, name: result.fromDir.name },
      to: { id: result.toDir.id, name: result.toDir.name },
    });
  } catch (err: unknown) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/not flagged for|already exists in|already in/.test(msg)) {
      return res.status(409).json({ error: msg });
    }
    res.status(500).json({ error: msg });
  }
});

isosRouter.patch('/:filename', async (req, res) => {
  try {
    const filename = validateFilename(req.params.filename);
    const { name } = req.body as { name?: string };
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    await storageService.setIsoDisplayName(filename, name.trim());
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

isosRouter.delete('/:filename', async (req, res) => {
  try {
    const filename = validateFilename(req.params.filename);
    await storageService.deleteIso(filename);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});
