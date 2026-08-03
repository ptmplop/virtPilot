import type { Statement } from 'better-sqlite3';
import { getDb } from './db.js';
import type { StatsSample } from './statsService.js';

const PERSIST_INTERVAL_MS = 30_000;
// Raw samples outlive the 24h view slightly so its left edge is never empty.
const RETENTION_MS = 36 * 60 * 60 * 1000;
const HOURLY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface SystemMetricsPoint {
  ts: number;
  cpuPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  diskReadBps: number;
  diskWriteBps: number;
  netRxBps: number;
  netTxBps: number;
}

type InsertParams = [number, number, number, number, number, number, number, number];

let lastPersistedAt = 0;
let pruneCounter = 0;
let cachedInsert: Statement<InsertParams> | null = null;

function insertStmt(): Statement<InsertParams> {
  if (!cachedInsert) {
    cachedInsert = getDb().prepare<InsertParams>(`
      INSERT OR REPLACE INTO system_metrics
        (ts, cpu_percent, mem_used_mb, mem_total_mb,
         disk_read_bps, disk_write_bps, net_rx_bps, net_tx_bps)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }
  return cachedInsert;
}

// Called from statsService.takeSample(). Persists at most once per
// PERSIST_INTERVAL_MS — the in-memory 2 s history covers Live mode, while
// the SQLite-backed history powers 1h/24h ranges.
export function recordSystemSample(sample: StatsSample): void {
  if (sample.timestamp - lastPersistedAt < PERSIST_INTERVAL_MS) return;
  lastPersistedAt = sample.timestamp;
  try {
    insertStmt().run(
      sample.timestamp,
      sample.cpuPercent,
      sample.memUsedMb,
      sample.memTotalMb,
      sample.diskReadBps,
      sample.diskWriteBps,
      sample.netRxBps,
      sample.netTxBps,
    );
  } catch { /* db write failure shouldn't crash sampler */ }

  pruneCounter++;
  if (pruneCounter % 60 === 0) {
    try { rollUpAndPrune(); } catch { /* best-effort */ }
  }
}

/**
 * Folds completed hours into the rollup table, then prunes both tables. Only
 * whole hours are rolled up — averaging the hour in progress would record a
 * figure later samples immediately contradict.
 */
function rollUpAndPrune(): void {
  const db = getDb();
  const currentHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;

  db.prepare(`
    INSERT OR REPLACE INTO system_metrics_hourly
      (ts, cpu_percent, mem_used_mb, mem_total_mb,
       disk_read_bps, disk_write_bps, net_rx_bps, net_tx_bps)
    SELECT (CAST(ts / ? AS INTEGER)) * ? AS bucket_ts,
           AVG(cpu_percent), AVG(mem_used_mb), AVG(mem_total_mb),
           AVG(disk_read_bps), AVG(disk_write_bps), AVG(net_rx_bps), AVG(net_tx_bps)
    FROM system_metrics
    WHERE ts < ?
    GROUP BY bucket_ts
  `).run(HOUR_MS, HOUR_MS, currentHour);

  db.prepare('DELETE FROM system_metrics WHERE ts < ?').run(Date.now() - RETENTION_MS);
  db.prepare('DELETE FROM system_metrics_hourly WHERE ts < ?').run(Date.now() - HOURLY_RETENTION_MS);
}

export type SystemMetricsRange = '1h' | '24h' | '7d' | '30d';

export function getSystemMetricsHistory(range: SystemMetricsRange): SystemMetricsPoint[] {
  const now = Date.now();
  if (range === '1h') {
    const since = now - 60 * 60 * 1000;
    const rows = getDb().prepare(`
      SELECT ts, cpu_percent, mem_used_mb, mem_total_mb,
             disk_read_bps, disk_write_bps, net_rx_bps, net_tx_bps
      FROM system_metrics
      WHERE ts >= ?
      ORDER BY ts ASC
    `).all(since) as Array<{
      ts: number; cpu_percent: number; mem_used_mb: number; mem_total_mb: number;
      disk_read_bps: number; disk_write_bps: number; net_rx_bps: number; net_tx_bps: number;
    }>;
    return rows.map((r) => ({
      ts: r.ts,
      cpuPercent: r.cpu_percent,
      memUsedMb: r.mem_used_mb,
      memTotalMb: r.mem_total_mb,
      diskReadBps: r.disk_read_bps,
      diskWriteBps: r.disk_write_bps,
      netRxBps: r.net_rx_bps,
      netTxBps: r.net_tx_bps,
    }));
  }

  // Past 24h the raw table no longer reaches, so read the hourly rollup:
  // 168 points for 7d, 720 for 30d, both fine to chart unbucketed.
  if (range === '7d' || range === '30d') {
    const days = range === '7d' ? 7 : 30;
    const rows = getDb().prepare(`
      SELECT ts, cpu_percent, mem_used_mb, mem_total_mb,
             disk_read_bps, disk_write_bps, net_rx_bps, net_tx_bps
      FROM system_metrics_hourly
      WHERE ts >= ?
      ORDER BY ts ASC
    `).all(now - days * 24 * 60 * 60 * 1000) as Array<{
      ts: number; cpu_percent: number; mem_used_mb: number; mem_total_mb: number;
      disk_read_bps: number; disk_write_bps: number; net_rx_bps: number; net_tx_bps: number;
    }>;
    return rows.map((r) => ({
      ts: r.ts,
      cpuPercent: Math.round(r.cpu_percent * 10) / 10,
      memUsedMb: Math.round(r.mem_used_mb),
      memTotalMb: Math.round(r.mem_total_mb),
      diskReadBps: r.disk_read_bps,
      diskWriteBps: r.disk_write_bps,
      netRxBps: r.net_rx_bps,
      netTxBps: r.net_tx_bps,
    }));
  }

  // 24h: aggregate into 5-minute buckets to keep ~288 points on the chart.
  // SQLite bound number params arrive as REAL, so `(ts / ?) * ?` is real-number
  // division — it returns the input unchanged and every row gets its own bucket.
  // CAST to INTEGER forces the floor we want for proper bucketing.
  const since = now - 24 * 60 * 60 * 1000;
  const bucketMs = 5 * 60 * 1000;
  const rows = getDb().prepare(`
    SELECT
      (CAST(ts / ? AS INTEGER)) * ? AS bucket_ts,
      AVG(cpu_percent)    AS cpu_percent,
      AVG(mem_used_mb)    AS mem_used_mb,
      AVG(mem_total_mb)   AS mem_total_mb,
      AVG(disk_read_bps)  AS disk_read_bps,
      AVG(disk_write_bps) AS disk_write_bps,
      AVG(net_rx_bps)     AS net_rx_bps,
      AVG(net_tx_bps)     AS net_tx_bps
    FROM system_metrics
    WHERE ts >= ?
    GROUP BY bucket_ts
    ORDER BY bucket_ts ASC
  `).all(bucketMs, bucketMs, since) as Array<{
    bucket_ts: number; cpu_percent: number; mem_used_mb: number; mem_total_mb: number;
    disk_read_bps: number; disk_write_bps: number; net_rx_bps: number; net_tx_bps: number;
  }>;

  return rows.map((r) => ({
    ts: r.bucket_ts,
    cpuPercent: Math.round(r.cpu_percent * 10) / 10,
    memUsedMb: Math.round(r.mem_used_mb),
    memTotalMb: Math.round(r.mem_total_mb),
    diskReadBps: r.disk_read_bps,
    diskWriteBps: r.disk_write_bps,
    netRxBps: r.net_rx_bps,
    netTxBps: r.net_tx_bps,
  }));
}
