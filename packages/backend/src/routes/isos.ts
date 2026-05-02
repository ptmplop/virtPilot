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

export const isosRouter = Router();

const upload = multer({
  dest: config.isosDir,
  limits: { fileSize: 50 * 1024 * 1024 * 1024 },
});

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

// Strip archive extensions and ensure the result ends with .iso.
// foo.iso.gz → foo.iso, foo.iso.tar.gz → foo.iso, foo.tar.gz → foo.iso, foo.gz → foo.iso
function deriveIsoFilename(originalName: string): string {
  let name = originalName;
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz')) name = name.slice(0, -'.tar.gz'.length);
  else if (lower.endsWith('.tgz')) name = name.slice(0, -'.tgz'.length);
  else if (lower.endsWith('.gz')) name = name.slice(0, -'.gz'.length);
  if (!name.toLowerCase().endsWith('.iso')) name += '.iso';
  return name;
}

// Extract the first .iso entry from a gzipped tar into destPath.
async function extractIsoFromTarGz(srcPath: string, destPath: string): Promise<void> {
  let extracted = false;
  let writeDone: Promise<void> = Promise.resolve();

  await tar.t({
    file: srcPath,
    onentry: (entry) => {
      if (extracted) { entry.resume(); return; }
      if (entry.type !== 'File' || !entry.path.toLowerCase().endsWith('.iso')) {
        entry.resume();
        return;
      }
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

// Detect format and write to a `.iso` file in isosDir. Returns the final filename.
// Removes the source temp file once finished.
async function processUploadedFile(srcPath: string, originalName: string): Promise<string> {
  const lower = originalName.toLowerCase();
  const magic = await readMagic(srcPath);
  const looksGzipped = isGzip(magic);
  const isTarGzExt = lower.endsWith('.tar.gz') || lower.endsWith('.tgz');

  if (looksGzipped && isTarGzExt) {
    const destName = deriveIsoFilename(originalName);
    const destPath = path.join(config.isosDir, destName);
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
    const destPath = path.join(config.isosDir, destName);
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
  const destPath = path.join(config.isosDir, destName);
  await fsp.rename(srcPath, destPath);
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

    job.abort = () => {
      cancelled = true;
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
    const finalName = await processUploadedFile(req.file.path, req.file.originalname);
    const displayName = (req.body as Record<string, string>).name?.trim();
    if (displayName) {
      await storageService.setIsoDisplayName(finalName, displayName);
    }
    res.json({ filename: finalName });
  } catch (err: unknown) {
    if (tempPath) await safeUnlink(tempPath);
    res.status(500).json({ error: String(err) });
  }
});

isosRouter.post('/download', async (req, res) => {
  const { url, filename, name } = req.body as { url?: string; filename?: string; name?: string };
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

  const jobId = randomUUID();
  // Hidden temp path so it's not picked up by the .iso listing filter.
  const tempPath = path.join(config.isosDir, `.${jobId}.download`);
  const destPath = path.join(config.isosDir, finalFilename);
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

  res.json({ jobId, filename: finalFilename });

  streamUrl(url, tempPath, job)
    .then(async () => {
      job.status = 'processing';
      const written = await processUploadedFile(tempPath, rawFilename);
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

isosRouter.patch('/:filename', async (req, res) => {
  try {
    const { name } = req.body as { name?: string };
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    await storageService.setIsoDisplayName(req.params.filename, name.trim());
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

isosRouter.delete('/:filename', async (req, res) => {
  try {
    await storageService.deleteIso(req.params.filename);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});
