import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { config, VERSION } from '../config.js';
import { getUserSettings } from './userSettingsService.js';
import { getVmInfo, getVmXml, getVmNics, getVmDisks, refreshDomainBackingChain } from './vmService.js';
import { getVmMeta, type VmMeta } from './vmMetaService.js';
import { appendLog } from './logService.js';
import { qemuImg } from './safeExec.js';
import { encryptSecret, decryptSecret } from '../lib/secretsCrypto.js';
import { validateVmUuid } from '../lib/validate.js';
import * as storageDirService from './storageDirService.js';
import * as libvirtBackup from './libvirtBackupService.js';
import { copyVmDisks, type CopyMethod, type DiskCopySpec } from './diskCopyService.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type BackupTrigger = 'manual' | 'scheduled';
export type BackupConsistency = 'app-consistent' | 'offline' | 'crash-consistent';
export type BackupKind = 'full' | 'incremental';
/** What the caller asked for; `auto` lets the schedule's policy decide. */
export type BackupKindRequest = BackupKind | 'auto';

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
  /**
   * Relative backing-file path recorded inside the qcow2 for incrementals
   * (`../<parentBackupId>/<filename>`). Absent on full backups.
   */
  backingFilename?: string;
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
  /** Absent on manifests written before 2.7 — treat as 'full'. */
  kind?: BackupKind;
  /** The backup this one's changed blocks are layered on top of. */
  parentBackupId?: string;
  /** libvirt checkpoint created with this backup, enabling the next incremental. */
  checkpointName?: string;
  /**
   * The run asked to extend an incremental chain — i.e. it was an explicit
   * incremental request or a schedule running in incremental mode.
   *
   * Recorded so a full backup that never *tried* to chain (the normal case for
   * a full-mode schedule, and for every backup written before 2.9) can be told
   * apart from one that tried and could not. Absent on older manifests, which
   * are therefore never counted as degraded.
   */
  chainRequested?: boolean;
  method?: CopyMethod;
  compressed?: boolean;
  /** Operator-facing explanations of any fallback taken while copying. */
  notes?: string[];
  consistent: boolean;
  vmStateAtBackup: string;
  hostname: string;
  vmConfig: {
    cpus: number;
    memoryMb: number;
  };
  disks: BackupDiskEntry[];
  nics: Array<{ model: string; mac: string; source: string }>;
  /**
   * VM metadata as of the backup, used to rebuild cloud-init when restoring
   * into a new VM. The guest password inside is encrypted at rest — manifests
   * written before 2.7 hold it in plain text and are read transparently.
   */
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
  kind: BackupKind;
  parentBackupId?: string;
  method?: CopyMethod;
  compressed?: boolean;
  notes?: string[];
  /**
   * This backup left a libvirt checkpoint behind, so the next run can chain an
   * incremental onto it. Only ever true for a run taken with incremental
   * backups switched on *and* copied by the libvirt push-mode tier.
   */
  hasCheckpoint: boolean;
  /** This run tried to extend an incremental chain. See `BackupManifest.chainRequested`. */
  chainRequested: boolean;
  /** An ancestor this backup's data depends on is missing — not restorable. */
  chainBroken: boolean;
  /** Another backup layers on top of this one, so it cannot be deleted alone. */
  hasDependents: boolean;
  /** Total on-disk size of this backup plus every ancestor it needs. */
  chainSizeBytes: number;
  /** Result of the last explicit verification, if it has ever been run. */
  lastVerify?: BackupVerifyRecord;
}

/** Outcome of checking one image in a backup's chain. */
export interface BackupVerifyLink {
  backupId: string;
  kind: BackupKind;
  target: string;
  filename: string;
  present: boolean;
  ok: boolean;
  detail?: string;
}

export interface BackupVerifyResult {
  backupId: string;
  ok: boolean;
  checkedAt: string;
  /** Root-most link first, so a reader sees the full backup before its deltas. */
  links: BackupVerifyLink[];
  summary: string;
}

/** Persisted alongside a backup so the UI can show when it was last proved good. */
export interface BackupVerifyRecord {
  checkedAt: string;
  ok: boolean;
  summary: string;
}

export interface BackupVmSummary {
  vmUuid: string;
  /** Last known friendly name — pulled from the most recent manifest, or schedule */
  vmName: string;
  backupCount: number;
  totalSizeBytes: number;
  /**
   * Bytes held by backup directories with no usable manifest. Counted
   * separately so `totalSizeBytes` still means "size of the backups you can
   * actually restore", while the disk the operator has to account for is the
   * sum of the two.
   */
  unusableSizeBytes: number;
  unusableCount: number;
  lastBackupAt: string | null;
  schedule: BackupSchedule | null;
  // false when the VM has been deleted but its backup metadata directory remains.
  // Lets the UI mark orphan rows as detached and offer a "purge metadata" action.
  vmExists: boolean;
}

/** How a schedule decides between full and incremental runs. */
export type BackupScheduleMode = 'full' | 'incremental';

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
  /**
   * How the last scheduled run ended. Recorded on the schedule itself rather
   * than left to the activity log, so a silently failing backup is visible
   * where the operator already looks instead of needing journalctl.
   */
  lastRunStatus?: 'success' | 'error';
  lastError?: string;
  /** Absent on schedules written before 2.7 — treat as 'full'. */
  mode?: BackupScheduleMode;
  /**
   * Incremental mode only: take a fresh full backup once the chain reaches this
   * many links. Without it a chain grows forever and one corrupt link costs
   * every backup after it.
   */
  fullEvery?: number;
}

export const DEFAULT_FULL_EVERY = 7;
export const MAX_FULL_EVERY = 60;

// ─── Paths ────────────────────────────────────────────────────────────────────

const backupRoot = () => config.backupRoot;
const vmBackupDir = (vmUuid: string) => path.join(backupRoot(), vmUuid);
const backupDir = (vmUuid: string, id: string) => path.join(vmBackupDir(vmUuid), id);
const schedulesFile = () => path.join(config.storageRoot, 'backup-schedules.json');

/** Absolute path of a backup's directory. Exported for the restore-as-new flow. */
export function getBackupDir(vmUuid: string, id: string): string {
  return backupDir(vmUuid, id);
}

function backupId(): string {
  const now = new Date();
  return now.toISOString().replace(/[:\-]/g, '').replace('.', '').slice(0, 15) + 'Z'
    + '-' + crypto.randomBytes(3).toString('hex');
}

// ─── Manifest secret handling ────────────────────────────────────────────────

// The manifest carries the VM's cloud-init credentials so a restore into a new
// VM can regenerate a working seed. Storing that in plain text put the guest
// password in every backup directory; it is encrypted with the same key as
// vm-metadata.json now. decryptSecret passes legacy plaintext through unchanged,
// so manifests written before 2.7 keep working.
function encodeMetaForManifest(meta: VmMeta | null): unknown {
  if (!meta) return null;
  return { ...meta, password: encryptSecret(meta.password) ?? '' };
}

export function decodeMetaFromManifest(raw: unknown): VmMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const meta = raw as VmMeta;
  let password = '';
  try {
    password = decryptSecret(meta.password) ?? '';
  } catch {
    // A rotated ENCRYPTION_KEY must not make the whole backup unrestorable —
    // only the credential is lost, and the caller can supply a new one.
    password = '';
  }
  return { ...meta, password };
}

// ─── Concurrency guard ────────────────────────────────────────────────────────

interface BackupInProgressEntry {
  vmName: string;
  startedAt: string;
  triggerType: BackupTrigger;
  /** Filled in once the id is minted, so scans can skip the directory in flight. */
  backupId?: string;
}
const backupsInProgress = new Map<string, BackupInProgressEntry>();

export function getBackupsInProgress(): Array<{ vmUuid: string; vmName: string; startedAt: string; triggerType: BackupTrigger }> {
  return Array.from(backupsInProgress.entries()).map(([vmUuid, { vmName, startedAt, triggerType }]) => ({
    vmUuid, vmName, startedAt, triggerType,
  }));
}

// ─── Schedule persistence ─────────────────────────────────────────────────────

/**
 * Reads the schedule store.
 *
 * Only a genuinely absent file counts as "no schedules". Anything else — a
 * truncated write, a JSON syntax error, EACCES after a botched chown — throws.
 * Swallowing those into `{}` was indistinguishable from an empty store, and the
 * next `saveSchedule` would then persist that emptiness, permanently deleting
 * every other VM's schedule while the scheduler silently stopped backing
 * anything up. Callers that only display schedules use `readSchedulesForDisplay`.
 */
export async function readSchedules(): Promise<Record<string, BackupSchedule>> {
  let raw: string;
  try {
    raw = await fs.readFile(schedulesFile(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    throw new Error(`Could not read ${schedulesFile()}: ${String(err)}`);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object of vmUuid -> schedule');
    }
    return parsed as Record<string, BackupSchedule>;
  } catch (err) {
    throw new Error(`${schedulesFile()} is corrupt and was left untouched: ${String(err)}`);
  }
}

/**
 * The read-only variant, for pages that list schedules alongside other data.
 * A corrupt store degrades those views to "no schedule" instead of 500-ing the
 * whole backups page — but it is logged, and it can never reach a write path.
 */
export async function readSchedulesForDisplay(): Promise<Record<string, BackupSchedule>> {
  try {
    return await readSchedules();
  } catch (err) {
    console.error(`[backup] ${String(err)}`);
    return {};
  }
}

export async function writeSchedules(schedules: Record<string, BackupSchedule>): Promise<void> {
  // Write-then-rename: a plain writeFile truncates first, so a crash or a full
  // filesystem mid-write leaves an unparseable store behind. rename(2) within
  // one directory is atomic, so a reader sees either the old file or the new one.
  const target = schedulesFile();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(schedules, null, 2), 'utf8');
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function getSchedule(vmUuid: string): Promise<BackupSchedule | null> {
  const all = await readSchedules();
  return all[vmUuid] ?? null;
}

/** Display-path lookup — a corrupt store reads as "no schedule" rather than an error. */
export async function getScheduleForDisplay(vmUuid: string): Promise<BackupSchedule | null> {
  return (await readSchedulesForDisplay())[vmUuid] ?? null;
}

// saveSchedule/deleteSchedule are read-modify-writes of one shared file, and the
// scheduler fires every due VM concurrently (all schedules created through the
// dialog default to 02:00, so several really do land in the same tick). Without
// this, two writers both read the pre-update snapshot and the second silently
// reverts the first — losing a freshly computed nextRunAt, or an operator's mode
// change saved while a scheduler write was in flight.
let scheduleWriteQueue: Promise<unknown> = Promise.resolve();

function withScheduleLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = scheduleWriteQueue.then(fn, fn);
  // Keep the chain alive after a rejection, but never leave it unhandled.
  scheduleWriteQueue = run.catch(() => {});
  return run;
}

export async function saveSchedule(schedule: BackupSchedule): Promise<void> {
  await withScheduleLock(async () => {
    const all = await readSchedules();
    all[schedule.vmUuid] = schedule;
    await writeSchedules(all);
  });
}

/**
 * Builds and stores a VM's schedule with the current stored value in hand,
 * entirely inside the lock.
 *
 * `getSchedule` then `saveSchedule` looks equivalent but is not: the read
 * happens outside the lock, so a scheduler write landing in between is read
 * back stale and written over. That matters for the fields the caller is
 * *preserving* rather than setting — `lastRunAt`, `lastRunStatus`, `lastError`
 * — which is exactly what a run in flight is updating.
 *
 * The mutator receives null when no schedule exists yet.
 */
export async function updateSchedule(
  vmUuid: string,
  build: (current: BackupSchedule | null) => BackupSchedule,
): Promise<BackupSchedule> {
  return withScheduleLock(async () => {
    const all = await readSchedules();
    const next = build(all[vmUuid] ?? null);
    all[vmUuid] = next;
    await writeSchedules(all);
    return next;
  });
}

export async function deleteSchedule(vmUuid: string): Promise<void> {
  await withScheduleLock(async () => {
    const all = await readSchedules();
    delete all[vmUuid];
    await writeSchedules(all);
  });
}

// ─── Listing ──────────────────────────────────────────────────────────────────

/** A backup directory that carries no usable manifest, and why. */
export interface UnusableBackupDir {
  id: string;
  /**
   * `incomplete` — no `.complete` marker: a run that never finished.
   * `unreadable` — marked complete, but the manifest could not be read or parsed.
   */
  why: 'incomplete' | 'unreadable';
  detail?: string;
  sizeBytes: number;
  mtimeMs: number;
}

interface ManifestScan {
  manifests: BackupManifest[];
  unusable: UnusableBackupDir[];
}

/**
 * Whether a directory with no usable manifest is the backup being written right
 * now, and so should not be reported as leftover data.
 *
 * Narrow on purpose. It answers only "is this junk?", and is never consulted
 * about a directory that *does* hold a readable manifest — a backup that has
 * finished writing its manifest is still registered as in progress for the rest
 * of `_createBackupInner`, and hiding it there cost that backup its checkpoint.
 * Only `incomplete` qualifies: a directory whose manifest cannot be read is a
 * real problem whether or not a backup is running.
 */
export function isSuppressedInFlightDir(
  dir: Pick<UnusableBackupDir, 'id' | 'why'>,
  inFlightId: string | undefined,
): boolean {
  return dir.why === 'incomplete' && inFlightId !== undefined && dir.id === inFlightId;
}

/**
 * Reads every backup manifest under a VM, and reports the directories it could
 * not use rather than silently dropping them.
 *
 * The distinction matters because both retention and checkpoint reconciliation
 * act destructively on the result. A manifest that is merely *unreadable* — a
 * transient EIO, an NFS stall, a truncated file — used to be indistinguishable
 * from a backup that does not exist, which made an incremental's parent look
 * like a childless leaf and let retention delete it. The peel loop then
 * cascaded, so one bad read could take the whole chain.
 */
async function scanManifests(vmUuid: string): Promise<ManifestScan> {
  const dir = vmBackupDir(vmUuid);
  let subdirs: string[];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { manifests: [], unusable: [] };
  }

  // The backup this VM is copying right now has no `.complete` marker yet, and
  // reporting it as leftover junk while its progress bar is on screen is both
  // alarming and wrong. The sweep already skips it; the alert and the size
  // totals have to as well.
  //
  // This ONLY suppresses the unusable classification, never a manifest — see
  // the filter below. Skipping the directory outright was a genuine disaster:
  // `reconcileCheckpoints` runs at the end of `_createBackupInner`, while the
  // in-progress entry is still registered, so hiding the directory hid the
  // manifest that had just been written — and reconcile then deleted the
  // checkpoint that backup had just created as unreferenced. Every
  // incremental-mode run destroyed its own checkpoint and left a manifest
  // claiming otherwise, so no chain could ever form.
  const inFlightId = backupsInProgress.get(vmUuid)?.backupId;

  const results = await Promise.all(
    subdirs.map(async (entry): Promise<BackupManifest | UnusableBackupDir> => {
      const bdir = path.join(dir, entry);
      const describe = async (why: UnusableBackupDir['why'], detail?: string): Promise<UnusableBackupDir> => ({
        id: entry,
        why,
        detail,
        sizeBytes: await dirSizeBytes(bdir),
        // The newest timestamp anywhere in the directory, not the directory's
        // own. A directory's mtime only moves when an entry is created or
        // removed, and a push-mode backup creates all its target files up front
        // and then writes into them for hours — so the directory alone can look
        // untouched since the job started while qemu is still filling it.
        mtimeMs: await newestMtimeMs(bdir),
      });

      try {
        await fs.access(path.join(bdir, '.complete'));
      } catch (err) {
        // Only a genuinely absent marker means "never finished". A permissions
        // or I/O error on the probe says nothing about the backup, and letting
        // it read as `incomplete` would put a complete backup in front of the
        // sweep's rm -rf.
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return describe('incomplete');
        return describe('unreadable', `could not check the completion marker: ${String(err).slice(0, 160)}`);
      }
      try {
        const raw = await fs.readFile(path.join(bdir, 'manifest.json'), 'utf8');
        return JSON.parse(raw) as BackupManifest;
      } catch (err) {
        return describe('unreadable', String(err).slice(0, 200));
      }
    }),
  );

  const manifests: BackupManifest[] = [];
  const unusable: UnusableBackupDir[] = [];
  for (const r of results) {
    if (!('why' in r)) {
      // A readable manifest is always reported, in-flight or not. Everything
      // downstream — the chain walk, retention, checkpoint reconciliation —
      // depends on seeing every backup that exists.
      manifests.push(r);
    } else if (!isSuppressedInFlightDir(r, inFlightId)) {
      unusable.push(r);
    }
  }
  return { manifests, unusable };
}

async function readManifests(vmUuid: string): Promise<BackupManifest[]> {
  return (await scanManifests(vmUuid)).manifests;
}

/**
 * Backup directories carrying no usable manifest — leftovers from a run the
 * backend died in the middle of, or a backup whose manifest has gone bad.
 *
 * Exported because nothing else in the product could see them: they are
 * filtered out of every listing, so their bytes were absent from every size
 * total VirtPilot reports while still occupying the disk.
 */
export async function listUnusableBackupDirs(vmUuid: string): Promise<UnusableBackupDir[]> {
  return (await scanManifests(vmUuid)).unusable;
}

export async function listBackupsForVm(vmUuid: string): Promise<BackupEntry[]> {
  return listBackupsFromScan(vmUuid, await scanManifests(vmUuid));
}

// Takes the scan rather than re-running it, because callers that need both the
// backups and the unusable directories would otherwise walk the whole backup
// tree twice per request — a readdir, a `.complete` probe, a manifest read and
// a size walk per backup, on a page that polls every 30 seconds.
function listBackupsFromScan(vmUuid: string, scan: ManifestScan): Promise<BackupEntry[]> {
  return buildBackupEntries(vmUuid, scan.manifests);
}

async function buildBackupEntries(vmUuid: string, manifests: BackupManifest[]): Promise<BackupEntry[]> {
  const byId = new Map(manifests.map((m) => [m.id, m]));

  const sizes = new Map<string, number>();
  const verifies = new Map<string, BackupVerifyRecord>();
  await Promise.all(
    manifests.map(async (m) => {
      sizes.set(m.id, await dirSizeBytes(backupDir(vmUuid, m.id)));
      const rec = await readVerifyRecord(vmUuid, m.id);
      if (rec) verifies.set(m.id, rec);
    }),
  );

  const dependents = new Set<string>();
  for (const m of manifests) {
    if (m.parentBackupId) dependents.add(m.parentBackupId);
  }

  // Walk to the root of the chain. A missing link anywhere above means the
  // image cannot be read end to end, so the backup is not restorable — say so
  // rather than letting the operator find out during a recovery.
  const walkChain = (m: BackupManifest): { broken: boolean; totalBytes: number } => {
    let totalBytes = 0;
    const seen = new Set<string>();
    let cur: BackupManifest | undefined = m;
    while (cur) {
      if (seen.has(cur.id)) return { broken: true, totalBytes }; // cycle — corrupt metadata
      seen.add(cur.id);
      totalBytes += sizes.get(cur.id) ?? 0;
      if ((cur.kind ?? 'full') === 'full' || !cur.parentBackupId) return { broken: false, totalBytes };
      const parent: BackupManifest | undefined = byId.get(cur.parentBackupId);
      if (!parent) return { broken: true, totalBytes };
      cur = parent;
    }
    return { broken: true, totalBytes };
  };

  return manifests
    .map((m): BackupEntry => {
      const { broken, totalBytes } = walkChain(m);
      return {
        id: m.id,
        vmUuid: m.vmUuid,
        vmName: m.vmName,
        createdAt: m.createdAt,
        sizeBytes: sizes.get(m.id) ?? 0,
        consistency: deriveConsistency(m.vmStateAtBackup ?? 'running', m.consistent),
        triggerType: m.triggerType,
        scheduleFrequency: m.scheduleFrequency,
        vmStateAtBackup: m.vmStateAtBackup,
        retentionDays: m.retentionDays,
        disks: m.disks,
        kind: m.kind ?? 'full',
        parentBackupId: m.parentBackupId,
        method: m.method,
        compressed: m.compressed,
        notes: m.notes,
        hasCheckpoint: !!m.checkpointName,
        chainRequested: !!m.chainRequested,
        chainBroken: broken,
        hasDependents: dependents.has(m.id),
        chainSizeBytes: totalBytes,
        ...(verifies.has(m.id) ? { lastVerify: verifies.get(m.id) } : {}),
      };
    })
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

  const schedules = await readSchedulesForDisplay();
  // Also include VMs that have a schedule but no backup directory yet
  for (const uuid of Object.keys(schedules)) {
    if (!vmUuids.includes(uuid)) vmUuids.push(uuid);
  }

  const summaries: BackupVmSummary[] = [];
  for (const vmUuid of vmUuids) {
    const scan = await scanManifests(vmUuid);
    const backups = await listBackupsFromScan(vmUuid, scan);
    const unusable = scan.unusable;
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
      unusableSizeBytes: unusable.reduce((s, u) => s + u.sizeBytes, 0),
      unusableCount: unusable.length,
      lastBackupAt,
      schedule: schedules[vmUuid] ?? null,
      vmExists,
    });
  }
  return summaries;
}

// ─── Incremental chain planning ──────────────────────────────────────────────

export interface IncrementalReadiness {
  /** True when the next backup can legitimately be an incremental. */
  ready: boolean;
  parent?: BackupEntry;
  parentCheckpoint?: string;
  /** Number of incrementals already layered on the most recent full. */
  chainLength: number;
  /** Why an incremental is not possible right now. */
  reason?: string;
  /**
   * There is nothing to chain onto because this VM has no backups at all.
   *
   * A flag rather than a comparison against `reason`: the previous version of
   * this code tested `reason !== 'no full backup exists yet'`, and rewording
   * that string silently made the branch it guarded unreachable.
   */
  firstBackup?: boolean;
}

/**
 * Decides whether an incremental can be taken, and from where.
 *
 * Every condition here is a hard requirement of qemu's dirty-bitmap machinery:
 * the parent's checkpoint has to still exist inside libvirt (the bitmap lives
 * in the qcow2, not in our manifest), the domain has to be running for libvirt
 * to read it, and the parent's own chain has to be intact or the new link would
 * extend a chain that cannot be read back.
 */
export async function assessIncrementalReadiness(vmUuid: string, running: boolean): Promise<IncrementalReadiness> {
  const backups = await listBackupsForVm(vmUuid);
  const chainLength = countChainLength(backups);

  if (!running) {
    return { ready: false, chainLength, reason: 'the VM is not running (libvirt cannot read dirty bitmaps from a stopped domain)' };
  }
  if (!(await libvirtBackup.isBackupSupported())) {
    return { ready: false, chainLength, reason: 'this host\'s libvirt/qemu does not support incremental backup' };
  }

  // The newest complete backup is the only valid parent: chaining onto an older
  // one would silently discard everything written since.
  const parent = backups.find((b) => !b.chainBroken);
  if (!parent) {
    return { ready: false, chainLength, firstBackup: true, reason: 'this is the first backup of this VM' };
  }
  if (parent.id !== backups[0]?.id) {
    return { ready: false, chainLength, reason: 'the most recent backup is unreadable, so a new link would be built on a broken chain' };
  }

  const manifest = await getBackupManifest(vmUuid, parent.id);
  const checkpoint = manifest?.checkpointName;
  if (!checkpoint) {
    // Says what is missing and why it is missing. A backup only carries a
    // checkpoint when it was itself taken with incremental backups switched on,
    // so a perfectly good full backup legitimately has none — and the previous
    // wording ("the previous backup did not record a checkpoint") read as a
    // fault in that backup instead of a consequence of the mode setting.
    return {
      ready: false,
      chainLength,
      reason: 'the previous backup carries no checkpoint to measure changes against '
        + '(only backups taken with incremental backups switched on record one)',
    };
  }
  if (!(await libvirtBackup.checkpointExists(vmUuid, checkpoint))) {
    return { ready: false, chainLength, reason: `checkpoint "${checkpoint}" no longer exists in libvirt` };
  }

  return { ready: true, parent, parentCheckpoint: checkpoint, chainLength };
}

export interface IncrementalStatus {
  /** The host's libvirt/qemu can do incremental backups at all. */
  supported: boolean;
  /** Incrementals currently stacked on the newest full backup. */
  chainLength: number;
  /** The newest backup recorded a checkpoint, so the next run could chain onto it. */
  canChain: boolean;
}

/**
 * Cheap enough to answer on every poll of the backups page: reads manifests off
 * disk and the cached capability probe, but never asks libvirt to enumerate
 * checkpoints. The authoritative check happens in `assessIncrementalReadiness`
 * when a backup actually runs.
 */
export async function getIncrementalStatus(vmUuid: string): Promise<IncrementalStatus> {
  const supported = await libvirtBackup.isBackupSupported();
  const backups = await listBackupsForVm(vmUuid);
  const newest = backups[0];
  let canChain = false;
  if (newest && !newest.chainBroken) {
    const manifest = await getBackupManifest(vmUuid, newest.id);
    canChain = !!manifest?.checkpointName;
  }
  return { supported, chainLength: countChainLength(backups), canChain };
}

/**
 * The filename a disk's backup image should carry: the VM's own disk, not a
 * transient overlay stacked on top of it.
 *
 * Walks the backing chain outwards-in and returns the first link that VirtPilot
 * actually tracks as one of this VM's disks. That stops one link short of the
 * template a VM was created from — a template is shared, and naming a backup
 * after it would be both wrong and dangerous on restore.
 */
async function canonicalDiskFilename(vmUuid: string, source: string): Promise<string> {
  const base = path.basename(source);
  let recorded: Set<string>;
  try {
    const locs = await storageDirService.listDiskLocationsForVm(vmUuid);
    recorded = new Set(locs.map((l) => l.diskFilename));
  } catch {
    return base;
  }
  // Nothing tracked (a VM defined outside VirtPilot) — take the live name.
  if (recorded.size === 0 || recorded.has(base)) return base;

  try {
    const out = await qemuImg(['info', '-U', '--output=json', '--backing-chain', source], { timeout: 60_000 });
    const chain = JSON.parse(out) as Array<{ filename?: string }>;
    for (const link of chain) {
      if (!link.filename) continue;
      const name = path.basename(link.filename);
      if (recorded.has(name)) return name;
    }
  } catch {
    // Unreadable chain — fall back to the live name rather than failing the backup.
  }
  return base;
}

/** How many incrementals sit on top of the most recent full backup. */
function countChainLength(backups: BackupEntry[]): number {
  let n = 0;
  for (const b of backups) {
    // backups are newest-first
    if (b.kind === 'incremental') n++;
    else break;
  }
  return n;
}

// ─── Create backup ────────────────────────────────────────────────────────────

export interface CreateBackupOptions {
  triggerType: BackupTrigger;
  scheduleFrequency?: BackupFrequency;
  retentionDaysOverride?: number | null;
  /** `auto` resolves against the schedule's mode; defaults to a full backup. */
  kind?: BackupKindRequest;
  /** Incremental-mode schedules force a full once the chain reaches this length. */
  fullEvery?: number;
}

export async function createBackup(vmUuid: string, opts: CreateBackupOptions): Promise<BackupEntry> {
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
  opts: CreateBackupOptions,
): Promise<BackupEntry> {
  const settings = await getUserSettings();
  const retentionDays = opts.retentionDaysOverride != null ? opts.retentionDaysOverride : settings.backup.retentionDays;
  const compress = settings.backup.compression;

  const id = backupId();
  // Published before the directory exists, so no scan can ever see the
  // directory without also knowing a backup is being written into it.
  const inProgress = backupsInProgress.get(vmUuid);
  if (inProgress) inProgress.backupId = id;

  const bdir = backupDir(vmUuid, id);
  await fs.mkdir(bdir, { recursive: true });
  // The copy runs as libvirt-qemu (either qemu-img via sudo, or the qemu
  // process itself for push-mode backups) and writes the destination image
  // here. libvirt-qemu is in the `virtpilot` group via install.sh, so g+w on
  // bdir and its vmUuid parent gets the write through without widening
  // anything to other.
  await fs.chmod(path.dirname(bdir), 0o770);
  await fs.chmod(bdir, 0o770);

  let vmStateAtBackup = 'unknown';
  let vmInfo: Awaited<ReturnType<typeof getVmInfo>> | null = null;
  let xml = '';

  try {
    vmInfo = await getVmInfo(vmUuid);
    vmStateAtBackup = vmInfo.status;
    // Captured before any snapshot so the recorded XML names the VM's real disk
    // paths, not a transient overlay. This is what a restore-into-a-new-VM
    // rebuilds the domain from.
    xml = await getVmXml(vmUuid);
  } catch (err) {
    await fs.rm(bdir, { recursive: true, force: true });
    throw new Error(`VM "${vmUuid}" not found: ${err}`);
  }

  const running = vmInfo.status === 'running';
  const notes: string[] = [];
  // Flipped the moment the backup becomes restorable on disk, so the error
  // path can tell "the copy failed, clean up after it" from "the copy worked
  // and something afterwards went wrong".
  let succeeded = false;

  try {
    const allDisks = await getVmDisks(vmUuid);
    const copyable = allDisks.filter((d) => d.type === 'disk' && d.source);
    if (copyable.length === 0) throw new Error('VM has no disks to back up');

    // Name each backup image after the VM's *own* disk rather than whatever the
    // domain happens to be pointing at right now. With an external snapshot
    // active the live source is an overlay, and recording that name meant a
    // later restore wrote a file called `<vm>-vda-snap1.qcow2` next to the real
    // disk — the VM carried on booting the untouched original and the restore
    // silently achieved nothing.
    const canonicalNames = await Promise.all(copyable.map((d) => canonicalDiskFilename(vmUuid, d.source)));

    // Backup images are keyed by filename, so two disks sharing one would
    // silently overwrite each other in the backup directory.
    const duplicate = canonicalNames.find((n, i) => canonicalNames.indexOf(n) !== i);
    if (duplicate) {
      throw new Error(`Two of this VM's disks are both named "${duplicate}" — cannot back up until one is renamed`);
    }

    // ── Decide full vs incremental ──────────────────────────────────────────
    const requested: BackupKindRequest = opts.kind ?? 'full';
    const fullEvery = clampFullEvery(opts.fullEvery);
    let kind: BackupKind = 'full';
    let parentBackupId: string | undefined;
    let incrementalFrom: string | undefined;

    // Set when this run degraded to a full, so the note can be finalised after
    // the copy — only then is it known whether a checkpoint was actually laid
    // down, which is the difference between "this is the expected first run"
    // and "incrementals are silently not working".
    let degradedReason: string | undefined;

    if (requested !== 'full') {
      const readiness = await assessIncrementalReadiness(vmUuid, running);
      if (!readiness.ready) {
        // A schedule's very first run has nothing to chain onto and never did;
        // saying so would be noise. Every other cause is worth recording.
        if (requested === 'incremental' || !readiness.firstBackup) {
          degradedReason = readiness.reason;
        }
      } else if (readiness.chainLength >= fullEvery) {
        notes.push(`Chain reached ${readiness.chainLength} incrementals (limit ${fullEvery}) — took a fresh full backup.`);
      } else {
        kind = 'incremental';
        parentBackupId = readiness.parent!.id;
        incrementalFrom = readiness.parentCheckpoint!;
      }
    }

    // ── Copy ────────────────────────────────────────────────────────────────
    // Only leave a checkpoint behind when incrementals are actually being used.
    //
    // A checkpoint pins a persistent dirty bitmap inside the qcow2, and libvirt
    // refuses *every* block operation on a disk that has one — so creating them
    // unconditionally meant a single backup permanently disabled snapshots,
    // snapshot deletion and reverts for that VM. Somebody who never touches
    // incremental backups should never pay that price.
    //
    // Asking for `incremental` (or a schedule running in incremental mode, which
    // sends `auto`) is the opt-in. The first such run finds no parent, takes a
    // full backup and lays down the checkpoint; the run after it can be a true
    // incremental.
    const wantsChain = requested !== 'full';
    const checkpointName = wantsChain && running && (await libvirtBackup.isBackupSupported())
      ? libvirtBackup.checkpointNameFor(id)
      : undefined;

    // Resolve the parent image each incremental will be layered on *before* the
    // copy: the target is created with its backing pointer already in place, so
    // there is never a window in which the delta exists as an unreadable
    // orphan. Relative paths keep the whole backup tree relocatable.
    const parentManifest = parentBackupId ? await getBackupManifest(vmUuid, parentBackupId) : null;
    const copySpecs = copyable.map((d, i) => {
      const spec: DiskCopySpec = {
        target: d.target,
        sourcePath: d.source,
        destPath: path.join(bdir, canonicalNames[i]),
      };
      if (kind === 'incremental' && parentBackupId) {
        const parentDisk = parentManifest?.disks.find((pd) => pd.target === d.target);
        if (!parentDisk) {
          throw new Error(`Parent backup ${parentBackupId} has no image for ${d.target} — cannot chain this incremental`);
        }
        const filename = assertSafeBackupDiskFilename(parentDisk.filename);
        spec.backing = {
          absolutePath: path.join(backupDir(vmUuid, parentBackupId), filename),
          relativePath: `../${parentBackupId}/${filename}`,
        };
      }
      return spec;
    });
    const excludeTargets = allDisks.filter((d) => !copyable.includes(d)).map((d) => d.target);

    const copy = await copyDisksWithFullFallback({
      vmUuid,
      vmName,
      running,
      disks: copySpecs,
      excludeTargets,
      compress,
      createCheckpoint: checkpointName,
      incrementalFrom,
      snapshotLabel: libvirtBackup.checkpointNameFor(id),
      notes,
    });
    if (copy.degradedToFull) {
      kind = 'full';
      parentBackupId = undefined;
      incrementalFrom = undefined;
    }
    notes.push(...copy.result.notes);

    // Now that the copy has run, say what actually happened. The old wording
    // ("the previous backup did not record a checkpoint") named a symptom of
    // yesterday's run and stopped there — it read as a fault in a backup that
    // was perfectly good, and never mentioned that this run had already fixed
    // it. Which of the two sentences applies is only knowable here.
    if (degradedReason) {
      let outcome: string;
      if (copy.result.checkpointCreated) {
        outcome = 'This run has recorded a checkpoint, so the next one can be a true incremental.';
      } else if (!checkpointName) {
        // No checkpoint was ever asked for, because the conditions for one were
        // not met — the VM was off, or the host cannot do push-mode backups.
        // Blaming the copy method here would be wrong: it was never involved.
        outcome = 'No checkpoint was recorded, so the next run will be a full backup as well.';
      } else {
        // One was requested and the run still came back without it, which only
        // happens when the copy dropped off the libvirt tier.
        outcome = 'No checkpoint could be recorded, because the copy fell back to '
          + `${copy.result.method} — so the next run will be a full backup as well.`;
      }
      notes.push(`Took a full backup — ${degradedReason}. ${outcome}`);
    }

    const diskEntries: BackupDiskEntry[] = [];
    for (const spec of copySpecs) {
      const stat = await fs.stat(spec.destPath);
      diskEntries.push({
        target: spec.target,
        filename: path.basename(spec.destPath),
        format: 'qcow2',
        sizeBytes: stat.size,
        originalPath: spec.sourcePath,
        // Only meaningful if the copy actually stayed incremental — a fallback
        // to a full backup produces a standalone image with no parent.
        ...(kind === 'incremental' && spec.backing ? { backingFilename: spec.backing.relativePath } : {}),
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
      kind,
      ...(parentBackupId ? { parentBackupId } : {}),
      ...(copy.result.checkpointCreated && checkpointName ? { checkpointName } : {}),
      ...(wantsChain ? { chainRequested: true } : {}),
      method: copy.result.method,
      compressed: copy.result.compressed,
      ...(notes.length ? { notes } : {}),
      consistent: copy.result.consistent,
      vmStateAtBackup,
      hostname: os.hostname(),
      vmConfig: {
        cpus: vmInfo.cpus,
        memoryMb: vmInfo.memoryMb,
      },
      disks: diskEntries,
      nics: nics.map((n) => ({ model: n.model, mac: n.mac, source: n.source })),
      vmMeta: encodeMetaForManifest(vmMeta),
      libvirtXml: xml,
      retentionDays,
    };

    await fs.writeFile(path.join(bdir, 'manifest.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.writeFile(path.join(bdir, '.complete'), '', 'utf8');

    // Past this line the backup is real and restorable, so nothing below may
    // be allowed to reach the catch — its first act is to rm -rf this
    // directory. A retention pass that threw on an unreadable settings file
    // used to destroy a backup that had already fully succeeded, then sweep its
    // checkpoint, so the *next* run degraded to a full as well.
    succeeded = true;

    await appendLog({
      type: 'backup.create',
      subject: vmName,
      subjectUuid: vmUuid,
      status: 'success',
      output: [
        `Backup ${id} created (${kind}, ${diskEntries.length} disk(s), method=${copy.result.method}, consistent=${copy.result.consistent})`,
        ...notes,
      ].join('\n'),
    });

    // Housekeeping, not part of the backup: a failure here must be reported,
    // never allowed to invalidate the backup that just succeeded.
    await applyRetention(vmUuid).catch((err: unknown) => {
      console.warn(`[backup] Retention pass failed after ${id}: ${String(err)}`);
    });
    // Only after the manifest is on disk, so the checkpoint we just created is
    // recognised as belonging to a real backup.
    await reconcileCheckpoints(vmUuid).catch(() => { /* best-effort tidy-up */ });

    const sizeBytes = await dirSizeBytes(bdir);
    return {
      id,
      vmUuid,
      vmName,
      createdAt: manifest.createdAt,
      sizeBytes,
      consistency: deriveConsistency(vmStateAtBackup, copy.result.consistent),
      triggerType: opts.triggerType,
      scheduleFrequency: opts.scheduleFrequency,
      vmStateAtBackup,
      retentionDays,
      disks: diskEntries,
      kind,
      parentBackupId,
      method: copy.result.method,
      compressed: copy.result.compressed,
      notes: notes.length ? notes : undefined,
      hasCheckpoint: !!manifest.checkpointName,
      chainRequested: !!manifest.chainRequested,
      chainBroken: false,
      hasDependents: false,
      chainSizeBytes: sizeBytes,
    };
  } catch (err) {
    if (succeeded) {
      // The backup itself is fine — only the bookkeeping after it failed.
      // Deleting it here would turn a good backup into a lost one.
      console.error(`[backup] ${id} completed but post-backup bookkeeping failed: ${String(err)}`);
      await appendLog({
        type: 'backup.create',
        subject: vmName,
        subjectUuid: vmUuid,
        status: 'error',
        output: `Backup ${id} was written successfully, but the bookkeeping afterwards failed: ${String(err)}`,
      });
      throw err;
    }
    await fs.rm(bdir, { recursive: true, force: true }).catch(() => {});
    // A checkpoint may have been created before the failure; without a manifest
    // referencing it, it would linger as a bitmap on the disk forever.
    await reconcileCheckpoints(vmUuid).catch(() => {});
    await appendLog({ type: 'backup.create', subject: vmName, subjectUuid: vmUuid, status: 'error', output: String(err) });
    throw err;
  }
}

function clampFullEvery(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_FULL_EVERY;
  return Math.max(1, Math.min(MAX_FULL_EVERY, Math.trunc(value)));
}

// An incremental has exactly one mechanism, so it cannot degrade to a lesser
// tier the way a full backup can. When it fails, retry the whole thing as a
// full backup rather than leaving the operator with no backup at all.
async function copyDisksWithFullFallback(args: {
  vmUuid: string;
  vmName: string;
  running: boolean;
  disks: DiskCopySpec[];
  excludeTargets: string[];
  compress: boolean;
  createCheckpoint?: string;
  incrementalFrom?: string;
  snapshotLabel: string;
  notes: string[];
}): Promise<{ result: Awaited<ReturnType<typeof copyVmDisks>>; degradedToFull: boolean }> {
  const base = {
    vmUuid: args.vmUuid,
    vmName: args.vmName,
    running: args.running,
    // A full backup must be a standalone image, so the parent pointer that
    // makes sense for an incremental is stripped from the fallback.
    disks: args.disks.map(({ backing: _backing, ...rest }) => rest),
    excludeTargets: args.excludeTargets,
    compress: args.compress,
    createCheckpoint: args.createCheckpoint,
    snapshotLabel: args.snapshotLabel,
  };

  if (!args.incrementalFrom) {
    return { result: await copyVmDisks(base), degradedToFull: false };
  }

  try {
    return { result: await copyVmDisks({ ...base, disks: args.disks, incrementalFrom: args.incrementalFrom }), degradedToFull: false };
  } catch (err) {
    args.notes.push(`Incremental backup failed (${String(err)}); retried as a full backup.`);
    for (const d of args.disks) await fs.unlink(d.destPath).catch(() => {});
    // libvirt creates the checkpoint when the job *starts*, so a job that
    // failed afterwards leaves it behind — and the retry would then collide
    // with its own checkpoint name.
    if (args.createCheckpoint) {
      try {
        if (await libvirtBackup.checkpointExists(args.vmUuid, args.createCheckpoint)) {
          await libvirtBackup.deleteCheckpoint(args.vmUuid, args.createCheckpoint);
        }
      } catch { /* reconcileCheckpoints sweeps it later */ }
    }
    return { result: await copyVmDisks(base), degradedToFull: true };
  }
}

// ─── Checkpoint housekeeping ─────────────────────────────────────────────────

/**
 * Drops libvirt checkpoints that no longer correspond to a complete backup.
 *
 * Each checkpoint holds a persistent dirty bitmap inside the qcow2, so an
 * abandoned one costs space and slows the guest's writes forever. Only
 * VirtPilot's own `vpbk-` checkpoints are touched.
 */
export async function reconcileCheckpoints(vmUuid: string): Promise<void> {
  const names = await libvirtBackup.listCheckpointNames(vmUuid);
  const ours = names.filter(libvirtBackup.isVirtpilotCheckpoint);
  if (ours.length === 0) return;

  const { manifests, unusable } = await scanManifests(vmUuid);
  // A manifest that could not be read is not evidence that its checkpoint is
  // stale — dropping it on that basis costs the next incremental for no reason.
  // Leaving a genuinely orphaned checkpoint until the next pass is the cheaper
  // mistake of the two.
  const unreadable = unusable.filter((u) => u.why === 'unreadable');
  if (unreadable.length > 0) {
    console.warn(
      `[backup] Skipping checkpoint reconciliation for ${vmUuid}: `
      + `${unreadable.length} manifest(s) could not be read (${unreadable.map((u) => u.id).join(', ')})`,
    );
    return;
  }

  const live = new Set(manifests.map((m) => m.checkpointName).filter((n): n is string => !!n));

  for (const name of ours) {
    if (live.has(name)) continue;
    try {
      await libvirtBackup.deleteCheckpoint(vmUuid, name);
    } catch (err) {
      console.warn(`[backup] Could not delete stale checkpoint ${name} for ${vmUuid}: ${String(err)}`);
    }
  }
}

// ─── Delete backup ────────────────────────────────────────────────────────────

/**
 * Removes a backup's files and its libvirt checkpoint.
 *
 * Refuses when another backup layers on top of this one — deleting it would
 * silently break every incremental above it. Pass `cascade` to remove the whole
 * subtree instead.
 */
export async function deleteBackup(vmUuid: string, id: string, opts: { cascade?: boolean } = {}): Promise<void> {
  const backups = await listBackupsForVm(vmUuid);
  const target = backups.find((b) => b.id === id);

  // An id with no manifest (already half-deleted) still gets its directory
  // cleared, so a corrupt entry can never become undeletable.
  if (!target) {
    await removeBackupFiles(vmUuid, id);
    return;
  }

  const descendants = collectDescendants(backups, id);
  if (descendants.length > 0 && !opts.cascade) {
    const names = descendants
      .map((d) => new Date(d.createdAt).toISOString().replace('T', ' ').slice(0, 16))
      .join(', ');
    throw new Error(
      `${descendants.length} incremental backup(s) depend on this one (${names}). ` +
      'Delete them first, or use the "delete this and everything built on it" option.',
    );
  }

  // Newest first, so the tree is never momentarily missing a middle link.
  for (const d of [...descendants].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    await removeBackupFiles(vmUuid, d.id);
    await dropCheckpointFor(vmUuid, d.id);
  }
  await removeBackupFiles(vmUuid, id);
  await dropCheckpointFor(vmUuid, id);
}

function collectDescendants(backups: BackupEntry[], rootId: string): BackupEntry[] {
  const childrenOf = new Map<string, BackupEntry[]>();
  for (const b of backups) {
    if (!b.parentBackupId) continue;
    const list = childrenOf.get(b.parentBackupId) ?? [];
    list.push(b);
    childrenOf.set(b.parentBackupId, list);
  }
  const out: BackupEntry[] = [];
  const stack = [rootId];
  const seen = new Set<string>([rootId]);
  while (stack.length) {
    for (const child of childrenOf.get(stack.pop()!) ?? []) {
      if (seen.has(child.id)) continue; // defensive: corrupt metadata could cycle
      seen.add(child.id);
      out.push(child);
      stack.push(child.id);
    }
  }
  return out;
}

async function removeBackupFiles(vmUuid: string, id: string): Promise<void> {
  await fs.rm(backupDir(vmUuid, id), { recursive: true, force: true });
}

async function dropCheckpointFor(vmUuid: string, id: string): Promise<void> {
  const name = libvirtBackup.checkpointNameFor(id);
  try {
    if (await libvirtBackup.checkpointExists(vmUuid, name)) {
      await libvirtBackup.deleteCheckpoint(vmUuid, name);
    }
  } catch (err) {
    // Losing a checkpoint costs the next incremental, not the backup itself.
    console.warn(`[backup] Could not delete checkpoint ${name} for ${vmUuid}: ${String(err)}`);
  }
}

// ─── Restore backup ───────────────────────────────────────────────────────────

/**
 * Restores a backup's disk images over an existing VM's disks.
 *
 * Incrementals are flattened on the way out: `qemu-img convert` follows the
 * backing chain, so the VM receives one standalone image regardless of how many
 * links the backup is made of.
 */
export async function restoreBackup(sourceVmUuid: string, id: string, targetVmUuidArg?: string): Promise<void> {
  const { manifest, bdir } = await openBackupForRestore(sourceVmUuid, id);

  // The restore target's UUID must be a valid UUID — never a free-form name.
  const targetVmUuid = validateVmUuid(targetVmUuidArg ?? sourceVmUuid);

  const vmInfo = await getVmInfo(targetVmUuid).catch(() => null);
  if (vmInfo?.status === 'running') {
    throw new Error(`VM "${targetVmUuid}" must be stopped before restoring`);
  }

  // Restore replaces files by name; it does not rewrite the domain definition.
  // If the VM is currently booting off an external snapshot overlay, writing
  // the backup back over the base disk would leave the guest running the
  // untouched overlay — a restore that reports success and changes nothing.
  if (vmInfo) {
    const liveNames = new Set(
      vmInfo.disks.filter((d) => d.type === 'disk' && d.source).map((d) => path.basename(d.source)),
    );
    const unmatched = manifest.disks
      .map((d) => path.basename(d.filename))
      .filter((name) => !liveNames.has(name));
    if (liveNames.size > 0 && unmatched.length === manifest.disks.length) {
      throw new Error(
        `This VM is not currently booting from ${unmatched.join(', ')} — it has a snapshot overlay active. ` +
        'Delete the VM\'s snapshots first, then restore.',
      );
    }
  }

  // Resolve the target storage dir per disk. v2.2 introduced multiple storage
  // dirs — restoring blindly into config.vmsDir would orphan the file from
  // both vm_disk_locations and the libvirt domain XML for any VM whose disks
  // live elsewhere. Look each disk up in vm_disk_locations; fall back to the
  // default vmDisks dir for a brand-new restore where no rows exist yet.
  // Replacing the images invalidates every dirty bitmap they carry. Drop the
  // checkpoints *first*, while the old images are still intact and libvirt can
  // remove them cleanly — otherwise the VM is left with checkpoints pointing at
  // bitmaps that no longer exist, which cannot be deleted and stop qemu opening
  // the disk at all.
  const clearedCheckpoints = await libvirtBackup.clearVirtpilotCheckpoints(targetVmUuid);

  const existingLocs = await storageDirService.listDiskLocationsForVm(targetVmUuid);
  const locByFilename = new Map(existingLocs.map((l) => [l.diskFilename, l.storageDirId]));
  const fallbackDir = await storageDirService.getDefaultDirFor('vmDisks');

  for (const disk of manifest.disks) {
    const safeFilename = assertSafeBackupDiskFilename(disk.filename);

    const targetDirId = locByFilename.get(safeFilename);
    let targetDir = targetDirId ? await storageDirService.getDir(targetDirId) : null;
    if (!targetDir) targetDir = fallbackDir;
    if (!targetDir) {
      throw new Error('No vmDisks storage directory available — register one before restoring backups');
    }

    const targetVmDir = path.join(storageDirService.getVmDisksSubdir(targetDir), targetVmUuid);
    await fs.mkdir(targetVmDir, { recursive: true });
    await fs.chmod(targetVmDir, 0o770).catch(() => {});

    const dest = path.join(targetVmDir, safeFilename);
    await materialiseBackupDisk(path.join(bdir, safeFilename), dest);

    // Make sure vm_disk_locations reflects where the file is now. For an
    // overwriting restore this is a no-op (row already exists); for restore
    // into a brand-new VM uuid the row is freshly inserted.
    await storageDirService.recordDiskLocation(targetVmUuid, safeFilename, targetDir.id);
  }

  // The images just changed underneath libvirt, so whatever backing chain it
  // had cached for them is now fiction. Re-probe before anything tries to boot.
  if (vmInfo) {
    await refreshDomainBackingChain(targetVmUuid).catch((err: unknown) => {
      console.warn(`[backup] Could not refresh the backing chain for ${targetVmUuid}: ${String(err)}`);
    });
  }

  await appendLog({
    type: 'backup.restore',
    subject: vmInfo?.name ?? targetVmUuid,
    subjectUuid: targetVmUuid,
    status: 'success',
    output: [
      `Restored from backup ${id} (${manifest.kind ?? 'full'}, source VM: ${manifest.vmName})`,
      clearedCheckpoints.length
        ? `Cleared ${clearedCheckpoints.length} backup checkpoint(s) — the next backup of this VM will be a full one.`
        : '',
    ].filter(Boolean).join('\n'),
  });
}

/**
 * Validates a backup is complete and readable and hands back its manifest.
 * Shared by the overwrite restore and the restore-into-a-new-VM flow.
 */
export async function openBackupForRestore(
  vmUuid: string,
  id: string,
): Promise<{ manifest: BackupManifest; bdir: string }> {
  const bdir = backupDir(vmUuid, id);
  try {
    await fs.access(path.join(bdir, '.complete'));
  } catch {
    throw new Error('Backup is incomplete or corrupt');
  }

  const manifest = await getBackupManifest(vmUuid, id);
  if (!manifest) throw new Error('Backup manifest not found');

  // An incremental whose ancestors have gone missing reads as a sparse image
  // full of holes — restoring it would hand back a silently corrupt disk.
  const entries = await listBackupsForVm(vmUuid);
  const entry = entries.find((b) => b.id === id);
  if (entry?.chainBroken) {
    throw new Error(
      'This incremental backup cannot be restored — one of the backups it builds on is missing. ' +
      'Restore an earlier full backup instead.',
    );
  }

  return { manifest, bdir };
}

// Disk filenames (disk.qcow2, extra-disk-N.qcow2) are not VM-name-prefixed.
// Defend against a manifest crafted with `disk.filename = "../../etc/cron.d/x"`:
// strip directory components and validate the leaf name before joining.
export function assertSafeBackupDiskFilename(filename: string): string {
  const safe = path.basename(filename);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.qcow2$/i.test(safe)) {
    throw new Error(`Refusing to restore: invalid disk filename in manifest (${filename})`);
  }
  return safe;
}

/**
 * Writes one standalone qcow2 at `dest` from a backup image that may sit on top
 * of a backing chain. Goes via a temporary name so a failure part-way cannot
 * leave a half-written image where a working disk used to be.
 */
export async function materialiseBackupDisk(src: string, dest: string): Promise<void> {
  const tmp = `${dest}.restoring`;
  // Clear any leftover from an interrupted restore — qemu-img refuses to write
  // over an existing file.
  await fs.unlink(tmp).catch(() => {});
  try {
    // convert flattens the backing chain, so incrementals come out whole.
    await qemuImg(['convert', '-f', 'qcow2', '-O', 'qcow2', src, tmp], { timeout: 6 * 60 * 60_000 });
    await fs.rename(tmp, dest);
    await fs.chmod(dest, 0o660).catch(() => { /* owned by libvirt-qemu — it can already write it */ });
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

// ─── Verification ─────────────────────────────────────────────────────────────

const verifyPath = (vmUuid: string, id: string) => path.join(backupDir(vmUuid, id), '.verify.json');

export async function readVerifyRecord(vmUuid: string, id: string): Promise<BackupVerifyRecord | null> {
  try {
    return JSON.parse(await fs.readFile(verifyPath(vmUuid, id), 'utf8')) as BackupVerifyRecord;
  } catch {
    return null;
  }
}

/**
 * Runs `qemu-img check` on one image and classifies the result.
 *
 * qemu-img exits 3 for leaked clusters, which is untidy but not data loss, so
 * that is reported as healthy with a note rather than failing the backup.
 */
async function checkImage(imagePath: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const out = await qemuImg(['check', '-U', '--output=json', imagePath], { timeout: 60 * 60_000 });
    const info = JSON.parse(out) as { corruptions?: number; leaks?: number };
    if (info.corruptions && info.corruptions > 0) {
      return { ok: false, detail: `${info.corruptions} corrupt cluster(s)` };
    }
    if (info.leaks && info.leaks > 0) return { ok: true, detail: `${info.leaks} leaked cluster(s)` };
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Exit 3 is leaked-clusters-only; qemu-img still printed its JSON.
    const leaksOnly = /"corruptions":\s*0/.test(message) && /"leaks":\s*[1-9]/.test(message);
    if (leaksOnly) return { ok: true, detail: 'leaked clusters' };
    return { ok: false, detail: message.split('\n').slice(-2).join(' ').trim().slice(0, 200) };
  }
}

/**
 * Proves a backup is actually restorable, rather than merely present.
 *
 * An incremental is only as good as every backup beneath it, and nothing else
 * in the product reads those images between the day they are written and the
 * day someone needs them. This walks the whole chain, confirms each link is on
 * disk, and asks qemu-img to check each image.
 */
export async function verifyBackup(vmUuid: string, id: string): Promise<BackupVerifyResult> {
  const entries = await listBackupsForVm(vmUuid);
  const byId = new Map(entries.map((b) => [b.id, b]));
  const target = byId.get(id);
  if (!target) throw new Error('Backup not found');

  // Collect the chain root-first so the report reads bottom-up.
  const chain: BackupEntry[] = [];
  const seen = new Set<string>();
  let cur: BackupEntry | undefined = target;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentBackupId ? byId.get(cur.parentBackupId) : undefined;
  }

  const links: BackupVerifyLink[] = [];
  // A chain whose root is an incremental is missing its ancestors entirely.
  const rootMissing = chain[0]?.kind === 'incremental';

  for (const b of chain) {
    const manifest = await getBackupManifest(vmUuid, b.id);
    for (const disk of manifest?.disks ?? []) {
      const filename = path.basename(disk.filename);
      const abs = path.join(backupDir(vmUuid, b.id), filename);
      let present = true;
      try {
        await fs.access(abs);
      } catch {
        present = false;
      }
      if (!present) {
        links.push({ backupId: b.id, kind: b.kind, target: disk.target, filename, present: false, ok: false, detail: 'image missing' });
        continue;
      }
      const res = await checkImage(abs);
      links.push({ backupId: b.id, kind: b.kind, target: disk.target, filename, present: true, ...res });
    }
  }

  const bad = links.filter((l) => !l.ok);
  const ok = bad.length === 0 && !rootMissing;
  const summary = rootMissing
    ? `Chain is incomplete — the full backup underneath ${chain[0]?.id} is missing`
    : ok
      ? `Verified ${links.length} image(s) across ${chain.length} backup(s) in the chain`
      : `${bad.length} of ${links.length} image(s) failed: ${bad.map((b) => `${b.backupId}/${b.filename} (${b.detail})`).join('; ')}`;

  const result: BackupVerifyResult = { backupId: id, ok, checkedAt: new Date().toISOString(), links, summary };

  await fs.writeFile(
    verifyPath(vmUuid, id),
    JSON.stringify({ checkedAt: result.checkedAt, ok, summary } satisfies BackupVerifyRecord, null, 2),
    'utf8',
  ).catch(() => { /* the record is a convenience, not the result */ });

  await appendLog({
    type: 'backup.verify',
    subject: target.vmName,
    subjectUuid: vmUuid,
    status: ok ? 'success' : 'error',
    output: summary,
  });

  return result;
}

// ─── Alerting ─────────────────────────────────────────────────────────────────

export interface BackupAlert {
  vmUuid: string;
  vmName: string;
  severity: 'error' | 'warning';
  kind: 'schedule-failed' | 'chain-broken' | 'schedule-overdue' | 'verify-failed' | 'incremental-degraded' | 'orphaned-data';
  message: string;
}

// One degraded run is the expected bootstrap after switching a schedule to
// incremental, so it is not worth an alert. Two in a row means the libvirt
// push-mode tier is failing every time and the schedule is quietly writing a
// full backup every night while still reporting success.
const DEGRADED_RUN_ALERT_THRESHOLD = 2;

/**
 * How many of the most recent backups *tried* to extend an incremental chain
 * and came back without a checkpoint.
 *
 * Counted newest-first and stopped at the first backup that recorded one,
 * because that backup is a working chain root — everything older is history.
 *
 * `chainRequested` is what keeps this honest. Counting every checkpoint-less
 * backup instead would mean that switching a long-standing full-mode schedule
 * to incremental raised the alert immediately, off the back of history that
 * predates the setting and was never meant to chain. Backups written before
 * 2.9 carry no flag and so are never counted, which stops the count at the
 * upgrade boundary rather than misreading it.
 */
export function countConsecutiveNonChainingFulls(
  backups: Pick<BackupEntry, 'hasCheckpoint' | 'chainRequested'>[],
): number {
  let n = 0;
  for (const b of backups) {
    if (b.hasCheckpoint) break;
    if (!b.chainRequested) break;
    n++;
  }
  return n;
}

// A schedule that should have fired this long ago is not merely late — either
// the service was down or the run is wedged.
const OVERDUE_GRACE_MS = 2 * 60 * 60_000;

/**
 * Everything about backups the operator would want to be told without going
 * looking. Backups that quietly stop working are the classic disaster, and
 * before this the only signal a scheduled run had failed was a line in
 * journalctl.
 */
export async function getBackupAlerts(): Promise<BackupAlert[]> {
  const alerts: BackupAlert[] = [];
  const summaries = await listAllVmBackupSummaries();

  for (const s of summaries) {
    const schedule = s.schedule;
    if (schedule?.lastRunStatus === 'error') {
      alerts.push({
        vmUuid: s.vmUuid,
        vmName: s.vmName,
        severity: 'error',
        kind: 'schedule-failed',
        message: `The last scheduled backup failed: ${schedule.lastError ?? 'no detail recorded'}`,
      });
    }
    if (schedule?.enabled && schedule.nextRunAt) {
      const due = new Date(schedule.nextRunAt).getTime();
      if (Number.isFinite(due) && Date.now() - due > OVERDUE_GRACE_MS) {
        alerts.push({
          vmUuid: s.vmUuid,
          vmName: s.vmName,
          severity: 'warning',
          kind: 'schedule-overdue',
          message: `A scheduled backup was due ${new Date(due).toISOString()} and has not run`,
        });
      }
    }

    const backups = await listBackupsForVm(s.vmUuid);

    // A schedule set to incremental that keeps producing checkpoint-less fulls
    // is the failure this product used to hide completely: every run still
    // succeeds, so lastRunStatus stays 'success', the banner still says
    // "Incremental", and the only trace is a note buried in one backup's row.
    if (schedule?.mode === 'incremental') {
      const degraded = countConsecutiveNonChainingFulls(backups);
      if (degraded >= DEGRADED_RUN_ALERT_THRESHOLD) {
        // Specifically the degradation note, not simply the last one — the copy
        // tiers push their own notes afterwards, so quoting the tail could
        // attach an unrelated consistency warning to this sentence.
        const why = backups[0]?.notes?.find((n) => n.startsWith('Took a full backup —'));
        alerts.push({
          vmUuid: s.vmUuid,
          vmName: s.vmName,
          severity: 'warning',
          kind: 'incremental-degraded',
          message:
            `This VM is scheduled for incremental backups, but the last ${degraded} runs each took a full backup `
            + 'and recorded no checkpoint, so the next one cannot be incremental either'
            + (why ? `: ${why}` : '.'),
        });
      }
    }

    if (s.unusableCount > 0) {
      // Retention refuses to prune anything at all while a manifest is
      // unreadable, so if that is what we are looking at, this alert is the
      // only place the operator will ever learn that expiry has stopped — and
      // which directory to look at to unblock it.
      const unreadable = (await listUnusableBackupDirs(s.vmUuid)).filter((u) => u.why === 'unreadable');
      alerts.push({
        vmUuid: s.vmUuid,
        vmName: s.vmName,
        severity: 'warning',
        kind: 'orphaned-data',
        message: unreadable.length > 0
          ? `${plural(unreadable.length, 'backup manifest')} cannot be read `
            + `(${unreadable.map((u) => u.id).join(', ')}), so retention has stopped removing expired backups for `
            + `this VM until ${unreadable.length === 1 ? 'that directory is' : 'those directories are'} repaired or deleted`
          : `${plural(s.unusableCount, 'backup directory', 'backup directories')} `
            + `${s.unusableCount === 1 ? 'holds' : 'hold'} ${formatBytes(s.unusableSizeBytes)} that no backup can use, `
            + `left behind by ${s.unusableCount === 1 ? 'an interrupted run' : 'interrupted runs'}`,
      });
    }

    const broken = backups.filter((b) => b.chainBroken);
    if (broken.length > 0) {
      alerts.push({
        vmUuid: s.vmUuid,
        vmName: s.vmName,
        severity: 'error',
        kind: 'chain-broken',
        message: `${broken.length} backup(s) cannot be restored — a backup they build on is missing`,
      });
    }
    for (const b of backups) {
      const rec = await readVerifyRecord(s.vmUuid, b.id);
      if (rec && !rec.ok) {
        alerts.push({
          vmUuid: s.vmUuid,
          vmName: s.vmName,
          severity: 'error',
          kind: 'verify-failed',
          message: `Verification failed for the backup of ${new Date(b.createdAt).toISOString()}: ${rec.summary}`,
        });
      }
    }
  }
  return alerts;
}

// ─── Retention ────────────────────────────────────────────────────────────────

// Each backup's stored retentionDays governs its own expiry. Falls back to
// the current global setting only when the backup was created with the
// "keep forever" policy (retentionDays=0).
//
// Chain-aware: a backup is only ever removed once nothing depends on it, so an
// expired full backup that still has a live incremental on top of it survives
// until that incremental expires too. Deleting it on age alone would destroy
// every incremental in the chain.
export async function applyRetention(vmUuid: string): Promise<void> {
  // An unreadable manifest is indistinguishable from a backup that does not
  // exist, and the peel loop below reads absence as "nothing depends on this".
  // One transient EIO on an incremental's manifest would make its parent look
  // like a childless leaf, delete it, and cascade down the chain — leaving
  // every backup above permanently unrestorable. Refuse to prune at all until
  // the whole picture is readable.
  // One scan, reused below — the pass used to walk the whole backup tree twice.
  const scan = await scanManifests(vmUuid);
  const unreadable = scan.unusable.filter((u) => u.why === 'unreadable');
  if (unreadable.length > 0) {
    // Surfaced to the operator by the 'orphaned-data' alert, which names the
    // same directories and says retention has stopped — this is not the only
    // trace.
    throw new Error(
      `Refusing to apply retention to ${vmUuid}: ${unreadable.length} backup manifest(s) could not be read `
      + `(${unreadable.map((u) => `${u.id}: ${u.detail ?? 'no detail'}`).join('; ')})`,
    );
  }

  // Deliberately strict: a corrupt schedule store must abort the pass rather
  // than silently fall back to the global retention and delete backups the
  // operator had asked to keep for longer.
  const settings = await getUserSettings();
  const schedules = await readSchedules();
  const schedule = schedules[vmUuid];
  const globalRetention = schedule?.retentionDays != null
    ? schedule.retentionDays
    : settings.backup.retentionDays;

  const backups = await listBackupsFromScan(vmUuid, scan);
  const childCount = new Map<string, number>();
  for (const b of backups) {
    if (b.parentBackupId) childCount.set(b.parentBackupId, (childCount.get(b.parentBackupId) ?? 0) + 1);
  }

  const isExpired = (b: BackupEntry): boolean => {
    const days = b.retentionDays > 0 ? b.retentionDays : globalRetention;
    if (days === 0) return false;
    return new Date(b.createdAt).getTime() < Date.now() - days * 24 * 60 * 60 * 1000;
  };

  // Peel expired leaves off repeatedly: removing one can make its parent a leaf.
  const removed = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const b of backups) {
      if (removed.has(b.id)) continue;
      if ((childCount.get(b.id) ?? 0) > 0) continue;
      if (!isExpired(b)) continue;
      await removeBackupFiles(vmUuid, b.id);
      await dropCheckpointFor(vmUuid, b.id);
      removed.add(b.id);
      if (b.parentBackupId) {
        childCount.set(b.parentBackupId, (childCount.get(b.parentBackupId) ?? 1) - 1);
      }
      progress = true;
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
    await applyRetention(vmUuid).catch((err: unknown) => {
      console.warn(`[backup] Retention pass failed for ${vmUuid}: ${String(err)}`);
    });
    await sweepAbandonedBackupDirs(vmUuid).catch((err: unknown) => {
      console.warn(`[backup] Abandoned-directory sweep failed for ${vmUuid}: ${String(err)}`);
    });
  }
}

// A backup run that the backend dies in the middle of — a restart, a
// self-upgrade, an OOM kill — never reaches its own cleanup, so the directory
// and its part-written multi-GB image stay on disk forever. Nothing listed
// them, so their bytes were missing from every total the product showed while
// still filling the volume.
//
// Generous, because deleting a *live* backup's directory would be far worse
// than leaving a stale one: the longest copy the engine will wait for is 6
// hours, so 24 hours is well past anything that could still be running, and a
// VM with a backup in flight is skipped outright.
const ABANDONED_BACKUP_AGE_MS = 24 * 60 * 60_000;

export async function sweepAbandonedBackupDirs(vmUuid: string): Promise<string[]> {
  if (backupsInProgress.has(vmUuid)) return [];

  const cutoff = Date.now() - ABANDONED_BACKUP_AGE_MS;
  const swept: string[] = [];
  for (const dir of await listUnusableBackupDirs(vmUuid)) {
    // Only ever the never-finished ones. A directory marked `.complete` whose
    // manifest merely failed to read may be a perfectly good backup behind a
    // transient I/O error, and is left for the operator to decide about.
    if (dir.why !== 'incomplete') continue;
    if (dir.mtimeMs === 0 || dir.mtimeMs > cutoff) continue;
    await removeBackupFiles(vmUuid, dir.id);
    swept.push(dir.id);
  }

  if (swept.length > 0) {
    const vmName = await getVmInfo(vmUuid).then((i) => i.name).catch(() => vmUuid);
    await appendLog({
      type: 'backup.sweep',
      subject: vmName,
      subjectUuid: vmUuid,
      status: 'success',
      output: `Removed ${plural(swept.length, 'abandoned backup directory', 'abandoned backup directories')} `
        + `left by an interrupted run: ${swept.join(', ')}`,
    });
  }
  return swept;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Byte count for alert copy. Binary maths with decimal labels, deliberately —
 * it matches the frontend's own formatBytes exactly, and an alert reading
 * "37.4 GiB" beside a tile reading "37.4 GB" for the same directory invites the
 * operator to think they are two different things.
 */
function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** "1 backup directory" / "3 backup directories" — no "(ies)" in operator copy. */
function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/**
 * The most recent mtime of a directory or anything directly inside it.
 *
 * `stat(dir).mtimeMs` alone is not a liveness signal: it only moves when an
 * entry is created, renamed or removed. A push-mode backup creates every target
 * image up front and then has qemu write into those existing files for as long
 * as the copy takes, so the directory looks frozen at job start throughout.
 * Returns 0 when nothing can be stat'd, which every caller treats as "unknown,
 * do not act".
 */
async function newestMtimeMs(dir: string): Promise<number> {
  let newest = 0;
  try {
    newest = (await fs.stat(dir)).mtimeMs;
  } catch {
    return 0;
  }
  try {
    for (const entry of await fs.readdir(dir)) {
      const stat = await fs.stat(path.join(dir, entry)).catch(() => null);
      if (stat && stat.mtimeMs > newest) newest = stat.mtimeMs;
    }
  } catch { /* the directory stat above is enough to go on */ }
  return newest;
}

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
    default:
      // A schedule persisted by an older (or tampered) build could carry a
      // frequency we no longer understand. Falling through would return "now",
      // which the scheduler reads as permanently due and re-fires every tick.
      throw new Error(`Unknown backup frequency: ${String(schedule.frequency)}`);
  }
  return next;
}
