import { Router } from 'express';
import * as storageDirService from '../services/storageDirService.js';
import { ValidationError } from '../lib/validate.js';

export const storageRouter = Router();

interface SetDefaultBody {
  templates?: boolean;
  isos?: boolean;
  vmDisks?: boolean;
}

storageRouter.get('/dirs', async (_req, res) => {
  try {
    const dirs = await storageDirService.listDirs();
    const withUsage = await Promise.all(
      dirs.map(async (dir) => ({ ...dir, usage: await storageDirService.getDirUsage(dir) })),
    );
    res.json({ dirs: withUsage });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

storageRouter.post('/dirs', async (req, res) => {
  try {
    const { name, path: pathArg, purposes, setDefault } = req.body as {
      name?: string;
      path?: string;
      purposes?: storageDirService.StorageDirPurpose[];
      setDefault?: SetDefaultBody;
    };
    if (typeof name !== 'string' || typeof pathArg !== 'string' || !Array.isArray(purposes)) {
      return res.status(400).json({ error: 'name, path, and purposes are required' });
    }
    const dir = await storageDirService.createDir({
      name,
      path: pathArg,
      purposes,
      setDefault,
    });
    res.json({ dir });
  } catch (err: unknown) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: String(err) });
  }
});

storageRouter.patch('/dirs/:id', async (req, res) => {
  try {
    const { name, purposes, setDefault } = req.body as {
      name?: string;
      purposes?: storageDirService.StorageDirPurpose[];
      setDefault?: SetDefaultBody;
    };
    const dir = await storageDirService.updateDir(req.params.id, { name, purposes, setDefault });
    res.json({ dir });
  } catch (err: unknown) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: String(err) });
  }
});

storageRouter.delete('/dirs/:id', async (req, res) => {
  try {
    await storageDirService.deleteDir(req.params.id);
    res.json({ ok: true });
  } catch (err: unknown) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: String(err) });
  }
});
