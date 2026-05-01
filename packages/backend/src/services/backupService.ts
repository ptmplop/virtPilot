import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { config, VERSION } from '../config.js';
import { getUserSettings } from './userSettingsService.js';
import { getVmInfo, getVmXml, getVmNics, getVmDisks } from './vmService.js';
import { getVmMeta } from './vmMetaService.js';
import { appendLog } from './logService.js';

const execAsync = promisify(exec);

// ─── Types ────────────────────────────────────────────────────────────────────

export type BackupTrigger = 'manual' | 'scheduled';
export type BackupFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface BackupDiskEntry {
  target: string;
  filename: string;
  format: 'qcow2';
  sizeBytes: number;
  originalPath: string;
}

export interface BackupManifest {
  id: string;
  vmName: string;
  createdAt: string;
  virtpilotVersion: string;
  triggerType: BackupTrigger;
  scheduleFrequency?: BackupFrequency;
  consistent: boolean;
  vmStateAtBackup: string;
  hostname: string;
  vmConfig: {
    cpus: number;
    memoryMb: number;
  };
  disks: BackupDiskEntry[];
  nics: Array<{ model: string; mac: string; source: string }>;
  vmMeta: unknown;
  libvirtXml: string;
  retentionDays: number;
}

export interface BackupEntry {
  id: string;
  vmName: string;
  createdAt: string;
  sizeBytes: number;
  consistent: boolean;
  triggerType: BackupTrigger;
  scheduleFrequency?: BackupFrequency;
  vmStateAtBackup: string;
  retentionDays: number;
  disks: BackupDiskEntry[];
}

export interface BackupVmSummary {
  vmName: string;
  backupCount: number;
  totalSizeBytes: number;
  lastBackupAt: string | null;
  schedule: BackupSchedule | null;
}

export interface BackupSchedule {
  vmName: string;
  frequency: BackupFrequency;
  hour: number;
  minute: number;
  dayOfWeek: number;
  dayOfMonth: number;
  retentionDays: number | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const backupRoot = () => config.backupRoot;
const vmBackupDir = (vmName: string) => path.join(backupRoot(), vmName);
const backupDir = (vmName: string, id: string) => path.join(vmBackupDir(vmName), id);
const schedulesFile = () => path.join(config.storageRoot, 'backup-schedules.json');

function backupId(): string {
  const now = new Date();
  return now.toISOString().replace(/[:\-]/g, '').replace('.', '').slice(0, 15) + 'Z'
    + '-' + crypto.randomBytes(3).toString('hex');
}

// ─── Concurrency guard ────────────────────────────────────────────────────────

const backupsInProgress = new Set<string>();

// ─── Schedule persistence ─────────────────────────────────────────────────────

export async function readSchedules(): Promise<Record<string, BackupSchedule>> {
  try {
    const raw = await fs.readFile(schedulesFile(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function writeSchedules(schedules: Record<string, BackupSchedule>): Promise<void> {
  await fs.writeFile(schedulesFile(), JSON.stringify(schedules, null, 2), 'utf8');
}

export async function getSchedule(vmName: string): Promise<BackupSchedule | null> {
  const all = await readSchedules();
  return all[vmName] ?? null;
}

export async function saveSchedule(schedule: BackupSchedule): Promise<void> {
  const all = await readSchedules();
  all[schedule.vmName] = schedule;
  await writeSchedules(all);
}

export async function deleteSchedule(vmName: string): Promise<void> {
  const all = await readSchedules();
  delete all[vmName];
  await writeSchedules(all);
}

// ─── Listing ──────────────────────────────────────────────────────────────────

export async function listBackupsForVm(vmName: string): Promise<BackupEntry[]> {
  const dir = vmBackupDir(vmName);
  let subdirs: string[];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const results = await Promise.all(
    subdirs.map(async (entry): Promise<BackupEntry | null> => {
      const bdir = path.join(dir, entry);
      try {
        await fs.access(path.join(bdir, '.complete'));
        const raw = await fs.readFile(path.join(bdir, 'manifest.json'), 'utf8');
        const manifest = JSON.parse(raw) as BackupManifest;
        const sizeBytes = await dirSizeBytes(bdir);
        return {
          id: manifest.id,
          vmName: manifest.vmName,
          createdAt: manifest.createdAt,
          sizeBytes,
          consistent: manifest.consistent,
          triggerType: manifest.triggerType,
          scheduleFrequency: manifest.scheduleFrequency,
          vmStateAtBackup: manifest.vmStateAtBackup,
          retentionDays: manifest.retentionDays,
          disks: manifest.disks,
        };
      } catch {
        return null; // incomplete or corrupt — skip
      }
    })
  );

  return (results.filter((b): b is BackupEntry => b !== null))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getBackupManifest(vmName: string, id: string): Promise<BackupManifest | null> {
  try {
    const raw = await fs.readFile(path.join(backupDir(vmName, id), 'manifest.json'), 'utf8');
    return JSON.parse(raw) as BackupManifest;
  } catch {
    return null;
  }
}

export async function listAllVmBackupSummaries(): Promise<BackupVmSummary[]> {
  await fs.mkdir(backupRoot(), { recursive: true });
  let vmNames: string[];
  try {
    const entries = await fs.readdir(backupRoot(), { withFileTypes: true });
    vmNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    vmNames = [];
  }

  const schedules = await readSchedules();
  // Also include VMs that have a schedule but no backup directory yet
  for (const vmName of Object.keys(schedules)) {
    if (!vmNames.includes(vmName)) vmNames.push(vmName);
  }

  const summaries: BackupVmSummary[] = [];
  for (const vmName of vmNames) {
    const backups = await listBackupsForVm(vmName);
    const totalSizeBytes = backups.reduce((s, b) => s + b.sizeBytes, 0);
    const lastBackupAt = backups.length > 0 ? backups[0].createdAt : null;
    summaries.push({
      vmName,
      backupCount: backups.length,
      totalSizeBytes,
      lastBackupAt,
      schedule: schedules[vmName] ?? null,
    });
  }
  return summaries;
}

// ─── Create backup ────────────────────────────────────────────────────────────

export async function createBackup(
  vmName: string,
  opts: { triggerType: BackupTrigger; scheduleFrequency?: BackupFrequency; retentionDaysOverride?: number | null }
): Promise<BackupEntry> {
  // Fix 5: Concurrency guard
  if (backupsInProgress.has(vmName)) {
    throw new Error(`Backup already in progress for VM "${vmName}"`);
  }
  backupsInProgress.add(vmName);

  try {
    return await _createBackupInner(vmName, opts);
  } finally {
    backupsInProgress.delete(vmName);
  }
}

async function _createBackupInner(
  vmName: string,
  opts: { triggerType: BackupTrigger; scheduleFrequency?: BackupFrequency; retentionDaysOverride?: number | null }
): Promise<BackupEntry> {
  const settings = await getUserSettings();
  const retentionDays = opts.retentionDaysOverride != null ? opts.retentionDaysOverride : settings.backup.retentionDays;
  const compress = settings.backup.compression;

  const id = backupId();
  const bdir = backupDir(vmName, id);
  await fs.mkdir(bdir, { recursive: true });

  let consistent = false;
  let frozen = false;
  let vmStateAtBackup = 'unknown';
  let vmInfo: Awaited<ReturnType<typeof getVmInfo>> | null = null;
  let xml = '';

  try {
    vmInfo = await getVmInfo(vmName);
    vmStateAtBackup = vmInfo.status;
    xml = await getVmXml(vmName);
  } catch (err) {
    await fs.rm(bdir, { recursive: true, force: true });
    throw new Error(`VM "${vmName}" not found: ${err}`);
  }

  // Freeze guest filesystems for app-consistent backup if guest agent is up
  if (vmInfo.status === 'running' && vmInfo.guestAgent) {
    try {
      await execAsync(
        `virsh -c ${config.libvirtUri} qemu-agent-command "${vmName}" '{"execute":"guest-fsfreeze-freeze"}' --timeout 5`,
        { timeout: 10_000 }
      );
      frozen = true;
      consistent = true;
    } catch { /* proceed crash-consistent */ }
  }

  try {
    const disks = await getVmDisks(vmName);
    const diskEntries: BackupDiskEntry[] = [];

    for (const disk of disks) {
      if (disk.type !== 'disk' || !disk.source) continue;

      const destFilename = path.basename(disk.source);
      const destPath = path.join(bdir, destFilename);
      // Fix 9: dropped -p (progress bar has nowhere to go over execAsync)
      const convertFlags = compress ? '-c ' : '';
      await execAsync(
        `qemu-img convert ${convertFlags}-f qcow2 -O qcow2 "${disk.source}" "${destPath}"`,
        { timeout: 60 * 60_000 }
      );
      const stat = await fs.stat(destPath);
      diskEntries.push({
        target: disk.target,
        filename: destFilename,
        format: 'qcow2',
        sizeBytes: stat.size,
        originalPath: disk.source,
      });
    }

    const nics = await getVmNics(vmName);
    const vmMeta = await getVmMeta(vmName);

    const manifest: BackupManifest = {
      id,
      vmName,
      createdAt: new Date().toISOString(),
      virtpilotVersion: VERSION, // Fix 6: from config
      triggerType: opts.triggerType,
      scheduleFrequency: opts.scheduleFrequency,
      consistent,
      vmStateAtBackup,
      hostname: os.hostname(),
      vmConfig: {
        cpus: vmInfo.cpus,
        memoryMb: vmInfo.memoryMb,
      },
      disks: diskEntries,
      nics: nics.map((n) => ({ model: n.model, mac: n.mac, source: n.source })),
      vmMeta,
      libvirtXml: xml,
      retentionDays,
    };

    await fs.writeFile(path.join(bdir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    await fs.writeFile(path.join(bdir, '.complete'), '', 'utf8');

    await appendLog({
      type: 'backup.create',
      subject: vmName,
      status: 'success',
      output: `Backup ${id} created (${diskEntries.length} disk(s), consistent=${consistent})`,
    });

    await applyRetention(vmName);

    const sizeBytes = await dirSizeBytes(bdir);
    return {
      id,
      vmName,
      createdAt: manifest.createdAt,
      sizeBytes,
      consistent,
      triggerType: opts.triggerType,
      scheduleFrequency: opts.scheduleFrequency,
      vmStateAtBackup,
      retentionDays,
      disks: diskEntries,
    };
  } catch (err) {
    await fs.rm(bdir, { recursive: true, force: true }).catch(() => {});
    await appendLog({ type: 'backup.create', subject: vmName, status: 'error', output: String(err) });
    throw err;
  } finally {
    if (frozen) {
      try {
        await execAsync(
          `virsh -c ${config.libvirtUri} qemu-agent-command "${vmName}" '{"execute":"guest-fsfreeze-thaw"}' --timeout 5`,
          { timeout: 10_000 }
        );
      } catch { /* best-effort */ }
    }
  }
}

// ─── Delete backup ────────────────────────────────────────────────────────────

export async function deleteBackup(vmName: string, id: string): Promise<void> {
  const bdir = backupDir(vmName, id);
  await fs.rm(bdir, { recursive: true, force: true });
}

// ─── Restore backup ───────────────────────────────────────────────────────────

export async function restoreBackup(vmName: string, id: string, newVmName?: string): Promise<void> {
  const bdir = backupDir(vmName, id);
  try {
    await fs.access(path.join(bdir, '.complete'));
  } catch {
    throw new Error('Backup is incomplete or corrupt');
  }

  const manifest = await getBackupManifest(vmName, id);
  if (!manifest) throw new Error('Backup manifest not found');

  const targetVmName = newVmName ?? vmName;

  // Fix 2: Refuse to restore over a running VM
  const vmInfo = await getVmInfo(targetVmName).catch(() => null);
  if (vmInfo?.status === 'running') {
    throw new Error(`VM "${targetVmName}" must be stopped before restoring`);
  }

  const targetVmDir = path.join(config.vmsDir, targetVmName);
  await fs.mkdir(targetVmDir, { recursive: true });

  // Fix 3: Write atomically — copy to .restoring temp file, then rename
  // Fix 10: Disk filenames (disk.qcow2, extra-disk-N.qcow2) are never VM-name-prefixed
  for (const disk of manifest.disks) {
    const src = path.join(bdir, disk.filename);
    const dest = path.join(targetVmDir, disk.filename);
    const tmp = dest + '.restoring';
    try {
      await fs.copyFile(src, tmp);
      await fs.rename(tmp, dest);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  await appendLog({
    type: 'backup.restore',
    subject: targetVmName,
    status: 'success',
    output: `Restored from backup ${id} (source VM: ${vmName})`,
  });
}

// ─── Retention ────────────────────────────────────────────────────────────────

// Fix 7: Each backup's stored retentionDays governs its own expiry.
// Falls back to the current global setting for backups that have retentionDays=0
// only when they were created with the "keep forever" policy (retentionDays=0).
export async function applyRetention(vmName: string): Promise<void> {
  const settings = await getUserSettings();
  const schedules = await readSchedules();
  const schedule = schedules[vmName];
  const globalRetention = schedule?.retentionDays != null
    ? schedule.retentionDays
    : settings.backup.retentionDays;

  const backups = await listBackupsForVm(vmName);
  for (const b of backups) {
    // Each backup stores the retention policy that was in effect when it was created.
    // retentionDays=0 means "keep forever" for that specific backup.
    const days = b.retentionDays > 0 ? b.retentionDays : globalRetention;
    if (days === 0) continue;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    if (new Date(b.createdAt).getTime() < cutoff) {
      await deleteBackup(vmName, b.id);
    }
  }
}

export async function applyRetentionAll(): Promise<void> {
  await fs.mkdir(backupRoot(), { recursive: true });
  let vmNames: string[];
  try {
    const entries = await fs.readdir(backupRoot(), { withFileTypes: true });
    vmNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return;
  }
  for (const vmName of vmNames) {
    await applyRetention(vmName).catch(() => {});
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const stat = await fs.stat(path.join(dir, entry.name));
        total += stat.size;
      }
    }
  } catch { /* ignore */ }
  return total;
}

export function computeNextRunAt(schedule: BackupSchedule): Date {
  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0, 0);

  switch (schedule.frequency) {
    case 'hourly':
      next.setMinutes(schedule.minute);
      if (next <= now) next.setHours(next.getHours() + 1);
      break;
    case 'daily':
      next.setHours(schedule.hour, schedule.minute);
      if (next <= now) next.setDate(next.getDate() + 1);
      break;
    case 'weekly': {
      const dayDiff = (schedule.dayOfWeek - now.getDay() + 7) % 7;
      next.setHours(schedule.hour, schedule.minute);
      if (dayDiff === 0 && next <= now) {
        next.setDate(next.getDate() + 7);
      } else {
        next.setDate(next.getDate() + dayDiff);
      }
      break;
    }
    case 'monthly': {
      next.setDate(schedule.dayOfMonth);
      next.setHours(schedule.hour, schedule.minute);
      if (next <= now) {
        next.setMonth(next.getMonth() + 1);
      }
      break;
    }
  }
  return next;
}
