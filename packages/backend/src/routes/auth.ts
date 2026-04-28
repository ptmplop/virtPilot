import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const { password } = req.body as { password?: string };
  if (!password || !config.authPassword || password !== config.authPassword) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }
  const token = jwt.sign({}, config.jwtSecret, { expiresIn: '24h' });
  res.json({ token });
});
