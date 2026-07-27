import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { getUserSettings } from './userSettingsService.js';

export interface LogEntry {
  id: string;
  timestamp: string;
  type: string;
  /** Friendly display label captured at write time — survives renames as a snapshot */
  subject: string;
  /** UUID identity for VM-scoped events; lets the UI group entries across renames */
  subjectUuid?: string;
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
  // The .catch() is load-bearing: writeQueue is the tail of the chain, so a
  // single failure (unreadable settings, full disk) would leave it permanently
  // rejected — every later append would no-op and every caller awaiting one
  // would reject. Swallow it here instead; the activity log is a record of the
  // operation, not part of it, so a failed write must not fail the VM action.
  writeQueue = writeQueue
    .then(async () => {
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
    })
    .catch((err: unknown) => {
      console.error('[logs] Could not append activity log entry:', err instanceof Error ? err.message : err);
    });
  return writeQueue;
}

export async function getLogs(): Promise<LogEntry[]> {
  return readLogs();
}

export async function clearLogs(): Promise<void> {
  const op = writeQueue.then(async () => {
    await fs.writeFile(logsFile(), '[]', 'utf8');
  });
  // The caller asked for this one explicitly, so it still sees the failure
  // (the route is wrapped by asyncHandler and answers 500) — but the queue
  // itself must stay resolvable for every subsequent write.
  writeQueue = op.catch(() => undefined);
  return op;
}
