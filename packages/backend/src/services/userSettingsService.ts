import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

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
}

const DEFAULT: UserSettings = {
  maxLogs: 500,
  ipWhitelist: [],
  totpEnabled: false,
  backup: { retentionDays: 7, compression: false },
};

const settingsFile = () => path.join(config.storageRoot, 'user-settings.json');

export async function getUserSettings(): Promise<UserSettings> {
  try {
    const raw = await fs.readFile(settingsFile(), 'utf8');
    return { ...DEFAULT, ...(JSON.parse(raw) as Partial<UserSettings>) };
  } catch {
    return { ...DEFAULT };
  }
}

export async function saveUserSettings(updates: Partial<UserSettings>): Promise<UserSettings> {
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
  if (typeof merged.maxLogs !== 'number' || merged.maxLogs < 10) merged.maxLogs = 10;
  if (merged.maxLogs > 10_000) merged.maxLogs = 10_000;
  if (!Array.isArray(merged.ipWhitelist)) merged.ipWhitelist = [];
  merged.ipWhitelist = merged.ipWhitelist.map(s => s.trim()).filter(isValidIpEntry);
  await fs.writeFile(settingsFile(), JSON.stringify(merged, null, 2), 'utf8');
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
