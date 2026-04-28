import { Router } from 'express';
import { config } from '../config.js';
import { kvmAvailable } from '../services/xmlBuilder.js';
import { getUserSettings, saveUserSettings } from '../services/userSettingsService.js';

export const settingsRouter = Router();

settingsRouter.get('/', async (_req, res) => {
  try {
    const user = await getUserSettings();
    res.json({
      settings: {
        storageRoot: config.storageRoot,
        templatesDir: config.templatesDir,
        isosDir: config.isosDir,
        vmsDir: config.vmsDir,
        defaultBridge: config.defaultBridge,
        libvirtUri: config.libvirtUri,
        kvmAvailable: kvmAvailable(),
        maxLogs: user.maxLogs,
      },
    });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

settingsRouter.put('/', async (req, res) => {
  try {
    const { maxLogs } = req.body as { maxLogs?: number };
    const updated = await saveUserSettings({ maxLogs });
    res.json({ settings: updated });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});
