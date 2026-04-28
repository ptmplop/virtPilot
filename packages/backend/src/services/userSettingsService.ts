import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

export interface UserSettings {
  maxLogs: number;
}

const DEFAULT: UserSettings = { maxLogs: 500 };

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
  const merged = { ...current, ...updates };
  if (typeof merged.maxLogs !== 'number' || merged.maxLogs < 10) merged.maxLogs = 10;
  if (merged.maxLogs > 10_000) merged.maxLogs = 10_000;
  await fs.writeFile(settingsFile(), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}
