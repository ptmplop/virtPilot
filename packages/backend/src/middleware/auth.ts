import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getUserSettings } from '../services/userSettingsService.js';

export function isIpAllowed(clientIp: string | undefined, whitelist: string[]): boolean {
  if (whitelist.length === 0) return true;
  if (!clientIp) return false;
  const ip = clientIp.replace(/^::ffff:/, '');
  return whitelist.some(entry => matchesEntry(ip, entry.trim()));
}

function matchesEntry(ip: string, entry: string): boolean {
  if (entry.includes('/')) return ipInCidr(ip, entry);
  return ip === entry;
}

function ipToNum(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  if (isNaN(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~((1 << (32 - bits)) - 1)) >>> 0;
  const ipNum = ipToNum(ip);
  const rangeNum = ipToNum(range);
  if (ipNum === null || rangeNum === null) return false;
  return (ipNum & mask) === (rangeNum & mask);
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers['authorization'];
  const headerToken = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
  const token = headerToken ?? queryToken;
  if (!token) {
    res.status(401).json({ error: 'Unauthorised' });
    return;
  }
  try {
    jwt.verify(token, config.jwtSecret);
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  const { ipWhitelist } = await getUserSettings();
  if (!isIpAllowed(req.ip, ipWhitelist)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  next();
}

export function verifyWsToken(token: string | null): boolean {
  if (!token) return false;
  try {
    jwt.verify(token, config.jwtSecret);
    return true;
  } catch {
    return false;
  }
}
