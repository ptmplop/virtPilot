import { Router } from 'express';
import * as logService from '../services/logService.js';

export const logsRouter = Router();

logsRouter.get('/', async (_req, res) => {
  try {
    const logs = await logService.getLogs();
    res.json({ logs });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

logsRouter.delete('/', async (_req, res) => {
  try {
    await logService.clearLogs();
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});
