import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getUserSettings } from '../services/userSettingsService.js';
import { isIpAllowed } from '../middleware/auth.js';
import { verifyTotp } from '../lib/totp.js';

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const { ipWhitelist } = await getUserSettings();
  if (!isIpAllowed(req.ip, ipWhitelist)) {
    res.status(403).json({ error: 'IP not allowed', clientIp: normaliseIp(req.ip) });
    return;
  }
  const { password } = req.body as { password?: string };
  if (!password || !config.authPassword || password !== config.authPassword) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  const settings = await getUserSettings();
  if (settings.totpEnabled && settings.totpSecret) {
    // Issue a short-lived pending token; the client must complete TOTP verification
    const tempToken = jwt.sign({ pending2fa: true }, config.jwtSecret, { expiresIn: '5m' });
    res.json({ requiresTotp: true, tempToken });
    return;
  }

  const token = jwt.sign({}, config.jwtSecret, { expiresIn: '24h' });
  res.json({ token });
});

authRouter.post('/verify-totp', async (req, res) => {
  const { tempToken, code } = req.body as { tempToken?: string; code?: string };
  if (!tempToken || !code) {
    res.status(400).json({ error: 'tempToken and code are required' });
    return;
  }

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(tempToken, config.jwtSecret) as jwt.JwtPayload;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  if (!payload.pending2fa) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  const settings = await getUserSettings();
  if (!settings.totpEnabled || !settings.totpSecret) {
    res.status(400).json({ error: '2FA is not enabled' });
    return;
  }

  if (!verifyTotp(settings.totpSecret, code)) {
    res.status(401).json({ error: 'Invalid authenticator code' });
    return;
  }

  const { ipWhitelist } = settings;
  if (!isIpAllowed(req.ip, ipWhitelist)) {
    res.status(403).json({ error: 'IP not allowed', clientIp: normaliseIp(req.ip) });
    return;
  }

  const token = jwt.sign({}, config.jwtSecret, { expiresIn: '24h' });
  res.json({ token });
});

function normaliseIp(ip: string | undefined): string | undefined {
  return ip?.replace(/^::ffff:/, '');
}
