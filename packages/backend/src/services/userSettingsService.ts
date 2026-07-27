import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { encryptSecret, decryptSecret } from '../lib/secretsCrypto.js';

export interface BackupSettings {
  retentionDays: number;
  compression: boolean;
}

export interface UserSettings {
  maxLogs: number;
  ipWhitelist: string[];
  totpEnabled: boolean;
  totpSecret?: string;
  totpPendingSecret?: string;
  backup: BackupSettings;
  templateSetDismissed: boolean;
  /**
   * Set when a totpSecret exists on disk but could not be decrypted (rotated
   * ENCRYPTION_KEY, truncated file). Derived at read time and never persisted.
   * totpEnabled stays as stored, so 2FA keeps failing closed instead of
   * silently switching itself off.
   */
  totpSecretUnreadable?: boolean;
}

const DEFAULT: UserSettings = {
  maxLogs: 500,
  ipWhitelist: [],
  totpEnabled: false,
  backup: { retentionDays: 7, compression: false },
  templateSetDismissed: false,
};

const settingsFile = () => path.join(config.storageRoot, 'user-settings.json');

// Reads and parses the settings file with the secrets still encrypted.
// Returns null only when the file is genuinely absent (first boot).
async function readStored(): Promise<Partial<UserSettings> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(settingsFile(), 'utf8');
  } catch (err: unknown) {
    // Only a genuinely absent file means "first boot, use defaults". Every
    // other failure (permissions, I/O) must propagate: the defaults are
    // totpEnabled:false + an empty ipWhitelist, so failing open here would
    // silently switch off two-factor auth and the IP allowlist — and
    // saveUserSettings reads through this function, so the next write would
    // persist that loss permanently. Callers turn the rejection into a 503.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
  // A parse failure is a genuine corruption — propagate it for the same reason.
  return JSON.parse(raw) as Partial<UserSettings>;
}

// getUserSettings runs on every authenticated request; log an undecryptable
// secret once rather than once per request.
const loggedSecretFailures = new Set<string>();
function warnUnreadableSecret(field: string, err: unknown): void {
  if (loggedSecretFailures.has(field)) return;
  loggedSecretFailures.add(field);
  console.error(
    `[settings] Could not decrypt ${field} from user-settings.json — ` +
    'ENCRYPTION_KEY has probably changed (a re-run of an older install.sh minted a fresh one). ' +
    'Two-factor authentication stays enabled and will reject every code until the secret is re-enrolled. ' +
    `Cause: ${err instanceof Error ? err.message : String(err)}`,
  );
}

export async function getUserSettings(): Promise<UserSettings> {
  const stored = await readStored();
  if (!stored) return { ...DEFAULT };
  const parsed: Partial<UserSettings> = { ...stored };
  delete parsed.totpSecretUnreadable; // derived here, never trusted from disk
  // Decrypt at-rest secrets transparently. Legacy plaintext values pass
  // through unchanged so existing installs keep working. Each secret is
  // caught on its own: an unreadable secret is dropped (so nothing downstream
  // can verify against garbage) but totpEnabled is kept exactly as stored, so
  // a key rotation fails 2FA closed rather than switching it off. Letting the
  // throw escape instead would hang every request — Express 4 has nowhere to
  // route a rejection from an async handler.
  if (parsed.totpSecret) {
    try {
      parsed.totpSecret = decryptSecret(parsed.totpSecret);
    } catch (err) {
      warnUnreadableSecret('totpSecret', err);
      delete parsed.totpSecret;
      parsed.totpSecretUnreadable = true;
    }
  }
  if (parsed.totpPendingSecret) {
    try {
      parsed.totpPendingSecret = decryptSecret(parsed.totpPendingSecret);
    } catch (err) {
      // A pending secret is mid-enrolment only — dropping it just makes the
      // operator restart the 2FA setup wizard.
      warnUnreadableSecret('totpPendingSecret', err);
      delete parsed.totpPendingSecret;
    }
  }
  return { ...DEFAULT, ...parsed };
}

export async function saveUserSettings(updates: Partial<UserSettings>): Promise<UserSettings> {
  const stored = await readStored();
  const current = await getUserSettings();
  const merged = { ...current };
  if (updates.maxLogs !== undefined) merged.maxLogs = updates.maxLogs;
  if (updates.ipWhitelist !== undefined) merged.ipWhitelist = updates.ipWhitelist;
  if (updates.totpEnabled !== undefined) merged.totpEnabled = updates.totpEnabled;
  if ('totpSecret' in updates) merged.totpSecret = updates.totpSecret;
  if ('totpPendingSecret' in updates) merged.totpPendingSecret = updates.totpPendingSecret;
  if (updates.backup !== undefined) {
    merged.backup = { ...merged.backup, ...updates.backup };
    if (typeof merged.backup.retentionDays !== 'number' || merged.backup.retentionDays < 0) merged.backup.retentionDays = 0;
    merged.backup.compression = Boolean(merged.backup.compression);
  }
  if (updates.templateSetDismissed !== undefined) merged.templateSetDismissed = Boolean(updates.templateSetDismissed);
  if (typeof merged.maxLogs !== 'number' || merged.maxLogs < 10) merged.maxLogs = 10;
  if (merged.maxLogs > 10_000) merged.maxLogs = 10_000;
  if (!Array.isArray(merged.ipWhitelist)) merged.ipWhitelist = [];
  merged.ipWhitelist = merged.ipWhitelist.map(s => s.trim()).filter(isValidIpEntry);

  // Encrypt secrets *just before* writing — keep `merged` in plaintext for
  // the return value so the caller's view is unchanged.
  const onDisk: Record<string, unknown> = {
    ...merged,
    totpSecret: encryptSecret(merged.totpSecret),
    totpPendingSecret: encryptSecret(merged.totpPendingSecret),
  };
  // An undecryptable secret must survive the write byte-for-byte. Re-encrypting
  // the dropped plaintext (undefined) would erase it, leaving totpEnabled:true
  // with no secret — a permanent lockout. Only an explicit update replaces it.
  if (current.totpSecretUnreadable && !('totpSecret' in updates)) onDisk.totpSecret = stored?.totpSecret;
  delete onDisk.totpSecretUnreadable;

  // Write-then-rename: a plain writeFile truncates first, so a crash or a full
  // disk mid-write leaves a half-written user-settings.json that no longer
  // parses — taking 2FA and the IP allowlist down with it. rename() is atomic
  // within the same directory, so readers see either the old or the new file.
  const target = settingsFile();
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(onDisk, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, target);
  return merged;
}

function isValidOctets(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function isValidIpv6(entry: string): boolean {
  // RFC 4291 — covers full, compressed (::), and IPv4-mapped (::ffff:1.2.3.4) forms.
  if (!/^[0-9a-fA-F:.]+(?:\/\d{1,3})?$/.test(entry)) return false;
  const [addr, prefix] = entry.split('/');
  if (prefix !== undefined) {
    const n = Number(prefix);
    if (!Number.isInteger(n) || n < 0 || n > 128) return false;
  }
  // Reject more than one "::" (compression marker).
  const compressedCount = (addr.match(/::/g) ?? []).length;
  if (compressedCount > 1) return false;
  // Split on "::" so each side is a list of hex groups (or empty).
  const halves = addr.split('::');
  const groups = halves.flatMap(h => (h === '' ? [] : h.split(':')));
  if (groups.length === 0) return false;
  for (const g of groups) {
    // Allow embedded IPv4 in the last group (e.g. ::ffff:1.2.3.4).
    if (g.includes('.')) {
      if (!isValidOctets(g)) return false;
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false;
  }
  // Without compression, the address must be exactly 8 groups (with embedded
  // IPv4 counting as 2). With compression, it must be < 8 groups.
  const ipv4Inflation = groups.some(g => g.includes('.')) ? 1 : 0;
  const effectiveLen = groups.length + ipv4Inflation;
  if (compressedCount === 0) return effectiveLen === 8;
  return effectiveLen < 8;
}

function isValidIpEntry(entry: string): boolean {
  if (!entry) return false;
  // IPv4 single address
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(entry)) return isValidOctets(entry);
  // IPv4 CIDR
  const cidrMatch = entry.match(/^((?:\d{1,3}\.){3}\d{1,3})\/(\d|[12]\d|3[0-2])$/);
  if (cidrMatch) return isValidOctets(cidrMatch[1]);
  // IPv6 (with optional prefix)
  if (entry.includes(':')) return isValidIpv6(entry);
  return false;
}
