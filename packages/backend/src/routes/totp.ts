import { Router } from 'express';
import QRCode from 'qrcode';
import { getUserSettings, saveUserSettings } from '../services/userSettingsService.js';
import { generateSecret, verifyTotp, totpUri } from '../lib/totp.js';

export const totpRouter = Router();

// Generate a new TOTP secret and return the QR code data URL.
// Stores it as a pending secret until the user confirms with a valid code.
totpRouter.post('/setup', async (_req, res) => {
  try {
    const secret = generateSecret();
    await saveUserSettings({ totpPendingSecret: secret });
    const uri = totpUri(secret);
    const qrCodeDataUrl = await QRCode.toDataURL(uri);
    res.json({ secret, qrCodeDataUrl });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Confirm the pending secret with a valid TOTP code, activating 2FA.
totpRouter.post('/enable', async (req, res) => {
  try {
    const { code } = req.body as { code?: string };
    if (!code) {
      res.status(400).json({ error: 'code is required' });
      return;
    }
    const settings = await getUserSettings();
    if (!settings.totpPendingSecret) {
      res.status(400).json({ error: 'No pending 2FA setup found — call /setup first' });
      return;
    }
    if (!verifyTotp(settings.totpPendingSecret, code)) {
      res.status(401).json({ error: 'Invalid code' });
      return;
    }
    await saveUserSettings({
      totpEnabled: true,
      totpSecret: settings.totpPendingSecret,
      totpPendingSecret: undefined,
    });
    res.json({ totpEnabled: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Disable 2FA and clear the stored secret.
totpRouter.delete('/', async (_req, res) => {
  try {
    await saveUserSettings({
      totpEnabled: false,
      totpSecret: undefined,
      totpPendingSecret: undefined,
    });
    res.json({ totpEnabled: false });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
