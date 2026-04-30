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
        ipWhitelist: user.ipWhitelist,
      },
    });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

settingsRouter.put('/', async (req, res) => {
  try {
    const { maxLogs, ipWhitelist } = req.body as { maxLogs?: number; ipWhitelist?: string[] };
    const updates: Parameters<typeof saveUserSettings>[0] = {};
    if (maxLogs !== undefined) updates.maxLogs = maxLogs;
    if (ipWhitelist !== undefined) updates.ipWhitelist = ipWhitelist;
    const updated = await saveUserSettings(updates);
    res.json({ settings: updated });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});
