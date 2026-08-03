import { Router, type Request, type Response, type NextFunction } from 'express';
import { validateVmUuid, validateNonNegativeInt, validatePositiveInt, ValidationError } from '../lib/validate.js';
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
  getIncrementalStatus,
  DEFAULT_FULL_EVERY,
  MAX_FULL_EVERY,
  type BackupFrequency,
  type BackupKindRequest,
  type BackupSchedule,
  type BackupScheduleMode,
} from '../services/backupService.js';
import { createVmFromBackup } from '../services/vmDeriveService.js';
import * as vmMetaService from '../services/vmMetaService.js';
import * as logService from '../services/logService.js';
import { getVmInfo, startVm } from '../services/vmService.js';

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

// Kept in sync with BackupFrequency in backupService.ts — the union is the
// only set computeNextRunAt knows how to schedule.
const BACKUP_FREQUENCIES: readonly BackupFrequency[] = ['hourly', 'daily', 'weekly', 'monthly'];
function isBackupFrequency(v: unknown): v is BackupFrequency {
  return typeof v === 'string' && (BACKUP_FREQUENCIES as readonly string[]).includes(v);
}

const BACKUP_KINDS: readonly BackupKindRequest[] = ['full', 'incremental', 'auto'];
function isBackupKind(v: unknown): v is BackupKindRequest {
  return typeof v === 'string' && (BACKUP_KINDS as readonly string[]).includes(v);
}

const SCHEDULE_MODES: readonly BackupScheduleMode[] = ['full', 'incremental'];
function isScheduleMode(v: unknown): v is BackupScheduleMode {
  return typeof v === 'string' && (SCHEDULE_MODES as readonly string[]).includes(v);
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
// A restore can be refused for reasons that are entirely the caller's to fix —
// the VM is still running, the backup is incomplete, the chain is broken. Those
// are 4xx outcomes the UI acts on, not server faults, and reporting them as 500
// makes a legible error look like a crash.
function restoreFailureStatus(err: unknown): number {
  if (err instanceof ValidationError) return 400;
  const message = err instanceof Error ? err.message : String(err);
  if (/manifest not found/i.test(message)) return 404;
  if (/already exists/i.test(message)) return 409;
  if (/must be stopped|incomplete or corrupt|cannot be restored|no vmDisks storage directory|has no free IP|no free IP|not currently booting from/i.test(message)) {
    return 409;
  }
  if (/refusing to restore|no domain definition|contains no disks/i.test(message)) return 422;
  return 500;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
      frequency?: unknown;
      hour?: unknown;
      minute?: unknown;
      dayOfWeek?: unknown;
      dayOfMonth?: unknown;
      retentionDays?: number | null;
      enabled?: boolean;
      mode?: unknown;
      fullEvery?: unknown;
    };

    // An unknown or missing frequency makes computeNextRunAt fall back to
    // "now", and the scheduler then re-fires the backup every tick until the
    // disk fills. Reject it outright rather than guessing a default.
    if (!isBackupFrequency(body.frequency)) {
      return res.status(400).json({ error: `frequency must be one of: ${BACKUP_FREQUENCIES.join(', ')}` });
    }
    const existing = await getSchedule(vmUuid);
    const vmName = existing?.vmName ?? await resolveVmName(vmUuid);
    // Validate rather than clamp: Math.min/max pass NaN straight through
    // (Math.min(23, Math.max(0, NaN)) is NaN), which poisons every date
    // computed from the schedule.
    const schedule: BackupSchedule = {
      vmUuid,
      vmName,
      frequency: body.frequency,
      hour: body.hour != null ? validateNonNegativeInt(body.hour, 23) : (existing?.hour ?? 2),
      minute: body.minute != null ? validateNonNegativeInt(body.minute, 59) : (existing?.minute ?? 0),
      dayOfWeek: body.dayOfWeek != null ? validateNonNegativeInt(body.dayOfWeek, 6) : (existing?.dayOfWeek ?? 1),
      // Capped at 28 — day 29+ overflows on short months.
      dayOfMonth: body.dayOfMonth != null ? validatePositiveInt(body.dayOfMonth, 28) : (existing?.dayOfMonth ?? 1),
      retentionDays: body.retentionDays !== undefined ? body.retentionDays : (existing?.retentionDays ?? null),
      enabled: body.enabled !== undefined ? body.enabled : true,
      lastRunAt: existing?.lastRunAt ?? null,
      nextRunAt: null,
      mode: isScheduleMode(body.mode) ? body.mode : (existing?.mode ?? 'full'),
      // Bounded rather than free-form: a chain of thousands of incrementals is
      // slow to restore and loses everything if any one link is damaged.
      fullEvery: body.fullEvery != null
        ? validatePositiveInt(body.fullEvery, MAX_FULL_EVERY)
        : (existing?.fullEvery ?? DEFAULT_FULL_EVERY),
    };
    schedule.nextRunAt = computeNextRunAt(schedule).toISOString();
    await saveSchedule(schedule);
    res.json({ schedule });
  } catch (err: unknown) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
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
    const incremental = await getIncrementalStatus(vmUuid);
    res.json({ backups, schedule, incremental });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Trigger manual backup ────────────────────────────────────────────────────

backupsRouter.post('/:vmUuid', requireUuidParam, async (req, res) => {
  try {
    const { vmUuid } = req.params;
    const { kind } = (req.body ?? {}) as { kind?: unknown };
    if (kind !== undefined && !isBackupKind(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${BACKUP_KINDS.join(', ')}` });
    }
    const schedule = await getSchedule(vmUuid);
    const backup = await createBackup(vmUuid, {
      triggerType: 'manual',
      kind: kind ?? 'full',
      fullEvery: schedule?.fullEvery,
    });
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
    const cascade = req.query.cascade === 'true';
    await deleteBackup(vmUuid, backupId, { cascade });
    res.json({ ok: true });
  } catch (err: unknown) {
    // Refusing to orphan a chain is an expected outcome the UI acts on, not a
    // server fault — it offers the cascade option in response.
    if (err instanceof Error && /depend on this one/.test(err.message)) {
      return res.status(409).json({ error: err.message, requiresCascade: true });
    }
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
    res.status(restoreFailureStatus(err)).json({ error: errorMessage(err) });
  }
});

// ─── Restore into a brand-new VM ──────────────────────────────────────────────

// Rebuilds the whole machine from the backup's stored domain definition rather
// than overwriting an existing VM's disks. This is what makes a backup a
// recovery point for a VM that has been deleted outright.
backupsRouter.post('/:vmUuid/:backupId/restore-as-new', requireUuidParam, validateBackupId, async (req, res) => {
  const start = Date.now();
  const { vmUuid, backupId } = req.params;
  const { name, storageDirId, regenerateCloudInit, password, start: startAfter } = (req.body ?? {}) as {
    name?: unknown;
    storageDirId?: unknown;
    regenerateCloudInit?: unknown;
    password?: unknown;
    start?: unknown;
  };

  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (storageDirId !== undefined && typeof storageDirId !== 'string') {
    return res.status(400).json({ error: 'storageDirId must be a string' });
  }
  if (password !== undefined && typeof password !== 'string') {
    return res.status(400).json({ error: 'password must be a string' });
  }

  try {
    const result = await createVmFromBackup({
      sourceVmUuid: vmUuid,
      backupId,
      newName: name.trim(),
      storageDirId: storageDirId as string | undefined,
      regenerateCloudInit: regenerateCloudInit !== false,
      password: password as string | undefined,
    });

    if (startAfter === true) {
      try {
        await startVm(result.uuid);
      } catch (err: unknown) {
        result.warnings.push(`The VM was created but would not start: ${String(err)}`);
      }
    }

    void logService.appendLog({
      type: 'backup.restore.new',
      subject: result.name,
      subjectUuid: result.uuid,
      status: 'success',
      output: [`Rebuilt from backup ${backupId} of "${result.sourceVmName}"`, ...result.warnings, result.output]
        .filter(Boolean)
        .join('\n'),
      durationMs: Date.now() - start,
    });
    res.status(201).json({ uuid: result.uuid, name: result.name, warnings: result.warnings });
  } catch (err: unknown) {
    void logService.appendLog({
      type: 'backup.restore.new',
      subject: typeof name === 'string' ? name : vmUuid,
      subjectUuid: vmUuid,
      status: 'error',
      output: String(err),
      durationMs: Date.now() - start,
    });
    res.status(restoreFailureStatus(err)).json({ error: errorMessage(err) });
  }
});
