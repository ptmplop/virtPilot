import { Router } from 'express';
import { config } from '../config.js';
import { isIpAllowed } from '../middleware/auth.js';
import { kvmAvailable } from '../services/xmlBuilder.js';
import { getUserSettings, saveUserSettings, type BackupSettings } from '../services/userSettingsService.js';

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
        backupRoot: config.backupRoot,
        maxLogs: user.maxLogs,
        ipWhitelist: user.ipWhitelist,
        totpEnabled: user.totpEnabled,
        backup: user.backup,
      },
    });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

settingsRouter.put('/', async (req, res) => {
  try {
    const { maxLogs, ipWhitelist, backup } = req.body as { maxLogs?: number; ipWhitelist?: string[]; backup?: Partial<BackupSettings> };
    // Self-lockout guard: if a non-empty IP allowlist is being applied, the
    // caller's own IP must remain in the new list, otherwise the next request
    // (including the redirect after this PUT) will 403 from the auth middleware.
    if (Array.isArray(ipWhitelist) && ipWhitelist.length > 0 && !isIpAllowed(req.ip, ipWhitelist)) {
      return res.status(400).json({
        error: `Refusing to apply allowlist that excludes your own IP (${req.ip?.replace(/^::ffff:/, '')}). Add it to the list first or empty the list to disable IP filtering.`,
      });
    }
    const updates: Parameters<typeof saveUserSettings>[0] = {};
    if (maxLogs !== undefined) updates.maxLogs = maxLogs;
    if (ipWhitelist !== undefined) updates.ipWhitelist = ipWhitelist;
    if (backup !== undefined) updates.backup = backup as BackupSettings;
    const updated = await saveUserSettings(updates);
    res.json({ settings: updated });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});
