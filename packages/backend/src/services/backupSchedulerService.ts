import {
  readSchedules,
  saveSchedule,
  createBackup,
  applyRetentionAll,
  computeNextRunAt,
  type BackupSchedule,
} from './backupService.js';

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

// Retention and the abandoned-directory sweep used to run at startup and
// nowhere else, so a host that simply stays up never reclaimed anything a
// per-VM backup pass did not cover. Twelve hours is well inside the sweep's own
// 24-hour age threshold, and the whole pass is a few readdirs per VM.
const HOUSEKEEPING_INTERVAL_MS = 12 * 60 * 60_000;

export function startBackupScheduler(): void {
  if (schedulerTimer) return;
  applyRetentionAll().catch(() => {});
  schedulerTimer = setInterval(tick, 60_000);
  setInterval(() => {
    applyRetentionAll().catch((err: unknown) => {
      console.error('[backup-scheduler] Housekeeping pass failed:', err);
    });
  }, HOUSEKEEPING_INTERVAL_MS);
}

async function tick(): Promise<void> {
  const now = new Date();
  let schedules: Record<string, BackupSchedule>;
  try {
    schedules = await readSchedules();
  } catch {
    return;
  }

  for (const [vmUuid, schedule] of Object.entries(schedules)) {
    if (!schedule.enabled) continue;
    if (!schedule.nextRunAt) continue;
    if (new Date(schedule.nextRunAt) > now) continue;

    // Due — run in background, don't await
    runScheduledBackup(vmUuid, schedule);
  }
}

async function runScheduledBackup(vmUuid: string, schedule: BackupSchedule): Promise<void> {
  // Mark next run immediately to avoid double-firing. If we can't work out a
  // next run that is strictly in the future, the schedule would stay due on
  // every tick and back the VM up until the disk fills — disable it instead
  // and let the operator fix the schedule.
  let next: Date;
  try {
    next = computeNextRunAt(schedule);
  } catch (err) {
    console.error(`[backup-scheduler] Disabling unusable schedule for ${vmUuid}:`, err);
    await saveSchedule({ ...schedule, enabled: false, nextRunAt: null });
    return;
  }
  if (next.getTime() <= Date.now()) {
    console.error(`[backup-scheduler] Disabling schedule for ${vmUuid}: next run (${next.toISOString()}) is not in the future`);
    await saveSchedule({ ...schedule, enabled: false, nextRunAt: null });
    return;
  }

  const updated: BackupSchedule = {
    ...schedule,
    lastRunAt: new Date().toISOString(),
    nextRunAt: next.toISOString(),
  };
  await saveSchedule(updated);

  try {
    await createBackup(vmUuid, {
      triggerType: 'scheduled',
      scheduleFrequency: schedule.frequency,
      retentionDaysOverride: schedule.retentionDays,
      // `auto` lets the engine take an incremental when the chain is healthy
      // and silently fall back to a full when it isn't — a schedule must never
      // skip a run just because an incremental wasn't possible.
      kind: schedule.mode === 'incremental' ? 'auto' : 'full',
      fullEvery: schedule.fullEvery,
    });
    await recordOutcome(vmUuid, { lastRunStatus: 'success', lastError: undefined });
  } catch (err) {
    console.error(`[backup-scheduler] Scheduled backup failed for ${vmUuid}:`, err);
    // Recorded on the schedule, not just in the log: a backup that has quietly
    // stopped working is the failure mode that matters, and nobody finds it by
    // reading journalctl.
    await recordOutcome(vmUuid, {
      lastRunStatus: 'error',
      lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    });
  }
}

// Re-read before writing: the run may have taken hours, and the operator could
// have edited the schedule in the meantime.
async function recordOutcome(
  vmUuid: string,
  outcome: { lastRunStatus: 'success' | 'error'; lastError?: string },
): Promise<void> {
  try {
    const current = (await readSchedules())[vmUuid];
    if (!current) return;
    await saveSchedule({ ...current, ...outcome });
  } catch (err) {
    console.error(`[backup-scheduler] Could not record the run outcome for ${vmUuid}:`, err);
  }
}
