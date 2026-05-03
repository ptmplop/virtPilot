import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getUserSettings } from '../services/userSettingsService.js';
import { isRevoked } from '../lib/tokenStore.js';

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

// Extract a bearer token from Authorization header. Query-string fallback was
// removed: tokens leak into proxy/CDN/journal logs and stick around in browser
// history. WebSocket auth uses Sec-WebSocket-Protocol instead (see index.ts).
function extractBearer(req: Request): string | null {
  const header = req.headers['authorization'];
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractBearer(req);
  if (!token) {
    res.status(401).json({ error: 'Unauthorised' });
    return;
  }
  if (isRevoked(token)) {
    res.status(401).json({ error: 'Token revoked' });
    return;
  }
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  // Pending-2FA tokens are short-lived and only valid for /verify-totp; reject
  // them everywhere else even though they're signature-valid.
  if (payload.pending2fa) {
    res.status(401).json({ error: 'Two-factor verification required' });
    return;
  }
  const { ipWhitelist } = await getUserSettings();
  if (!isIpAllowed(req.ip, ipWhitelist)) {
    res.status(403).json({ error: 'IP not allowed', clientIp: req.ip?.replace(/^::ffff:/, '') });
    return;
  }
  next();
}

export function verifyWsToken(token: string | null): boolean {
  if (!token) return false;
  if (isRevoked(token)) return false;
  try {
    const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    if (payload.pending2fa) return false;
    return true;
  } catch {
    return false;
  }
}
