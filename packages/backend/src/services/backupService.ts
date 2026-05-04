import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { config, VERSION } from '../config.js';
import { getUserSettings } from './userSettingsService.js';
import { getVmInfo, getVmXml, getVmNics, getVmDisks } from './vmService.js';
import { getVmMeta } from './vmMetaService.js';
import { appendLog } from './logService.js';
import { virsh, qemuImg } from './safeExec.js';
import { validateVmUuid } from '../lib/validate.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type BackupTrigger = 'manual' | 'scheduled';
export type BackupConsistency = 'app-consistent' | 'offline' | 'crash-consistent';

function deriveConsistency(vmStateAtBackup: string, consistent: boolean): BackupConsistency {
  if (vmStateAtBackup !== 'running') return 'offline';
  return consistent ? 'app-consistent' : 'crash-consistent';
}
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
  vmUuid: string;
  /** Friendly name at backup time — informational only, can become stale */
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
  vmUuid: string;
  vmName: string;
  createdAt: string;
  sizeBytes: number;
  consistency: BackupConsistency;
  triggerType: BackupTrigger;
  scheduleFrequency?: BackupFrequency;
  vmStateAtBackup: string;
  retentionDays: number;
  disks: BackupDiskEntry[];
}

export interface BackupVmSummary {
  vmUuid: string;
  /** Last known friendly name — pulled from the most recent manifest, or schedule */
  vmName: string;
  backupCount: number;
  totalSizeBytes: number;
  lastBackupAt: string | null;
  schedule: BackupSchedule | null;
  // false when the VM has been deleted but its backup metadata directory remains.
  // Lets the UI mark orphan rows as detached and offer a "purge metadata" action.
  vmExists: boolean;
}

export interface BackupSchedule {
  vmUuid: string;
  /** Last known friendly name — for display only */
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
const vmBackupDir = (vmUuid: string) => path.join(backupRoot(), vmUuid);
const backupDir = (vmUuid: string, id: string) => path.join(vmBackupDir(vmUuid), id);
const schedulesFile = () => path.join(config.storageRoot, 'backup-schedules.json');

function backupId(): string {
  const now = new Date();
  return now.toISOString().replace(/[:\-]/g, '').replace('.', '').slice(0, 15) + 'Z'
    + '-' + crypto.randomBytes(3).toString('hex');
}

// ─── Concurrency guard ────────────────────────────────────────────────────────

interface BackupInProgressEntry { vmName: string; startedAt: string; triggerType: BackupTrigger; }
const backupsInProgress = new Map<string, BackupInProgressEntry>();

export function getBackupsInProgress(): Array<{ vmUuid: string; vmName: string; startedAt: string; triggerType: BackupTrigger }> {
  return Array.from(backupsInProgress.entries()).map(([vmUuid, { vmName, startedAt, triggerType }]) => ({
    vmUuid, vmName, startedAt, triggerType,
  }));
}

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

export async function getSchedule(vmUuid: string): Promise<BackupSchedule | null> {
  const all = await readSchedules();
  return all[vmUuid] ?? null;
}

export async function saveSchedule(schedule: BackupSchedule): Promise<void> {
  const all = await readSchedules();
  all[schedule.vmUuid] = schedule;
  await writeSchedules(all);
}

export async function deleteSchedule(vmUuid: string): Promise<void> {
  const all = await readSchedules();
  delete all[vmUuid];
  await writeSchedules(all);
}

// ─── Listing ──────────────────────────────────────────────────────────────────

export async function listBackupsForVm(vmUuid: string): Promise<BackupEntry[]> {
  const dir = vmBackupDir(vmUuid);
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
          vmUuid: manifest.vmUuid,
          vmName: manifest.vmName,
          createdAt: manifest.createdAt,
          sizeBytes,
          consistency: deriveConsistency(manifest.vmStateAtBackup ?? 'running', manifest.consistent),
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

export async function getBackupManifest(vmUuid: string, id: string): Promise<BackupManifest | null> {
  try {
    const raw = await fs.readFile(path.join(backupDir(vmUuid, id), 'manifest.json'), 'utf8');
    return JSON.parse(raw) as BackupManifest;
  } catch {
    return null;
  }
}

export async function listAllVmBackupSummaries(): Promise<BackupVmSummary[]> {
  await fs.mkdir(backupRoot(), { recursive: true });
  let vmUuids: string[];
  try {
    const entries = await fs.readdir(backupRoot(), { withFileTypes: true });
    vmUuids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    vmUuids = [];
  }

  const schedules = await readSchedules();
  // Also include VMs that have a schedule but no backup directory yet
  for (const uuid of Object.keys(schedules)) {
    if (!vmUuids.includes(uuid)) vmUuids.push(uuid);
  }

  const summaries: BackupVmSummary[] = [];
  for (const vmUuid of vmUuids) {
    const backups = await listBackupsForVm(vmUuid);
    const totalSizeBytes = backups.reduce((s, b) => s + b.sizeBytes, 0);
    const lastBackupAt = backups.length > 0 ? backups[0].createdAt : null;
    const vmExists = await getVmInfo(vmUuid).then(() => true).catch(() => false);
    // Resolve a friendly name in this priority: live VM > most recent manifest > schedule
    let vmName = vmUuid;
    try {
      if (vmExists) {
        const info = await getVmInfo(vmUuid);
        vmName = info.name;
      } else if (backups.length > 0) {
        vmName = backups[0].vmName;
      } else if (schedules[vmUuid]?.vmName) {
        vmName = schedules[vmUuid].vmName;
      }
    } catch { /* fall through to UUID display */ }
    summaries.push({
      vmUuid,
      vmName,
      backupCount: backups.length,
      totalSizeBytes,
      lastBackupAt,
      schedule: schedules[vmUuid] ?? null,
      vmExists,
    });
  }
  return summaries;
}

// ─── Create backup ────────────────────────────────────────────────────────────

export async function createBackup(
  vmUuid: string,
  opts: { triggerType: BackupTrigger; scheduleFrequency?: BackupFrequency; retentionDaysOverride?: number | null }
): Promise<BackupEntry> {
  if (backupsInProgress.has(vmUuid)) {
    throw new Error(`Backup already in progress for VM "${vmUuid}"`);
  }
  // The friendly name is captured at backup time; fallback to UUID if lookup fails.
  let vmName = vmUuid;
  try {
    const info = await getVmInfo(vmUuid);
    vmName = info.name;
  } catch { /* VM may already be undefined — proceed with UUID as the label */ }
  backupsInProgress.set(vmUuid, { vmName, startedAt: new Date().toISOString(), triggerType: opts.triggerType });

  try {
    return await _createBackupInner(vmUuid, vmName, opts);
  } finally {
    backupsInProgress.delete(vmUuid);
  }
}

async function _createBackupInner(
  vmUuid: string,
  vmName: string,
  opts: { triggerType: BackupTrigger; scheduleFrequency?: BackupFrequency; retentionDaysOverride?: number | null }
): Promise<BackupEntry> {
  const settings = await getUserSettings();
  const retentionDays = opts.retentionDaysOverride != null ? opts.retentionDaysOverride : settings.backup.retentionDays;
  const compress = settings.backup.compression;

  const id = backupId();
  const bdir = backupDir(vmUuid, id);
  await fs.mkdir(bdir, { recursive: true });
  // qemu-img convert runs as libvirt-qemu (see below) and writes the
  // destination qcow2 here. libvirt-qemu is in the `virtpilot` group via
  // install.sh, so g+w on bdir and its vmUuid parent gets the write through
  // without widening anything to other.
  await fs.chmod(path.dirname(bdir), 0o770);
  await fs.chmod(bdir, 0o770);

  let consistent = false;
  let frozen = false;
  let vmStateAtBackup = 'unknown';
  let vmInfo: Awaited<ReturnType<typeof getVmInfo>> | null = null;
  let xml = '';

  try {
    vmInfo = await getVmInfo(vmUuid);
    vmStateAtBackup = vmInfo.status;
    xml = await getVmXml(vmUuid);
  } catch (err) {
    await fs.rm(bdir, { recursive: true, force: true });
    throw new Error(`VM "${vmUuid}" not found: ${err}`);
  }

  // Freeze guest filesystems for app-consistent backup if guest agent is up
  if (vmInfo.status === 'running' && vmInfo.guestAgent) {
    try {
      await virsh(
        ['qemu-agent-command', validateVmUuid(vmUuid), '{"execute":"guest-fsfreeze-freeze"}', '--timeout', '5'],
        { timeout: 10_000 }
      );
      frozen = true;
      consistent = true;
    } catch { /* proceed crash-consistent */ }
  }

  try {
    const disks = await getVmDisks(vmUuid);
    const diskEntries: BackupDiskEntry[] = [];

    for (const disk of disks) {
      if (disk.type !== 'disk' || !disk.source) continue;

      const destFilename = path.basename(disk.source);
      const destPath = path.join(bdir, destFilename);
      const convertArgs = ['convert', '-U'];
      if (compress) convertArgs.push('-c');
      convertArgs.push('-f', 'qcow2', '-O', 'qcow2', disk.source, destPath);
      await qemuImg(convertArgs, { timeout: 60 * 60_000 });
      const stat = await fs.stat(destPath);
      diskEntries.push({
        target: disk.target,
        filename: destFilename,
        format: 'qcow2',
        sizeBytes: stat.size,
        originalPath: disk.source,
      });
    }

    const nics = await getVmNics(vmUuid);
    const vmMeta = await getVmMeta(vmUuid);

    const manifest: BackupManifest = {
      id,
      vmUuid,
      vmName,
      createdAt: new Date().toISOString(),
      virtpilotVersion: VERSION,
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
      subjectUuid: vmUuid,
      status: 'success',
      output: `Backup ${id} created (${diskEntries.length} disk(s), consistent=${consistent})`,
    });

    await applyRetention(vmUuid);

    const sizeBytes = await dirSizeBytes(bdir);
    return {
      id,
      vmUuid,
      vmName,
      createdAt: manifest.createdAt,
      sizeBytes,
      consistency: deriveConsistency(vmStateAtBackup, consistent),
      triggerType: opts.triggerType,
      scheduleFrequency: opts.scheduleFrequency,
      vmStateAtBackup,
      retentionDays,
      disks: diskEntries,
    };
  } catch (err) {
    await fs.rm(bdir, { recursive: true, force: true }).catch(() => {});
    await appendLog({ type: 'backup.create', subject: vmName, subjectUuid: vmUuid, status: 'error', output: String(err) });
    throw err;
  } finally {
    if (frozen) {
      try {
        await virsh(
          ['qemu-agent-command', validateVmUuid(vmUuid), '{"execute":"guest-fsfreeze-thaw"}', '--timeout', '5'],
          { timeout: 10_000 }
        );
      } catch { /* best-effort */ }
    }
  }
}

// ─── Delete backup ────────────────────────────────────────────────────────────

export async function deleteBackup(vmUuid: string, id: string): Promise<void> {
  const bdir = backupDir(vmUuid, id);
  await fs.rm(bdir, { recursive: true, force: true });
}

// ─── Restore backup ───────────────────────────────────────────────────────────

/**
 * Restores a backup's disk files into the target VM's storage directory. The
 * target is identified by UUID — restore-into-an-existing-VM only. Creating a
 * brand-new VM from a backup is a separate, future flow.
 */
export async function restoreBackup(sourceVmUuid: string, id: string, targetVmUuidArg?: string): Promise<void> {
  const bdir = backupDir(sourceVmUuid, id);
  try {
    await fs.access(path.join(bdir, '.complete'));
  } catch {
    throw new Error('Backup is incomplete or corrupt');
  }

  const manifest = await getBackupManifest(sourceVmUuid, id);
  if (!manifest) throw new Error('Backup manifest not found');

  // The restore target's UUID must be a valid UUID — never a free-form name.
  const targetVmUuid = validateVmUuid(targetVmUuidArg ?? sourceVmUuid);

  const vmInfo = await getVmInfo(targetVmUuid).catch(() => null);
  if (vmInfo?.status === 'running') {
    throw new Error(`VM "${targetVmUuid}" must be stopped before restoring`);
  }

  const targetVmDir = path.join(config.vmsDir, targetVmUuid);
  await fs.mkdir(targetVmDir, { recursive: true });

  // Disk filenames (disk.qcow2, extra-disk-N.qcow2) are not VM-name-prefixed.
  // Defend against a manifest crafted with `disk.filename = "../../etc/cron.d/x"`:
  // strip directory components and validate the leaf name before joining.
  for (const disk of manifest.disks) {
    const safeFilename = path.basename(disk.filename);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.qcow2$/i.test(safeFilename)) {
      throw new Error(`Refusing to restore: invalid disk filename in manifest (${disk.filename})`);
    }
    const src = path.join(bdir, safeFilename);
    const dest = path.join(targetVmDir, safeFilename);
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
    subject: vmInfo?.name ?? targetVmUuid,
    subjectUuid: targetVmUuid,
    status: 'success',
    output: `Restored from backup ${id} (source VM: ${manifest.vmName})`,
  });
}

// ─── Retention ────────────────────────────────────────────────────────────────

// Each backup's stored retentionDays governs its own expiry. Falls back to
// the current global setting only when the backup was created with the
// "keep forever" policy (retentionDays=0).
export async function applyRetention(vmUuid: string): Promise<void> {
  const settings = await getUserSettings();
  const schedules = await readSchedules();
  const schedule = schedules[vmUuid];
  const globalRetention = schedule?.retentionDays != null
    ? schedule.retentionDays
    : settings.backup.retentionDays;

  const backups = await listBackupsForVm(vmUuid);
  for (const b of backups) {
    const days = b.retentionDays > 0 ? b.retentionDays : globalRetention;
    if (days === 0) continue;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    if (new Date(b.createdAt).getTime() < cutoff) {
      await deleteBackup(vmUuid, b.id);
    }
  }
}

export async function applyRetentionAll(): Promise<void> {
  await fs.mkdir(backupRoot(), { recursive: true });
  let vmUuids: string[];
  try {
    const entries = await fs.readdir(backupRoot(), { withFileTypes: true });
    vmUuids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return;
  }
  for (const vmUuid of vmUuids) {
    await applyRetention(vmUuid).catch(() => {});
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
