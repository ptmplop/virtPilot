import type { Statement } from 'better-sqlite3';
import { getDb } from './db.js';
import { virsh } from './safeExec.js';
import { validateVmUuid } from '../lib/validate.js';

const SAMPLE_INTERVAL_MS = 30_000;
// Raw 30s samples are kept a little beyond the 24h view they serve, so the
// chart never has a hole at its left edge if a rollup runs late.
const RETENTION_MS = 36 * 60 * 60 * 1000;
// Hourly rollups are cheap — 24 rows per VM per day — so they can go back far
// enough to answer capacity questions.
const HOURLY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const PRUNE_EVERY_N_TICKS = 60;

export interface VmMetricsPoint {
  ts: number;
  cpuPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  diskReadBps: number;
  diskWriteBps: number;
  netRxBps: number;
  netTxBps: number;
}

interface PrevCounters {
  ts: number;
  cpuTimeNs: number;
  blockRdBytes: number;
  blockWrBytes: number;
  netRxBytes: number;
  netTxBytes: number;
}

const prevCounters = new Map<string, PrevCounters>();
let tickCounter = 0;

// What "memory used" means depends on what the guest reports. With the virtio balloon
// driver's stats (available/unused), it is the guest's own view. Without them libvirt
// only knows the allocation, and reporting that as "used" read every such guest as
// 100% full. The QEMU process's resident size on the host (balloon.rss) is a measured
// figure instead — what the guest has actually touched — capped at its allocation.
export interface GuestMemory { usedMb: number; totalMb: number; source: 'guest' | 'host' }

export function guestMemory(stats: Map<string, number>): GuestMemory {
  const availableKiB = stats.get('balloon.available');
  const unusedKiB = stats.get('balloon.unused');
  if (availableKiB != null && unusedKiB != null) {
    return {
      totalMb: Math.round(availableKiB / 1024),
      usedMb: Math.round((availableKiB - unusedKiB) / 1024),
      source: 'guest',
    };
  }
  const totalKiB = stats.get('balloon.maximum') ?? 0;
  const currentKiB = stats.get('balloon.current') ?? totalKiB;
  const rssKiB = stats.get('balloon.rss');
  return {
    totalMb: Math.round(totalKiB / 1024),
    usedMb: Math.round(Math.min(rssKiB ?? currentKiB, currentKiB || rssKiB || 0) / 1024),
    source: 'host',
  };
}

function parseDomStats(out: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*([a-z0-9_.]+)=(\d+)\s*$/);
    if (m) result.set(m[1], parseInt(m[2], 10));
  }
  return result;
}

async function listRunningVmUuids(): Promise<string[]> {
  // `virsh list --state-running --uuid` prints one UUID per line.
  const stdout = await virsh(['list', '--state-running', '--uuid'], { timeout: 10_000 });
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

async function sampleVm(vmUuid: string): Promise<VmMetricsPoint | null> {
  try {
    const safeUuid = validateVmUuid(vmUuid);
    const stdout = await virsh(['domstats', safeUuid], { timeout: 10_000 });
    const s = parseDomStats(stdout);
    const get = (k: string) => s.get(k) ?? 0;

    const cpuTimeNs = get('cpu.time');
    const vcpuCount = get('vcpu.current') || get('vcpu.maximum') || 1;
    const mem = guestMemory(s);

    const blockCount = get('block.count');
    let blockRdBytes = 0;
    let blockWrBytes = 0;
    for (let i = 0; i < blockCount; i++) {
      blockRdBytes += get(`block.${i}.rd.bytes`);
      blockWrBytes += get(`block.${i}.wr.bytes`);
    }

    const netCount = get('net.count');
    let netRxBytes = 0;
    let netTxBytes = 0;
    for (let i = 0; i < netCount; i++) {
      netRxBytes += get(`net.${i}.rx.bytes`);
      netTxBytes += get(`net.${i}.tx.bytes`);
    }

    const now = Date.now();
    const prev = prevCounters.get(vmUuid);
    prevCounters.set(vmUuid, { ts: now, cpuTimeNs, blockRdBytes, blockWrBytes, netRxBytes, netTxBytes });

    if (!prev) return null;

    const dt = (now - prev.ts) / 1000;
    if (dt <= 0) return null;

    const maxCpuNs = dt * vcpuCount * 1e9;
    const cpuPercent = Math.min(100, Math.max(0, ((cpuTimeNs - prev.cpuTimeNs) / maxCpuNs) * 100));

    return {
      ts: now,
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      memUsedMb: mem.usedMb,
      memTotalMb: mem.totalMb,
      diskReadBps: Math.max(0, (blockRdBytes - prev.blockRdBytes) / dt),
      diskWriteBps: Math.max(0, (blockWrBytes - prev.blockWrBytes) / dt),
      netRxBps: Math.max(0, (netRxBytes - prev.netRxBytes) / dt),
      netTxBps: Math.max(0, (netTxBytes - prev.netTxBytes) / dt),
    };
  } catch {
    return null;
  }
}

type InsertParams = [string, number, number, number, number, number, number, number, number];

const insertStmt = (() => {
  let cached: Statement<InsertParams> | null = null;
  return () => {
    if (!cached) {
      cached = getDb().prepare<InsertParams>(`
        INSERT OR REPLACE INTO vm_metrics
          (vm_uuid, ts, cpu_percent, mem_used_mb, mem_total_mb,
           disk_read_bps, disk_write_bps, net_rx_bps, net_tx_bps)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    }
    return cached;
  };
})();

function writePoint(vmUuid: string, p: VmMetricsPoint): void {
  insertStmt().run(
    vmUuid, p.ts, p.cpuPercent, p.memUsedMb, p.memTotalMb,
    p.diskReadBps, p.diskWriteBps, p.netRxBps, p.netTxBps,
  );
}

/**
 * Folds every completed hour of raw samples into the hourly table, then drops
 * raw rows past their (short) retention and hourly rows past their long one.
 *
 * Only *completed* hours are rolled up: averaging the hour still in progress
 * would write a value that later samples would make wrong. INSERT OR REPLACE
 * makes a re-run harmless.
 */
function rollUpAndPrune(): void {
  const db = getDb();
  const currentHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;

  db.prepare(`
    INSERT OR REPLACE INTO vm_metrics_hourly
      (vm_uuid, ts, cpu_percent, mem_used_mb, mem_total_mb,
       disk_read_bps, disk_write_bps, net_rx_bps, net_tx_bps)
    SELECT vm_uuid,
           (CAST(ts / ? AS INTEGER)) * ? AS bucket_ts,
           AVG(cpu_percent), AVG(mem_used_mb), AVG(mem_total_mb),
           AVG(disk_read_bps), AVG(disk_write_bps), AVG(net_rx_bps), AVG(net_tx_bps)
    FROM vm_metrics
    WHERE ts < ?
    GROUP BY vm_uuid, bucket_ts
  `).run(HOUR_MS, HOUR_MS, currentHour);

  db.prepare('DELETE FROM vm_metrics WHERE ts < ?').run(Date.now() - RETENTION_MS);
  db.prepare('DELETE FROM vm_metrics_hourly WHERE ts < ?').run(Date.now() - HOURLY_RETENTION_MS);
}

async function tick(): Promise<void> {
  let uuids: string[];
  try {
    uuids = await listRunningVmUuids();
  } catch {
    return;
  }

  // Forget counters for VMs that stopped, so the next start doesn't compute a huge delta.
  const running = new Set(uuids);
  for (const tracked of prevCounters.keys()) {
    if (!running.has(tracked)) prevCounters.delete(tracked);
  }

  await Promise.all(uuids.map(async (uuid) => {
    const point = await sampleVm(uuid);
    if (point) {
      try { writePoint(uuid, point); } catch { /* db write failure shouldn't crash sampler */ }
    }
  }));

  tickCounter++;
  if (tickCounter % PRUNE_EVERY_N_TICKS === 0) {
    try { rollUpAndPrune(); } catch { /* best-effort */ }
  }
}

export function startVmMetricsSampling(): void {
  void tick();
  setInterval(() => { void tick(); }, SAMPLE_INTERVAL_MS);
}

export type MetricsRange = '1h' | '24h' | '7d' | '30d';

export function getVmMetricsHistory(vmUuid: string, range: MetricsRange): VmMetricsPoint[] {
  const now = Date.now();
  if (range === '1h') {
    const since = now - 60 * 60 * 1000;
    const rows = getDb().prepare(`
      SELECT ts, cpu_percent, mem_used_mb, mem_total_mb,
             disk_read_bps, disk_write_bps, net_rx_bps, net_tx_bps
      FROM vm_metrics
      WHERE vm_uuid = ? AND ts >= ?
      ORDER BY ts ASC
    `).all(vmUuid, since) as Array<{
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

  // Beyond 24h the raw table no longer reaches back far enough, so the long
  // ranges read the hourly rollup instead. 7d is 168 points, 30d is 720 —
  // both comfortable for a chart without further bucketing.
  if (range === '7d' || range === '30d') {
    const days = range === '7d' ? 7 : 30;
    const rows = getDb().prepare(`
      SELECT ts, cpu_percent, mem_used_mb, mem_total_mb,
             disk_read_bps, disk_write_bps, net_rx_bps, net_tx_bps
      FROM vm_metrics_hourly
      WHERE vm_uuid = ? AND ts >= ?
      ORDER BY ts ASC
    `).all(vmUuid, now - days * 24 * 60 * 60 * 1000) as Array<{
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
    FROM vm_metrics
    WHERE vm_uuid = ? AND ts >= ?
    GROUP BY bucket_ts
    ORDER BY bucket_ts ASC
  `).all(bucketMs, bucketMs, vmUuid, since) as Array<{
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

export function deleteVmMetrics(vmUuid: string): void {
  try {
    getDb().prepare('DELETE FROM vm_metrics WHERE vm_uuid = ?').run(vmUuid);
    getDb().prepare('DELETE FROM vm_metrics_hourly WHERE vm_uuid = ?').run(vmUuid);
  } catch { /* best-effort */ }
}

/**
 * Recent CPU% samples per VM for roster sparklines. One query for all VMs —
 * pulls the last `windowMs` of samples and groups them in JS, keeping at most
 * `maxPoints` (newest) per VM. Returns a uuid → ordered (oldest→newest) array.
 */
export function getRecentVmCpu(windowMs = 30 * 60 * 1000, maxPoints = 16): Map<string, number[]> {
  const result = new Map<string, number[]>();
  try {
    const since = Date.now() - windowMs;
    const rows = getDb().prepare(`
      SELECT vm_uuid, cpu_percent
      FROM vm_metrics
      WHERE ts >= ?
      ORDER BY ts ASC
    `).all(since) as Array<{ vm_uuid: string; cpu_percent: number }>;
    for (const r of rows) {
      const arr = result.get(r.vm_uuid) ?? [];
      arr.push(r.cpu_percent);
      result.set(r.vm_uuid, arr);
    }
    for (const [uuid, arr] of result) {
      if (arr.length > maxPoints) result.set(uuid, arr.slice(arr.length - maxPoints));
    }
  } catch { /* best-effort — sparklines just stay empty */ }
  return result;
}
