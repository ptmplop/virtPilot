import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeNextRunAt,
  assertSafeBackupDiskFilename,
  countConsecutiveNonChainingFulls,
  isSuppressedInFlightDir,
  type BackupSchedule,
} from './backupService.js';

const schedule = (over: Partial<BackupSchedule> = {}): BackupSchedule => ({
  vmUuid: '3633a961-f385-4494-8df1-237787710c4f',
  vmName: 'qa-vm',
  frequency: 'daily',
  hour: 2,
  minute: 30,
  dayOfWeek: 1,
  dayOfMonth: 1,
  retentionDays: 7,
  enabled: true,
  lastRunAt: null,
  nextRunAt: null,
  ...over,
});

describe('computeNextRunAt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Wednesday 2026-08-05, 12:00 local.
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0));
  });
  afterEach(() => vi.useRealTimers());

  it('schedules hourly at the given minute, rolling to the next hour once past', () => {
    // 12:00 now — :15 is still ahead, so it fires this hour.
    expect(computeNextRunAt(schedule({ frequency: 'hourly', minute: 15 })).getHours()).toBe(12);
    vi.setSystemTime(new Date(2026, 7, 5, 12, 30, 0));
    // 12:30 now — :15 has gone, so it waits for 13:15.
    const next = computeNextRunAt(schedule({ frequency: 'hourly', minute: 15 }));
    expect(next.getHours()).toBe(13);
    expect(next.getMinutes()).toBe(15);
  });

  it('schedules daily, rolling to tomorrow when the time has passed', () => {
    expect(computeNextRunAt(schedule({ frequency: 'daily', hour: 2, minute: 30 })).getDate()).toBe(6);
    expect(computeNextRunAt(schedule({ frequency: 'daily', hour: 23, minute: 0 })).getDate()).toBe(5);
  });

  it('schedules weekly on the requested weekday', () => {
    // Friday is 2 days after Wednesday.
    expect(computeNextRunAt(schedule({ frequency: 'weekly', dayOfWeek: 5, hour: 3 })).getDate()).toBe(7);
    // Same weekday but the time has passed — a week out, not today.
    expect(computeNextRunAt(schedule({ frequency: 'weekly', dayOfWeek: 3, hour: 3 })).getDate()).toBe(12);
  });

  it('schedules monthly on the requested day', () => {
    expect(computeNextRunAt(schedule({ frequency: 'monthly', dayOfMonth: 20, hour: 3 })).getMonth()).toBe(7);
    // Day already gone this month — next month.
    expect(computeNextRunAt(schedule({ frequency: 'monthly', dayOfMonth: 1, hour: 3 })).getMonth()).toBe(8);
  });

  it('always returns a time strictly in the future', () => {
    for (const frequency of ['hourly', 'daily', 'weekly', 'monthly'] as const) {
      expect(computeNextRunAt(schedule({ frequency })).getTime()).toBeGreaterThan(Date.now());
    }
  });

  // A schedule persisted by an older or tampered build could carry a frequency
  // we no longer understand. Falling through used to return "now", which the
  // scheduler read as permanently due — backing the VM up every minute until
  // the disk filled.
  it('throws on an unknown frequency instead of returning now', () => {
    expect(() => computeNextRunAt(schedule({ frequency: 'fortnightly' as BackupSchedule['frequency'] })))
      .toThrow(/Unknown backup frequency/);
  });
});

describe('assertSafeBackupDiskFilename', () => {
  it('accepts the names the backup engine writes', () => {
    expect(assertSafeBackupDiskFilename('disk.qcow2')).toBe('disk.qcow2');
    expect(assertSafeBackupDiskFilename('extra-disk-1.qcow2')).toBe('extra-disk-1.qcow2');
  });

  // A manifest is operator-writable data on disk and restore joins this onto a
  // path, so a crafted entry must not escape the VM's directory. Traversal is
  // defused by taking the basename; anything that still isn't a plain qcow2
  // name after that is refused outright.
  it.each([
    ['a traversal', '../../etc/cron.d/x.qcow2', 'x.qcow2'],
    ['an absolute path', '/tmp/disk.qcow2', 'disk.qcow2'],
  ])('reduces %s to its leaf', (_l, input, expected) => {
    expect(assertSafeBackupDiskFilename(input)).toBe(expected);
  });

  it.each([
    ['an absolute non-qcow2 path', '/etc/passwd'],
    ['a dotfile', '.hidden.qcow2'],
    ['a shell script masquerading as a disk', 'disk.qcow2.sh'],
    ['no extension', 'disk'],
    ['empty', ''],
    ['a traversal that leaves no valid leaf', '../../etc/cron.d/x'],
  ])('rejects %s', (_l, name) => {
    expect(() => assertSafeBackupDiskFilename(name)).toThrow(/invalid disk filename/i);
  });
});

// Drives the "this schedule says incremental but keeps taking fulls" alert.
// Getting the boundary wrong in either direction is costly: one too eager and
// every mode switch fires a false alarm on its own bootstrap run; one too lax
// and a permanently degraded schedule stays invisible, which is the failure
// this alert exists for. Input is newest-first, as listBackupsForVm returns.
describe('countConsecutiveNonChainingFulls', () => {
  /** A run that tried to chain and came back without a checkpoint. */
  const degraded = { hasCheckpoint: false, chainRequested: true };
  /** A run that tried to chain and succeeded — a working chain root. */
  const chainable = { hasCheckpoint: true, chainRequested: true };
  /** A plain full-mode backup, which never asked for a checkpoint. */
  const plainFull = { hasCheckpoint: false, chainRequested: false };

  it('counts nothing when the newest backup is chainable', () => {
    expect(countConsecutiveNonChainingFulls([chainable, degraded, degraded])).toBe(0);
  });

  it('counts only up to the first chainable backup, ignoring older history', () => {
    expect(countConsecutiveNonChainingFulls([degraded, degraded, chainable, degraded])).toBe(2);
  });

  // The expected bootstrap after switching a schedule to incremental: exactly
  // one degraded run, which lays down the checkpoint the next run chains onto.
  it('reports one for a single degraded run, below the alert threshold', () => {
    expect(countConsecutiveNonChainingFulls([degraded, chainable])).toBe(1);
  });

  it('counts every backup when each one tried to chain and failed', () => {
    expect(countConsecutiveNonChainingFulls([degraded, degraded, degraded])).toBe(3);
  });

  // The reason this counts chainRequested rather than checkpoints alone.
  // Switching a long-standing full-mode schedule to incremental leaves a
  // history of checkpoint-less fulls that were never meant to chain; counting
  // those fired the alert the moment the setting was saved, before a single
  // run had happened.
  it('does not count full-mode history that never asked to chain', () => {
    expect(countConsecutiveNonChainingFulls([plainFull, plainFull, plainFull])).toBe(0);
    expect(countConsecutiveNonChainingFulls([degraded, plainFull, plainFull])).toBe(1);
  });

  // Manifests written before 2.9 carry no flag, so they read as chainRequested
  // false and stop the count at the upgrade boundary rather than being guessed at.
  it('stops at pre-2.9 backups rather than assuming they were degraded', () => {
    expect(countConsecutiveNonChainingFulls([degraded, plainFull, degraded])).toBe(1);
  });

  it('reports zero for a VM with no backups', () => {
    expect(countConsecutiveNonChainingFulls([])).toBe(0);
  });
});

// Guards the narrowest, most expensive mistake in the backup engine.
//
// A backup stays registered as "in progress" for the whole of
// _createBackupInner — including the reconcileCheckpoints call at the end,
// which runs *after* the manifest is written. Suppressing the whole directory
// on that basis hid the fresh manifest from reconciliation, which then deleted
// the checkpoint the backup had just created, so no incremental chain could
// ever form. Suppression must therefore be limited to directories that hold
// nothing usable yet.
describe('isSuppressedInFlightDir', () => {
  const IN_FLIGHT = '20260805T084407Z-7b6b1c';

  it('suppresses the in-flight directory while it has no completion marker', () => {
    expect(isSuppressedInFlightDir({ id: IN_FLIGHT, why: 'incomplete' }, IN_FLIGHT)).toBe(true);
  });

  it('never suppresses an unreadable manifest, even for the running backup', () => {
    expect(isSuppressedInFlightDir({ id: IN_FLIGHT, why: 'unreadable' }, IN_FLIGHT)).toBe(false);
  });

  it('does not suppress other VMs\' abandoned directories', () => {
    expect(isSuppressedInFlightDir({ id: '20260603T020043Z-a58f70', why: 'incomplete' }, IN_FLIGHT)).toBe(false);
  });

  it('suppresses nothing when no backup is running', () => {
    expect(isSuppressedInFlightDir({ id: IN_FLIGHT, why: 'incomplete' }, undefined)).toBe(false);
  });
});
