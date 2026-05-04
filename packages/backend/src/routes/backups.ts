import { Router, type Request, type Response, type NextFunction } from 'express';
import { validateVmUuid } from '../lib/validate.js';
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
  getBackupsInProgress,
  type BackupFrequency,
  type BackupSchedule,
} from '../services/backupService.js';
import * as vmMetaService from '../services/vmMetaService.js';
import { getVmInfo } from '../services/vmService.js';

export const backupsRouter = Router();

// backupId() in backupService.ts produces e.g. "20260504T131415Z-abc123":
// 8 digits date + T + 6 digits time + Z + dash + 6 hex chars. Anything else
// is either malformed or an attempt to traverse — reject it before the path
// it composes (`backupRoot/<vmUuid>/<id>`) reaches fs.* calls.
const BACKUP_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
function validateBackupId(req: Request, res: Response, next: NextFunction): void {
  if (!BACKUP_ID_RE.test(req.params.backupId ?? '')) {
    res.status(400).json({ error: 'Invalid backup id' });
    return;
  }
  next();
}

function requireUuidParam(req: Request, res: Response, next: NextFunction): void {
  try {
    validateVmUuid(req.params.vmUuid);
    next();
  } catch {
    res.status(400).json({ error: 'Invalid VM UUID' });
  }
}

// Resolve a friendly name for a VM identified by UUID. Used when the route
// caller hasn't supplied one — schedules carry the name in the body, so this
// is mostly the fallback for orphaned-VM display.
async function resolveVmName(vmUuid: string): Promise<string> {
  try {
    const info = await getVmInfo(vmUuid);
    return info.name;
  } catch { /* VM may have been deleted */ }
  try {
    const meta = await vmMetaService.getVmMeta(vmUuid);
    if (meta?.name) return meta.name;
  } catch { /* fall through */ }
  return vmUuid;
}

// ─── Summaries ────────────────────────────────────────────────────────────────

backupsRouter.get('/', async (_req, res) => {
  try {
    const summaries = await listAllVmBackupSummaries();
    res.json({ summaries });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── In-progress ─────────────────────────────────────────────────────────────

backupsRouter.get('/running', (_req, res) => {
  res.json({ running: getBackupsInProgress() });
});

// ─── Schedules ────────────────────────────────────────────────────────────────
// Schedule routes must be registered BEFORE /:vmUuid/:backupId to avoid
// "schedules" being captured as vmUuid by the wildcard routes.

backupsRouter.get('/schedules/:vmUuid', requireUuidParam, async (req, res) => {
  try {
    const schedule = await getSchedule(req.params.vmUuid);
    res.json({ schedule });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

backupsRouter.put('/schedules/:vmUuid', requireUuidParam, async (req, res) => {
  try {
    const { vmUuid } = req.params;
    const body = req.body as {
      frequency: BackupFrequency;
      hour?: number;
      minute?: number;
      dayOfWeek?: number;
      dayOfMonth?: number;
      retentionDays?: number | null;
      enabled?: boolean;
    };

    const existing = await getSchedule(vmUuid);
    const vmName = existing?.vmName ?? await resolveVmName(vmUuid);
    const schedule: BackupSchedule = {
      vmUuid,
      vmName,
      frequency: body.frequency,
      hour: Math.min(23, Math.max(0, body.hour ?? existing?.hour ?? 2)),
      minute: Math.min(59, Math.max(0, body.minute ?? existing?.minute ?? 0)),
      dayOfWeek: Math.min(6, Math.max(0, body.dayOfWeek ?? existing?.dayOfWeek ?? 1)),
      // Clamp to 28 — day 29+ overflows on short months.
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

backupsRouter.delete('/schedules/:vmUuid', requireUuidParam, async (req, res) => {
  try {
    await deleteSchedule(req.params.vmUuid);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Per-VM backup list ───────────────────────────────────────────────────────

backupsRouter.get('/:vmUuid', requireUuidParam, async (req, res) => {
  try {
    const { vmUuid } = req.params;
    const backups = await listBackupsForVm(vmUuid);
    const schedule = await getSchedule(vmUuid);
    res.json({ backups, schedule });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Trigger manual backup ────────────────────────────────────────────────────

backupsRouter.post('/:vmUuid', requireUuidParam, async (req, res) => {
  try {
    const { vmUuid } = req.params;
    const backup = await createBackup(vmUuid, { triggerType: 'manual' });
    res.json({ backup });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Backup detail ────────────────────────────────────────────────────────────

backupsRouter.get('/:vmUuid/:backupId', requireUuidParam, validateBackupId, async (req, res) => {
  try {
    const { vmUuid, backupId } = req.params;
    const manifest = await getBackupManifest(vmUuid, backupId);
    if (!manifest) return res.status(404).json({ error: 'Backup not found' });
    res.json({ manifest });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Delete backup ────────────────────────────────────────────────────────────

backupsRouter.delete('/:vmUuid/:backupId', requireUuidParam, validateBackupId, async (req, res) => {
  try {
    const { vmUuid, backupId } = req.params;
    await deleteBackup(vmUuid, backupId);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Restore backup ───────────────────────────────────────────────────────────

backupsRouter.post('/:vmUuid/:backupId/restore', requireUuidParam, validateBackupId, async (req, res) => {
  try {
    const { vmUuid, backupId } = req.params;
    const { targetVmUuid } = req.body as { targetVmUuid?: string };
    await restoreBackup(vmUuid, backupId, targetVmUuid);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});
