// Thin wrappers over libvirt's push-mode backup API (`virsh backup-begin`) and
// checkpoints (`virsh checkpoint-create`).
//
// Two reasons this exists rather than shelling out to `qemu-img convert`:
//
//  1. qemu takes the point-in-time internally (copy-before-write), so the guest
//     is never stalled for longer than it takes the job to *start*. The old
//     path held the guest's filesystems frozen for the entire copy — minutes to
//     an hour on a large disk.
//  2. A checkpoint records a persistent qcow2 dirty bitmap, which is what makes
//     a later "only the clusters that changed since <checkpoint>" backup — an
//     incremental — possible at all.
//
// Everything here needs `<backup supported='yes'/>` in `virsh domcapabilities`
// (libvirt >= 6.0 with a qemu that has blockdev-backup, i.e. anything on
// Ubuntu 22.04+). Callers must treat that as optional and fall back.

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { virsh } from './safeExec.js';
import { validateVmUuid, validateSnapshotName, validateDiskTarget, escapeXml } from '../lib/validate.js';
import type { TraceEntry } from './traceService.js';

// Checkpoint names are derived from the backup id so the mapping is recoverable
// from `virsh checkpoint-list` alone, without consulting a manifest.
const CHECKPOINT_PREFIX = 'vpbk-';

/** `20260504T131415Z-abc123` -> `vpbk-20260504T131415Z-abc123` (a valid libvirt checkpoint name). */
export function checkpointNameFor(backupId: string): string {
  return validateSnapshotName(`${CHECKPOINT_PREFIX}${backupId}`);
}

export function isVirtpilotCheckpoint(name: string): boolean {
  return name.startsWith(CHECKPOINT_PREFIX);
}

// ─── Capability probe ─────────────────────────────────────────────────────────

// A *positive* answer is cached for the process lifetime — support cannot be
// withdrawn from under a running libvirtd, and every backup asks.
//
// A negative one is only cached briefly. It can genuinely change without
// restarting VirtPilot: `apt upgrade qemu-kvm` followed by a libvirtd restart
// flips it. Caching that forever meant one unlucky probe silently disabled
// incremental backups *and* the fast push-mode copy path until somebody
// happened to restart the service, while the recorded reason kept insisting the
// host could not do it.
let backupSupportedCache: boolean | null = null;
// Timestamp of the last answer that was not a definite yes, whether it came
// back negative or the probe itself failed. Both back off for the same window:
// isBackupSupported is consulted on every backups-page poll as well as on every
// backup, so retrying immediately would fork `virsh` continuously for as long
// as libvirtd stayed unhappy.
let lastNegativeAt = 0;
const NEGATIVE_PROBE_TTL_MS = 5 * 60_000;

export async function isBackupSupported(): Promise<boolean> {
  if (backupSupportedCache === true) return true;
  if (lastNegativeAt !== 0 && Date.now() - lastNegativeAt < NEGATIVE_PROBE_TTL_MS) return false;
  try {
    const caps = await virsh(['domcapabilities'], { timeout: 15_000 });
    backupSupportedCache = /<backup\s+supported=['"]yes['"]\s*\/>/.test(caps);
    if (!backupSupportedCache) lastNegativeAt = Date.now();
  } catch {
    // A probe failure must not be cached as a hard "no" — libvirtd may simply
    // have been restarting. Report unsupported for this call and retry after
    // the backoff, leaving the cached answer itself untouched.
    lastNegativeAt = Date.now();
    return false;
  }
  return backupSupportedCache;
}

/** Test seam — forget the cached capability answer. */
export function resetBackupSupportCache(): void {
  backupSupportedCache = null;
  lastNegativeAt = 0;
}

// ─── Checkpoints ──────────────────────────────────────────────────────────────

export async function listCheckpointNames(vmUuid: string): Promise<string[]> {
  const uuid = validateVmUuid(vmUuid);
  try {
    const out = await virsh(['checkpoint-list', uuid, '--name'], { timeout: 20_000 });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    // No checkpoints, or the domain is gone — both read as "none".
    return [];
  }
}

export async function checkpointExists(vmUuid: string, name: string): Promise<boolean> {
  const names = await listCheckpointNames(vmUuid);
  return names.includes(name);
}

// Deleting a checkpoint merges its bitmap into the parent's, so the remaining
// chain stays valid — dropping a mid-chain checkpoint does not invalidate the
// incrementals either side of it.
export async function deleteCheckpoint(vmUuid: string, name: string, trace?: TraceEntry[]): Promise<void> {
  const uuid = validateVmUuid(vmUuid);
  const chk = validateSnapshotName(name);
  await virsh(['checkpoint-delete', uuid, chk], { timeout: 60_000, trace });
}

/**
 * Removes every checkpoint VirtPilot owns for a VM.
 *
 * Must be called before anything replaces a disk image underneath libvirt.
 * A checkpoint's dirty bitmap lives *inside* the qcow2, so once the image is
 * swapped the bitmap is gone but libvirt still believes in it — after which the
 * checkpoint cannot be deleted and qemu refuses to open the disk at all
 * ("Failed to get write lock"), leaving the VM unbootable.
 *
 * Falls back to dropping just the metadata, which is the only thing that works
 * once the bitmap has already gone missing.
 */
export async function clearVirtpilotCheckpoints(vmUuid: string): Promise<string[]> {
  const cleared: string[] = [];
  for (const name of (await listCheckpointNames(vmUuid)).filter(isVirtpilotCheckpoint)) {
    try {
      await deleteCheckpoint(vmUuid, name);
      cleared.push(name);
    } catch {
      try {
        await deleteCheckpointMetadataOnly(vmUuid, name);
        cleared.push(name);
      } catch (err) {
        console.warn(`[backup] Could not clear checkpoint ${name} for ${vmUuid}: ${String(err)}`);
      }
    }
  }
  return cleared;
}

/** True when any checkpoint exists — libvirt blocks all block operations then. */
export async function hasAnyCheckpoint(vmUuid: string): Promise<boolean> {
  return (await listCheckpointNames(vmUuid)).length > 0;
}

// Drops the checkpoint's libvirt record but leaves the qcow2 bitmap in place.
// The fallback for a domain whose disks libvirt can no longer reach (deleted
// storage), where a full delete would fail and leave the record orphaned.
export async function deleteCheckpointMetadataOnly(vmUuid: string, name: string): Promise<void> {
  const uuid = validateVmUuid(vmUuid);
  const chk = validateSnapshotName(name);
  await virsh(['checkpoint-delete', uuid, chk, '--metadata'], { timeout: 30_000 });
}

// ─── Push-mode backup ─────────────────────────────────────────────────────────

export interface PushBackupDisk {
  /** libvirt disk target, e.g. `vda` */
  target: string;
  /** Absolute path qemu should write the backup image to */
  destPath: string;
}

export interface PushBackupOptions {
  vmUuid: string;
  /** Disks to copy. Every other disk on the domain is explicitly excluded. */
  disks: PushBackupDisk[];
  /** Targets present on the domain but not being backed up (cdroms, etc). */
  excludeTargets: string[];
  /** Parent checkpoint name — set to make this an incremental backup. */
  incrementalFrom?: string;
  /** Checkpoint to create atomically with the backup, for future incrementals. */
  createCheckpoint?: string;
  /**
   * Write into target files the caller has already created, instead of letting
   * libvirt create them.
   *
   * This matters more than it looks. A file libvirt creates itself has no
   * previous owner to remember, so when the job releases it the security
   * manager labels it `root:root 0600` — leaving the finished backup unreadable
   * by both the service account and the `libvirt-qemu` user every later
   * `qemu-img` call runs as. Incrementals and restores then fail with
   * "Permission denied" on a backup that reported success.
   */
  reuseExternal?: boolean;
  timeoutMs?: number;
  trace?: TraceEntry[];
}

function diskBackupXml(disks: PushBackupDisk[], excludeTargets: string[]): string {
  const included = disks.map(
    (d) =>
      `    <disk name='${escapeXml(validateDiskTarget(d.target))}' backup='yes' type='file'>\n` +
      `      <driver type='qcow2'/>\n` +
      `      <target file='${escapeXml(d.destPath)}'/>\n` +
      `    </disk>`,
  );
  // Unlisted disks would default to participating, and a read-only cdrom makes
  // the whole job fail — so every non-backed-up target is named explicitly.
  const excluded = excludeTargets.map(
    (t) => `    <disk name='${escapeXml(validateDiskTarget(t))}' backup='no'/>`,
  );
  return [...included, ...excluded].join('\n');
}

function checkpointXml(name: string, disks: PushBackupDisk[], excludeTargets: string[]): string {
  const included = disks.map(
    (d) => `    <disk name='${escapeXml(validateDiskTarget(d.target))}' checkpoint='bitmap'/>`,
  );
  const excluded = excludeTargets.map(
    (t) => `    <disk name='${escapeXml(validateDiskTarget(t))}' checkpoint='no'/>`,
  );
  return `<domaincheckpoint>
  <name>${escapeXml(validateSnapshotName(name))}</name>
  <disks>
${[...included, ...excluded].join('\n')}
  </disks>
</domaincheckpoint>`;
}

async function writeTempXml(content: string, label: string): Promise<string> {
  const file = path.join(os.tmpdir(), `virtpilot-${label}-${randomUUID()}.xml`);
  // 0600: the XML carries no secrets today, but it does carry absolute storage
  // paths, and /tmp is world-readable.
  await fs.writeFile(file, content, { encoding: 'utf8', mode: 0o600 });
  return file;
}

function parseJobField(out: string, field: string): string {
  const line = out.split('\n').find((l) => l.trim().startsWith(`${field}:`));
  return line?.slice(line.indexOf(':') + 1).trim() ?? '';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts a push-mode backup and returns as soon as the block job is *running* —
 * not when it has finished. That is the whole point: the caller can thaw the
 * guest immediately, so the freeze window is the job's start latency rather
 * than the duration of the copy. Pair every call with `waitForBackupJob`.
 */
export async function beginPushBackup(opts: PushBackupOptions): Promise<void> {
  const uuid = validateVmUuid(opts.vmUuid);
  if (opts.disks.length === 0) throw new Error('beginPushBackup: no disks to back up');

  const incremental = opts.incrementalFrom
    ? `  <incremental>${escapeXml(validateSnapshotName(opts.incrementalFrom))}</incremental>\n`
    : '';
  const backupXml = `<domainbackup mode='push'>
${incremental}  <disks>
${diskBackupXml(opts.disks, opts.excludeTargets)}
  </disks>
</domainbackup>`;

  const backupFile = await writeTempXml(backupXml, 'backup');
  const chkFile = opts.createCheckpoint
    ? await writeTempXml(checkpointXml(opts.createCheckpoint, opts.disks, opts.excludeTargets), 'checkpoint')
    : null;

  try {
    const args = ['backup-begin', uuid, '--backupxml', backupFile];
    if (chkFile) args.push('--checkpointxml', chkFile);
    if (opts.reuseExternal) args.push('--reuse-external');
    await virsh(args, { timeout: 120_000, trace: opts.trace });
  } finally {
    await fs.unlink(backupFile).catch(() => {});
    if (chkFile) await fs.unlink(chkFile).catch(() => {});
  }
}

/**
 * Polls until the domain has no running job, then confirms the completed job
 * was a successful Backup. Aborts the job and throws on timeout, so a wedged
 * block job can never leave a half-written image looking like a good backup.
 */
export async function waitForBackupJob(vmUuid: string, timeoutMs = 6 * 60 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Ramp the poll interval: backups of a small disk finish in seconds, while a
  // multi-hundred-GB disk runs for an hour and does not need second-by-second
  // attention (each poll is a virsh fork).
  let intervalMs = 1_000;

  for (;;) {
    let out: string;
    try {
      out = await virsh(['domjobinfo', vmUuid], { timeout: 20_000 });
    } catch (err) {
      // The domain disappearing mid-job (operator destroyed it) is a genuine
      // backup failure, not something to keep polling through.
      throw new Error(`Lost track of the backup job: ${String(err)}`);
    }

    const jobType = parseJobField(out, 'Job type');
    if (!jobType || jobType.toLowerCase() === 'none') break;

    if (Date.now() > deadline) {
      await virsh(['domjobabort', vmUuid], { timeout: 30_000 }).catch(() => {});
      throw new Error(`Backup job did not finish within ${Math.round(timeoutMs / 60_000)} minutes - aborted`);
    }
    await sleep(intervalMs);
    intervalMs = Math.min(intervalMs * 2, 15_000);
  }

  // `--keep-completed` leaves the stats readable so a retry (or an operator
  // running virsh by hand) can still see what happened.
  const completed = await virsh(
    ['domjobinfo', vmUuid, '--completed', '--keep-completed', '--anystats'],
    { timeout: 20_000 },
  ).catch(() => '');

  const operation = parseJobField(completed, 'Operation');
  const jobType = parseJobField(completed, 'Job type');

  // Only a job we can positively identify as a *failed* Backup is an error.
  // An empty or unrecognised readout means libvirt discarded the stats (a
  // concurrent reader, or a restart) — the caller validates the output files
  // regardless, so guessing "failed" here would reject good backups.
  if (operation === 'Backup' && /failed/i.test(jobType)) {
    throw new Error(`libvirt reported the backup job failed (${completed.split('\n')[0] ?? 'no detail'})`);
  }
}
