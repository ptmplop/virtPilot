import { Router } from 'express';
import type { Response } from 'express';
import jwt from 'jsonwebtoken';
import fs from 'fs/promises';
import { timingSafeEqual } from 'crypto';
import { config } from '../config.js';
import { getUserSettings, type UserSettings } from '../services/userSettingsService.js';
import { isIpAllowed } from '../middleware/auth.js';
import { verifyTotp } from '../lib/totp.js';
import { hashPassword, verifyPassword, looksHashed } from '../lib/password.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import { revokeToken } from '../lib/tokenStore.js';
import { isReplay, markUsed } from '../lib/totpReplay.js';

export const authRouter = Router();

// 5 attempts / 15min, then 15min lockout. The bucket key defaults to the
// client IP so a single misbehaving network can't lock out other operators
// unless they share an external NAT address.
const loginLimiter = createRateLimiter('login', {
  windowMs: 15 * 60_000,
  max: 5,
  blockMs: 15 * 60_000,
  message: 'Too many login attempts — try again later.',
});
const totpLimiter = createRateLimiter('verify-totp', {
  windowMs: 15 * 60_000,
  max: 10,
  blockMs: 15 * 60_000,
  message: 'Too many code attempts — try again later.',
});

// Rewrite AUTH_PASSWORD=plaintext to AUTH_PASSWORD_HASH=… in .env after a
// legacy install successfully logs in once. Defensive: only applied if the
// .env exists and the rewrite leaves the file otherwise unchanged.
async function migrateLegacyPasswordToHash(plain: string): Promise<void> {
  if (!config.envFilePath) return;
  let raw: string;
  try {
    raw = await fs.readFile(config.envFilePath, 'utf8');
  } catch {
    return;
  }
  const hash = await hashPassword(plain);
  let next = raw;
  // Insert hash if not present
  if (!/^AUTH_PASSWORD_HASH=/m.test(next)) {
    const stamp = new Date().toISOString();
    next = next.replace(/^AUTH_PASSWORD=.*$/m, (line) => `AUTH_PASSWORD_HASH=${hash}\n# ${line}  # migrated to hash on ${stamp}`);
  } else {
    next = next.replace(/^AUTH_PASSWORD_HASH=.*$/m, `AUTH_PASSWORD_HASH=${hash}`);
    next = next.replace(/^AUTH_PASSWORD=.*$/m, '# AUTH_PASSWORD removed (replaced by AUTH_PASSWORD_HASH)');
  }
  if (next !== raw) {
    try {
      await fs.writeFile(config.envFilePath, next, { mode: 0o600 });
      // Update in-memory config so subsequent logins use the hash directly.
      (config as { authPasswordHash: string }).authPasswordHash = hash;
      (config as { authPasswordLegacy: string }).authPasswordLegacy = '';
    } catch {
      // best-effort — next login will retry
    }
  }
}

async function checkPassword(submitted: string): Promise<boolean> {
  if (config.authPasswordHash && looksHashed(config.authPasswordHash)) {
    return verifyPassword(submitted, config.authPasswordHash);
  }
  if (config.authPasswordLegacy) {
    // Legacy plaintext fallback. We dummy-call hashPassword so the response
    // time is comparable to the hashed path (mitigates timing oracles that
    // could otherwise reveal which path is in use).
    // Buffer first, then compare *byte* lengths. Comparing string lengths is
    // wrong: a non-ASCII password can match on UTF-16 code units while
    // producing longer UTF-8 buffers, and timingSafeEqual throws RangeError on
    // a length mismatch — an unauthenticated crash on the login path.
    const a = Buffer.from(submitted, 'utf8');
    const b = Buffer.from(config.authPasswordLegacy, 'utf8');
    // Constant-time compare on equal-length buffers
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (ok) {
      // Migrate to hashed format in the background — don't block the login
      // response on the disk write.
      void migrateLegacyPasswordToHash(submitted);
    }
    return ok;
  }
  return false;
}

// An unreadable settings file must not hang the login form. Express 4 drops
// rejections from async handlers without writing a response, so the read is
// answered here with a 503 the operator can act on.
async function readSettingsOr503(res: Response): Promise<UserSettings | null> {
  try {
    return await getUserSettings();
  } catch (err) {
    console.error('[auth] Could not read user settings:', err instanceof Error ? err.message : err);
    res.status(503).json({ error: 'Server settings unavailable — check user-settings.json and the VirtPilot service log' });
    return null;
  }
}

authRouter.post('/login', loginLimiter, async (req, res) => {
  const preAuthSettings = await readSettingsOr503(res);
  if (!preAuthSettings) return;
  const { ipWhitelist } = preAuthSettings;
  if (!isIpAllowed(req.ip, ipWhitelist)) {
    res.status(403).json({ error: 'IP not allowed', clientIp: normaliseIp(req.ip) });
    return;
  }
  const { password } = req.body as { password?: string };
  if (typeof password !== 'string' || password.length === 0) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }
  const ok = await checkPassword(password);
  if (!ok) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  const settings = await readSettingsOr503(res);
  if (!settings) return;
  if (settings.totpEnabled && !settings.totpSecret) {
    // 2FA is on but the secret is missing or undecryptable. Handing out a full
    // session token here would turn a key rotation into a silent 2FA bypass,
    // so refuse the login and point at the fix.
    res.status(503).json({
      error: 'Two-factor secret could not be read — restore ENCRYPTION_KEY in .env, or disable 2FA in user-settings.json to recover',
    });
    return;
  }
  if (settings.totpEnabled) {
    const tempToken = jwt.sign({ pending2fa: true }, config.jwtSecret, { expiresIn: '5m' });
    res.json({ requiresTotp: true, tempToken });
    return;
  }

  // Reset the bucket so a successful login frees up the IP immediately.
  loginLimiter.reset(loginLimiter.keyFor(req));
  // typ:'session' marks a full-API token. Narrower JWTs we mint (disk-download
  // tickets, pending-2FA tokens) deliberately lack it, so requireAuth can tell
  // a leaked ticket from a real session.
  const token = jwt.sign({ typ: 'session' }, config.jwtSecret, { expiresIn: '24h' });
  res.json({ token });
});

authRouter.post('/verify-totp', totpLimiter, async (req, res) => {
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

  const settings = await readSettingsOr503(res);
  if (!settings) return;
  if (!settings.totpEnabled) {
    res.status(400).json({ error: '2FA is not enabled' });
    return;
  }
  if (!settings.totpSecret) {
    // Enabled but unreadable — every code must fail rather than the endpoint
    // reporting "2FA is not enabled", which reads like a way in.
    res.status(503).json({
      error: 'Two-factor secret could not be read — restore ENCRYPTION_KEY in .env, or disable 2FA in user-settings.json to recover',
    });
    return;
  }

  const cleanCode = String(code).replace(/\s/g, '');
  if (isReplay(settings.totpSecret, cleanCode)) {
    res.status(401).json({ error: 'Code already used — wait for a new one' });
    return;
  }

  if (!verifyTotp(settings.totpSecret, cleanCode)) {
    res.status(401).json({ error: 'Invalid authenticator code' });
    return;
  }
  markUsed(settings.totpSecret, cleanCode);

  const { ipWhitelist } = settings;
  if (!isIpAllowed(req.ip, ipWhitelist)) {
    res.status(403).json({ error: 'IP not allowed', clientIp: normaliseIp(req.ip) });
    return;
  }

  totpLimiter.reset(totpLimiter.keyFor(req));
  const token = jwt.sign({ typ: 'session' }, config.jwtSecret, { expiresIn: '24h' });
  res.json({ token });
});

// Logout — revoke the bearer token so its remaining TTL is unusable.
authRouter.post('/logout', (req, res) => {
  const header = req.headers['authorization'];
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
      const exp = typeof payload.exp === 'number' ? payload.exp : Math.floor(Date.now() / 1000) + 3600;
      revokeToken(token, exp);
    } catch {
      // already invalid — nothing to revoke
    }
  }
  res.json({ ok: true });
});

function normaliseIp(ip: string | undefined): string | undefined {
  return ip?.replace(/^::ffff:/, '');
}
