import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

export interface UserSettings {
  maxLogs: number;
  ipWhitelist: string[];
}

const DEFAULT: UserSettings = { maxLogs: 500, ipWhitelist: [] };

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
  if (typeof merged.maxLogs !== 'number' || merged.maxLogs < 10) merged.maxLogs = 10;
  if (merged.maxLogs > 10_000) merged.maxLogs = 10_000;
  if (!Array.isArray(merged.ipWhitelist)) merged.ipWhitelist = [];
  merged.ipWhitelist = merged.ipWhitelist.map(s => s.trim()).filter(isValidIpEntry);
  await fs.writeFile(settingsFile(), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

function isValidIpEntry(entry: string): boolean {
  if (!entry) return false;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(entry)) return true;
  if (/^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/.test(entry)) return true;
  if (entry.includes(':')) return true; // IPv6
  return false;
}
