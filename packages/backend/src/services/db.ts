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
          vm_uuid        TEXT    NOT NULL,
          ts             INTEGER NOT NULL,
          cpu_percent    REAL    NOT NULL,
          mem_used_mb    INTEGER NOT NULL,
          mem_total_mb   INTEGER NOT NULL,
          disk_read_bps  REAL    NOT NULL,
          disk_write_bps REAL    NOT NULL,
          net_rx_bps     REAL    NOT NULL,
          net_tx_bps     REAL    NOT NULL,
          PRIMARY KEY (vm_uuid, ts)
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
  {
    // Storage directories: operator-registered folders that hold templates,
    // ISOs, and/or VM disks. The default /var/lib/virtpilot dir gets seeded as
    // the first row at boot (see storageDirService.seedDefault).
    //
    // vm_disk_locations indexes every disk file across every storage dir so
    // the dashboard can enumerate VM disks without walking N filesystems on
    // every page load.
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE storage_dirs (
          id                    TEXT    PRIMARY KEY,
          name                  TEXT    NOT NULL UNIQUE,
          path                  TEXT    NOT NULL UNIQUE,
          purposes              TEXT    NOT NULL,
          is_default_templates  INTEGER NOT NULL DEFAULT 0,
          is_default_isos       INTEGER NOT NULL DEFAULT 0,
          is_default_vm_disks   INTEGER NOT NULL DEFAULT 0,
          created_at            INTEGER NOT NULL
        );
        CREATE TABLE vm_disk_locations (
          vm_uuid          TEXT NOT NULL,
          disk_filename    TEXT NOT NULL,
          storage_dir_id   TEXT NOT NULL REFERENCES storage_dirs(id),
          PRIMARY KEY (vm_uuid, disk_filename)
        );
        CREATE INDEX idx_vm_disk_locations_storage_dir ON vm_disk_locations (storage_dir_id);
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
