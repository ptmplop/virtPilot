import { Router } from 'express';
import { listSshKeys, addSshKey, deleteSshKey } from '../services/sshKeyService.js';

export const sshKeysRouter = Router();

sshKeysRouter.get('/', async (_req, res) => {
  try {
    const keys = await listSshKeys();
    res.json({ keys });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

sshKeysRouter.post('/', async (req, res) => {
  try {
    const { name, publicKey } = req.body as { name?: string; publicKey?: string };
    if (!name?.trim() || !publicKey?.trim()) {
      res.status(400).json({ error: 'name and publicKey are required' });
      return;
    }
    const key = await addSshKey(name.trim(), publicKey.trim());
    res.status(201).json({ key });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

sshKeysRouter.delete('/:id', async (req, res) => {
  try {
    const ok = await deleteSshKey(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});
