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

export const templatesRouter = Router();

const upload = multer({
  dest: config.templatesDir,
  limits: { fileSize: 100 * 1024 * 1024 * 1024 },
});

interface DownloadJob {
  filename: string;
  displayName?: string;
  bytesDownloaded: number;
  totalBytes: number;
  status: 'downloading' | 'done' | 'error';
  error?: string;
}

const activeDownloads = new Map<string, DownloadJob>();

function streamUrl(url: string, destPath: string, job: DownloadJob): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = (attemptUrl: string) => {
      const client = attemptUrl.startsWith('https') ? https : http;
      client.get(attemptUrl, (res) => {
        if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          attempt(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        job.totalBytes = parseInt(res.headers['content-length'] ?? '0', 10);
        const file = fs.createWriteStream(destPath);
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

templatesRouter.get('/', async (_req, res) => {
  try {
    const templates = await storageService.listTemplates();
    res.json({ templates });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

templatesRouter.post('/upload', upload.single('file'), async (req, res) => {
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
    res.status(500).json({ error: String(err) });
  }
});

templatesRouter.post('/download', async (req, res) => {
  const { url, filename, name } = req.body as { url?: string; filename?: string; name?: string };
  if (!url) return res.status(400).json({ error: 'url is required' });

  let savedFilename: string;
  try {
    savedFilename = filename?.trim() || path.basename(new URL(url).pathname) || `template-${Date.now()}.qcow2`;
    if (!savedFilename.match(/\.(qcow2|img)$/)) savedFilename += '.qcow2';
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const jobId = randomUUID();
  const destPath = path.join(config.templatesDir, savedFilename);
  const job: DownloadJob = {
    filename: savedFilename,
    displayName: name?.trim() || undefined,
    bytesDownloaded: 0,
    totalBytes: 0,
    status: 'downloading',
  };
  activeDownloads.set(jobId, job);

  res.json({ jobId, filename: savedFilename });

  streamUrl(url, destPath, job)
    .then(async () => {
      job.status = 'done';
      if (job.displayName) {
        await storageService.setTemplateDisplayName(job.filename, job.displayName);
      }
    })
    .catch((err) => { job.status = 'error'; job.error = String(err); })
    .finally(() => { setTimeout(() => activeDownloads.delete(jobId), 60_000); });
});

templatesRouter.get('/download/:jobId', (req, res) => {
  const job = activeDownloads.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or already completed' });
  res.json(job);
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
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});
