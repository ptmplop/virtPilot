import type { Statement } from 'better-sqlite3';
import { getDb } from './db.js';
import type { StatsSample } from './statsService.js';

const PERSIST_INTERVAL_MS = 30_000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

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
    try {
      const cutoff = Date.now() - RETENTION_MS;
      getDb().prepare('DELETE FROM system_metrics WHERE ts < ?').run(cutoff);
    } catch { /* best-effort */ }
  }
}

export type SystemMetricsRange = '1h' | '24h';

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

  // 24h: aggregate into 5-minute buckets to keep ~288 points on the chart.
  const since = now - 24 * 60 * 60 * 1000;
  const bucketMs = 5 * 60 * 1000;
  const rows = getDb().prepare(`
    SELECT
      (ts / ?) * ? AS bucket_ts,
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
