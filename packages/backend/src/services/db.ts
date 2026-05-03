import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { config } from '../config.js';

let dbInstance: Db | null = null;

export function getDb(): Db {
  if (dbInstance) return dbInstance;

  fs.mkdirSync(config.storageRoot, { recursive: true });
  const dbPath = path.join(config.storageRoot, 'virtpilot.db');
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  dbInstance = db;
  return db;
}

interface Migration {
  version: number;
  up: (db: Db) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE vm_metrics (
          vm_name        TEXT    NOT NULL,
          ts             INTEGER NOT NULL,
          cpu_percent    REAL    NOT NULL,
          mem_used_mb    INTEGER NOT NULL,
          mem_total_mb   INTEGER NOT NULL,
          disk_read_bps  REAL    NOT NULL,
          disk_write_bps REAL    NOT NULL,
          net_rx_bps     REAL    NOT NULL,
          net_tx_bps     REAL    NOT NULL,
          PRIMARY KEY (vm_name, ts)
        );
        CREATE INDEX idx_vm_metrics_ts ON vm_metrics (ts);
      `);
    },
  },
  {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE system_metrics (
          ts             INTEGER PRIMARY KEY,
          cpu_percent    REAL    NOT NULL,
          mem_used_mb    INTEGER NOT NULL,
          mem_total_mb   INTEGER NOT NULL,
          disk_read_bps  REAL    NOT NULL,
          disk_write_bps REAL    NOT NULL,
          net_rx_bps     REAL    NOT NULL,
          net_tx_bps     REAL    NOT NULL
        );
      `);
    },
  },
];

function runMigrations(db: Db): void {
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  for (const m of migrations) {
    if (m.version <= current) continue;
    const tx = db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    });
    tx();
  }
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
