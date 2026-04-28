import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { getUserSettings } from './userSettingsService.js';

export interface LogEntry {
  id: string;
  timestamp: string;
  type: string;
  subject: string;
  status: 'success' | 'error';
  output?: string;
  durationMs?: number;
}

const logsFile = () => path.join(config.storageRoot, 'logs.json');

// Serialise all writes to prevent concurrent file corruption
let writeQueue: Promise<void> = Promise.resolve();

async function readLogs(): Promise<LogEntry[]> {
  try {
    const raw = await fs.readFile(logsFile(), 'utf8');
    return JSON.parse(raw) as LogEntry[];
  } catch {
    return [];
  }
}

export async function appendLog(entry: Omit<LogEntry, 'id' | 'timestamp'>): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const { maxLogs } = await getUserSettings();
    const logs = await readLogs();
    const newEntry: LogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    logs.unshift(newEntry);
    if (logs.length > maxLogs) logs.length = maxLogs;
    await fs.writeFile(logsFile(), JSON.stringify(logs), 'utf8');
  });
  return writeQueue;
}

export async function getLogs(): Promise<LogEntry[]> {
  return readLogs();
}

export async function clearLogs(): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    await fs.writeFile(logsFile(), '[]', 'utf8');
  });
  return writeQueue;
}
