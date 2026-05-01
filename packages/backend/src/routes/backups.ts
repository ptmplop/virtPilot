import { Router } from 'express';
import {
  listAllVmBackupSummaries,
  listBackupsForVm,
  getBackupManifest,
  createBackup,
  deleteBackup,
  restoreBackup,
  getSchedule,
  saveSchedule,
  deleteSchedule,
  computeNextRunAt,
  type BackupFrequency,
  type BackupSchedule,
} from '../services/backupService.js';

export const backupsRouter = Router();

// ─── Summaries ────────────────────────────────────────────────────────────────

backupsRouter.get('/', async (_req, res) => {
  try {
    const summaries = await listAllVmBackupSummaries();
    res.json({ summaries });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Schedules ────────────────────────────────────────────────────────────────
// Fix 1: Schedule routes must be registered BEFORE /:vmName/:backupId to avoid
// "schedules" being captured as vmName and backupId by the wildcard routes.

backupsRouter.get('/schedules/:vmName', async (req, res) => {
  try {
    const schedule = await getSchedule(req.params.vmName);
    res.json({ schedule });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

backupsRouter.put('/schedules/:vmName', async (req, res) => {
  try {
    const { vmName } = req.params;
    const body = req.body as {
      frequency: BackupFrequency;
      hour?: number;
      minute?: number;
      dayOfWeek?: number;
      dayOfMonth?: number;
      retentionDays?: number | null;
      enabled?: boolean;
    };

    const existing = await getSchedule(vmName);
    const schedule: BackupSchedule = {
      vmName,
      frequency: body.frequency,
      hour: Math.min(23, Math.max(0, body.hour ?? existing?.hour ?? 2)),
      minute: Math.min(59, Math.max(0, body.minute ?? existing?.minute ?? 0)),
      dayOfWeek: Math.min(6, Math.max(0, body.dayOfWeek ?? existing?.dayOfWeek ?? 1)),
      // Fix 8: Clamp to 28 — day 29+ causes JavaScript Date.setDate overflow on short months
      dayOfMonth: Math.min(28, Math.max(1, body.dayOfMonth ?? existing?.dayOfMonth ?? 1)),
      retentionDays: body.retentionDays !== undefined ? body.retentionDays : (existing?.retentionDays ?? null),
      enabled: body.enabled !== undefined ? body.enabled : true,
      lastRunAt: existing?.lastRunAt ?? null,
      nextRunAt: null,
    };
    schedule.nextRunAt = computeNextRunAt(schedule).toISOString();
    await saveSchedule(schedule);
    res.json({ schedule });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

backupsRouter.delete('/schedules/:vmName', async (req, res) => {
  try {
    await deleteSchedule(req.params.vmName);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Per-VM backup list ───────────────────────────────────────────────────────

backupsRouter.get('/:vmName', async (req, res) => {
  try {
    const { vmName } = req.params;
    const backups = await listBackupsForVm(vmName);
    const schedule = await getSchedule(vmName);
    res.json({ backups, schedule });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Trigger manual backup ────────────────────────────────────────────────────

backupsRouter.post('/:vmName', async (req, res) => {
  try {
    const { vmName } = req.params;
    const backup = await createBackup(vmName, { triggerType: 'manual' });
    res.json({ backup });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Backup detail ────────────────────────────────────────────────────────────

backupsRouter.get('/:vmName/:backupId', async (req, res) => {
  try {
    const { vmName, backupId } = req.params;
    const manifest = await getBackupManifest(vmName, backupId);
    if (!manifest) return res.status(404).json({ error: 'Backup not found' });
    res.json({ manifest });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Delete backup ────────────────────────────────────────────────────────────

backupsRouter.delete('/:vmName/:backupId', async (req, res) => {
  try {
    const { vmName, backupId } = req.params;
    await deleteBackup(vmName, backupId);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Restore backup ───────────────────────────────────────────────────────────

backupsRouter.post('/:vmName/:backupId/restore', async (req, res) => {
  try {
    const { vmName, backupId } = req.params;
    const { newVmName } = req.body as { newVmName?: string };
    await restoreBackup(vmName, backupId, newVmName);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});
