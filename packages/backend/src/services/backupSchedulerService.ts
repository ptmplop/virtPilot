import {
  readSchedules,
  saveSchedule,
  createBackup,
  applyRetentionAll,
  computeNextRunAt,
  type BackupSchedule,
} from './backupService.js';

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

export function startBackupScheduler(): void {
  if (schedulerTimer) return;
  // Run retention cleanup once on startup
  applyRetentionAll().catch(() => {});
  schedulerTimer = setInterval(tick, 60_000);
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
    });
  } catch (err) {
    console.error(`[backup-scheduler] Scheduled backup failed for ${vmUuid}:`, err);
  }
}
