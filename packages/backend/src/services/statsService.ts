import fs from 'fs/promises';
import { recordSystemSample } from './systemMetricsService.js';

const SAMPLE_INTERVAL_MS = 2000;
const HISTORY_LENGTH = 60;

interface CpuRaw {
  user: number; nice: number; system: number; idle: number;
  iowait: number; irq: number; softirq: number;
}
interface DiskRaw { readSectors: number; writeSectors: number }
interface NetRaw { rxBytes: number; txBytes: number }

export interface StatsSample {
  timestamp: number;
  cpuPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  diskReadBps: number;
  diskWriteBps: number;
  netRxBps: number;
  netTxBps: number;
  diskUsedGb: number;
  diskTotalGb: number;
}

const history: StatsSample[] = [];
let lastCpu: CpuRaw | null = null;
let lastDisk: DiskRaw | null = null;
let lastNet: NetRaw | null = null;
let lastSampleAt = 0;

async function readCpu(): Promise<CpuRaw> {
  const content = await fs.readFile('/proc/stat', 'utf8');
  const parts = content.split('\n')[0].split(/\s+/).slice(1).map(Number);
  return {
    user: parts[0] ?? 0, nice: parts[1] ?? 0, system: parts[2] ?? 0,
    idle: parts[3] ?? 0, iowait: parts[4] ?? 0, irq: parts[5] ?? 0, softirq: parts[6] ?? 0,
  };
}

async function readMem(): Promise<{ usedMb: number; totalMb: number }> {
  const content = await fs.readFile('/proc/meminfo', 'utf8');
  const val = (key: string) => {
    const m = content.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return m ? parseInt(m[1], 10) : 0;
  };
  const total = val('MemTotal');
  const available = val('MemAvailable');
  return { totalMb: Math.round(total / 1024), usedMb: Math.round((total - available) / 1024) };
}

async function readDisk(): Promise<DiskRaw> {
  const content = await fs.readFile('/proc/diskstats', 'utf8');
  let readSectors = 0;
  let writeSectors = 0;
  for (const line of content.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 14) continue;
    // Match whole-disk devices only (not partitions)
    if (!/^(sd[a-z]+|vd[a-z]+|nvme\d+n\d+|xvd[a-z]+|hd[a-z]+|mmcblk\d+)$/.test(p[2])) continue;
    readSectors += parseInt(p[5], 10) || 0;
    writeSectors += parseInt(p[9], 10) || 0;
  }
  return { readSectors, writeSectors };
}

async function readDiskUsage(): Promise<{ usedGb: number; totalGb: number }> {
  const stats = await fs.statfs('/');
  const GB = 1024 * 1024 * 1024;
  const totalGb = (stats.blocks * stats.bsize) / GB;
  const usedGb = ((stats.blocks - stats.bfree) * stats.bsize) / GB;
  return { totalGb, usedGb };
}

async function readNet(): Promise<NetRaw> {
  const content = await fs.readFile('/proc/net/dev', 'utf8');
  let rxBytes = 0;
  let txBytes = 0;
  for (const line of content.split('\n').slice(2)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 10) continue;
    const iface = p[0].replace(':', '');
    if (iface === 'lo' || iface.startsWith('vp') || iface.startsWith('virbr')) continue;
    rxBytes += parseInt(p[1], 10) || 0;
    txBytes += parseInt(p[9], 10) || 0;
  }
  return { rxBytes, txBytes };
}

export async function takeSample(): Promise<StatsSample> {
  const now = Date.now();
  const dt = (now - lastSampleAt) / 1000;

  const [cpu, mem, disk, net, diskUsage] = await Promise.all([readCpu(), readMem(), readDisk(), readNet(), readDiskUsage()]);

  let cpuPercent = history[history.length - 1]?.cpuPercent ?? 0;
  if (lastCpu && dt > 0) {
    const total = (v: CpuRaw) => v.user + v.nice + v.system + v.idle + v.iowait + v.irq + v.softirq;
    const idle = (v: CpuRaw) => v.idle + v.iowait;
    const dTotal = total(cpu) - total(lastCpu);
    const dIdle = idle(cpu) - idle(lastCpu);
    cpuPercent = dTotal > 0 ? Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 100)) : 0;
  }

  const SECTOR = 512;
  let diskReadBps = 0;
  let diskWriteBps = 0;
  if (lastDisk && dt > 0) {
    diskReadBps = Math.max(0, ((disk.readSectors - lastDisk.readSectors) * SECTOR) / dt);
    diskWriteBps = Math.max(0, ((disk.writeSectors - lastDisk.writeSectors) * SECTOR) / dt);
  }

  let netRxBps = 0;
  let netTxBps = 0;
  if (lastNet && dt > 0) {
    netRxBps = Math.max(0, (net.rxBytes - lastNet.rxBytes) / dt);
    netTxBps = Math.max(0, (net.txBytes - lastNet.txBytes) / dt);
  }

  lastCpu = cpu;
  lastDisk = disk;
  lastNet = net;
  lastSampleAt = now;

  const sample: StatsSample = {
    timestamp: now,
    cpuPercent,
    memUsedMb: mem.usedMb,
    memTotalMb: mem.totalMb,
    diskReadBps,
    diskWriteBps,
    netRxBps,
    netTxBps,
    diskUsedGb: diskUsage.usedGb,
    diskTotalGb: diskUsage.totalGb,
  };

  history.push(sample);
  if (history.length > HISTORY_LENGTH) history.shift();
  recordSystemSample(sample);
  return sample;
}

export function getHistory(): StatsSample[] {
  return [...history];
}

export function startSampling(): void {
  takeSample().catch(() => {});
  setInterval(() => takeSample().catch(() => {}), SAMPLE_INTERVAL_MS);
}
