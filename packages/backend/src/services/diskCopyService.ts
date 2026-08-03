// Produces a consistent copy of a VM's disks without stalling the guest.
//
// Shared by the backup engine and the VM-clone flow, because both need exactly
// the same thing: "give me a point-in-time image of these disks, and tell me
// how trustworthy it is".
//
// Four tiers, best first. Each falls through to the next only when the one
// above is unavailable or fails, and every degradation is recorded in `notes`
// so the operator can see *why* a backup came out crash-consistent.
//
//   1. libvirt-backup   qemu does copy-before-write internally. Guest freeze is
//                       the job's start latency (milliseconds). Only tier that
//                       can produce incrementals.
//   2. snapshot-convert Pivot the domain onto a throwaway overlay, copy the now
//                       static base, commit the overlay back.
//   3. direct-convert   Copy the live disk with no coordination at all.
//                       Crash-consistent; the last resort for a running VM.
//   4. offline-convert  VM is off, the image is idle. Always consistent.
//
// Tier 3 deliberately does NOT freeze the guest for the duration of the copy.
// That was the old behaviour and it held guest filesystems frozen for as long
// as the copy took — up to an hour on a large disk, long enough to trip guest
// watchdogs and stall every application on the machine.

import fs from 'fs/promises';
import * as vmService from './vmService.js';
import * as libvirtBackup from './libvirtBackupService.js';
import { run, qemuImg } from './safeExec.js';
import { validateVmUuid, validateDiskTarget } from '../lib/validate.js';
import type { TraceEntry } from './traceService.js';

export type CopyMethod = 'libvirt-backup' | 'snapshot-convert' | 'direct-convert' | 'offline-convert';

export interface DiskCopyBacking {
  /** Resolvable now, so `qemu-img create` can read the parent's size. */
  absolutePath: string;
  /** Stored in the image, so the whole backup tree stays relocatable. */
  relativePath: string;
}

export interface DiskCopySpec {
  /** libvirt disk target, e.g. `vda` */
  target: string;
  /** The domain's current image for that target, captured before any snapshot. */
  sourcePath: string;
  /** Absolute path to write the copy to. */
  destPath: string;
  /** Parent image to layer this copy on top of. Incremental copies only. */
  backing?: DiskCopyBacking;
}

export interface DiskCopyOptions {
  vmUuid: string;
  vmName: string;
  running: boolean;
  disks: DiskCopySpec[];
  /** Targets present on the domain that must not be copied (cdroms). */
  excludeTargets: string[];
  /** Compress the output with `qemu-img -c`. Ignored for incrementals. */
  compress?: boolean;
  /** Create this checkpoint alongside the copy, enabling later incrementals. */
  createCheckpoint?: string;
  /** Copy only clusters changed since this checkpoint. Forces the libvirt tier. */
  incrementalFrom?: string;
  /** Snapshot name to use for the tier-2 overlay. */
  snapshotLabel: string;
  timeoutMs?: number;
  trace?: TraceEntry[];
}

export interface DiskCopyResult {
  method: CopyMethod;
  /** Guest filesystems were quiesced, or the VM was off — restorable without fsck. */
  consistent: boolean;
  checkpointCreated: boolean;
  compressed: boolean;
  /** Operator-facing explanation of any fallback that was taken. */
  notes: string[];
}

const DEFAULT_TIMEOUT = 6 * 60 * 60_000;

function convertArgs(src: string, dest: string, opts: { compress?: boolean; forceShare?: boolean }): string[] {
  const args = ['convert'];
  if (opts.forceShare) args.push('-U');
  if (opts.compress) args.push('-c');
  args.push('-f', 'qcow2', '-O', 'qcow2', src, dest);
  return args;
}

// Re-encode an already-written image in place. Used only when the operator has
// asked for compression on a path that cannot compress inline (libvirt's block
// job writes uncompressed). Costs one extra pass and transiently doubles the
// space used by that disk in the backup directory.
async function compressInPlace(destPath: string, timeoutMs: number, trace?: TraceEntry[]): Promise<void> {
  const tmp = `${destPath}.compressing`;
  try {
    await qemuImg(convertArgs(destPath, tmp, { compress: true }), { timeout: timeoutMs, trace });
    // rename() needs write permission on the directory, not on either file, so
    // it works even though qemu-img wrote `tmp` as libvirt-qemu.
    await fs.rename(tmp, destPath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

async function virtualSizeBytes(imagePath: string): Promise<number> {
  // -U because the source may be open by a running guest.
  const out = await qemuImg(['info', '-U', '--output=json', imagePath], { timeout: 60_000 });
  const size = (JSON.parse(out) as { 'virtual-size'?: number })['virtual-size'];
  if (typeof size !== 'number' || size <= 0) throw new Error(`Could not read the virtual size of ${imagePath}`);
  return size;
}

/**
 * Creates the empty target image a push-mode backup will be written into.
 *
 * Done as the service account (not via the libvirt-qemu wrapper) so the
 * finished backup is owned by us at mode 0660 — readable both by the service
 * and, through the shared group, by every later `qemu-img` call. Letting
 * libvirt create the file instead leaves it `root:root 0600` once the job
 * releases it, which silently breaks incrementals and restores.
 */
async function precreateBackupTarget(spec: DiskCopySpec, trace?: TraceEntry[]): Promise<void> {
  await fs.unlink(spec.destPath).catch(() => { /* no leftover from an aborted run */ });

  if (spec.backing) {
    // Created against the absolute path so qemu-img can open the parent to
    // inherit its virtual size, then rewritten to the relative form with a
    // metadata-only rebase.
    await run(
      'qemu-img',
      ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', spec.backing.absolutePath, spec.destPath],
      { timeout: 120_000, trace },
    );
    await run(
      'qemu-img',
      ['rebase', '-u', '-F', 'qcow2', '-b', spec.backing.relativePath, spec.destPath],
      { timeout: 120_000, trace },
    );
  } else {
    const size = await virtualSizeBytes(spec.sourcePath);
    await run('qemu-img', ['create', '-f', 'qcow2', spec.destPath, String(size)], { timeout: 120_000, trace });
  }

  await fs.chmod(spec.destPath, 0o660).catch(() => { /* best-effort */ });
}

export async function copyVmDisks(opts: DiskCopyOptions): Promise<DiskCopyResult> {
  const uuid = validateVmUuid(opts.vmUuid);
  for (const d of opts.disks) validateDiskTarget(d.target);
  if (opts.disks.length === 0) throw new Error('copyVmDisks: no disks to copy');

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const notes: string[] = [];
  const compress = !!opts.compress && !opts.incrementalFrom;

  // ── Tier 4: VM is off ──────────────────────────────────────────────────────
  if (!opts.running) {
    if (opts.incrementalFrom) {
      throw new Error('Incremental backups require the VM to be running — libvirt cannot read dirty bitmaps from a stopped domain');
    }
    for (const d of opts.disks) {
      await qemuImg(convertArgs(d.sourcePath, d.destPath, { compress }), { timeout: timeoutMs, trace: opts.trace });
    }
    return { method: 'offline-convert', consistent: true, checkpointCreated: false, compressed: compress, notes };
  }

  // ── Tier 1: libvirt push-mode backup ───────────────────────────────────────
  const supported = await libvirtBackup.isBackupSupported();
  if (supported) {
    try {
      for (const d of opts.disks) await precreateBackupTarget(d, opts.trace);

      // The freeze only has to span `backup-begin`, which returns once qemu has
      // the job running and the point-in-time captured.
      const frozen = await vmService.fsFreeze(uuid);
      try {
        await libvirtBackup.beginPushBackup({
          vmUuid: uuid,
          disks: opts.disks.map((d) => ({ target: d.target, destPath: d.destPath })),
          excludeTargets: opts.excludeTargets,
          incrementalFrom: opts.incrementalFrom,
          createCheckpoint: opts.createCheckpoint,
          reuseExternal: true,
          trace: opts.trace,
        });
      } finally {
        if (frozen) await vmService.fsThaw(uuid);
      }

      await libvirtBackup.waitForBackupJob(uuid, timeoutMs);

      // libvirt hands back the target files only once the job is done; confirm
      // they exist before declaring success, since a job whose completion stats
      // libvirt had already discarded reads as "not failed".
      for (const d of opts.disks) {
        try {
          await fs.access(d.destPath);
        } catch {
          throw new Error(`libvirt reported no failure but produced no image for ${d.target}`);
        }
      }

      if (compress) {
        for (const d of opts.disks) await compressInPlace(d.destPath, timeoutMs, opts.trace);
      }
      if (!frozen) {
        notes.push('Guest agent unavailable — the copy is crash-consistent rather than application-consistent.');
      }
      return {
        method: 'libvirt-backup',
        consistent: frozen,
        checkpointCreated: !!opts.createCheckpoint,
        compressed: compress,
        notes,
      };
    } catch (err) {
      if (opts.incrementalFrom) {
        // There is no non-libvirt way to compute a delta, so an incremental
        // cannot degrade — the caller retries as a full backup instead.
        throw err;
      }
      notes.push(`libvirt push-mode backup failed (${String(err)}); fell back to a snapshot-assisted copy.`);
      // Partial output from the aborted job would otherwise be mistaken for a
      // real image by the fallback tiers.
      for (const d of opts.disks) await fs.unlink(d.destPath).catch(() => {});
    }
  } else if (opts.incrementalFrom) {
    throw new Error('This host\'s libvirt/qemu does not support incremental backup (domcapabilities reports backup unsupported)');
  } else {
    notes.push('Host libvirt/qemu does not support push-mode backup; used a snapshot-assisted copy.');
  }

  // ── Tier 2: transient external snapshot ────────────────────────────────────
  try {
    const snapshot = await vmService.createTransientDiskSnapshot(uuid, opts.snapshotLabel, opts.trace);
    const baseByTarget = new Map(snapshot.disks.map((d) => [d.target, d.base]));
    try {
      for (const d of opts.disks) {
        // Copy the pre-snapshot image, which the guest is no longer writing to.
        const base = baseByTarget.get(d.target) ?? d.sourcePath;
        await qemuImg(convertArgs(base, d.destPath, { compress, forceShare: true }), {
          timeout: timeoutMs,
          trace: opts.trace,
        });
      }
    } finally {
      // Non-negotiable: leaving the domain running on the overlay would mean
      // every subsequent write lands in a file nothing else knows about.
      await vmService.commitTransientDiskSnapshot(uuid, snapshot, opts.trace);
    }
    if (!snapshot.quiesced) {
      notes.push('Guest agent unavailable — the copy is crash-consistent rather than application-consistent.');
    }
    return {
      method: 'snapshot-convert',
      consistent: snapshot.quiesced,
      checkpointCreated: false,
      compressed: compress,
      notes,
    };
  } catch (err) {
    notes.push(`Snapshot-assisted copy failed (${String(err)}); fell back to copying the live disk.`);
    for (const d of opts.disks) await fs.unlink(d.destPath).catch(() => {});
  }

  // ── Tier 3: straight copy of the live disk ─────────────────────────────────
  for (const d of opts.disks) {
    await qemuImg(convertArgs(d.sourcePath, d.destPath, { compress, forceShare: true }), {
      timeout: timeoutMs,
      trace: opts.trace,
    });
  }
  notes.push('The guest was writing during the copy — restore may need a filesystem check.');
  return { method: 'direct-convert', consistent: false, checkpointCreated: false, compressed: compress, notes };
}
