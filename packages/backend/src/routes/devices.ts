import { Router } from 'express';
import * as deviceService from '../services/deviceService.js';

export const devicesRouter = Router();

// GET /api/devices — list all host PCI and USB devices with assignment info
devicesRouter.get('/', async (_req, res) => {
  try {
    const devices = await deviceService.listHostDevices();
    res.json({ devices });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});
