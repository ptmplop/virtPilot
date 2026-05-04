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
  // Mark next run immediately to avoid double-firing
  const next = computeNextRunAt(schedule);
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
