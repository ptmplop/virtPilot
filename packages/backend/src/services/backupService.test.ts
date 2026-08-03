import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeNextRunAt, assertSafeBackupDiskFilename, type BackupSchedule } from './backupService.js';

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
