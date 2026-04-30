import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getUserSettings } from '../services/userSettingsService.js';
import { isIpAllowed } from '../middleware/auth.js';

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const { ipWhitelist } = await getUserSettings();
  if (!isIpAllowed(req.ip, ipWhitelist)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  const { password } = req.body as { password?: string };
  if (!password || !config.authPassword || password !== config.authPassword) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }
  const token = jwt.sign({}, config.jwtSecret, { expiresIn: '24h' });
  res.json({ token });
});
