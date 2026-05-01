import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArchiveRestore,
  CalendarClock,
  Check,
  ChevronLeft,
  Clock,
  HardDrive,
  Info,
  Play,
  ShieldAlert,
  Trash2,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  useBackupSummaries,
  useVmBackups,
  useCreateBackup,
  useDeleteBackup,
  useRestoreBackup,
  useSaveSchedule,
  useDeleteSchedule,
} from '@/hooks/useBackups';
import { useVms } from '@/hooks/useVms';
import type { BackupEntry, BackupFrequency, BackupSchedule, BackupVmSummary } from '@/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
  return `${(bytes / 1_024).toFixed(0)} KB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// Fix 14: "just now" for sub-1-minute backups
function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function frequencyLabel(f: BackupFrequency): string {
  return { hourly: 'Hourly', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }[f];
}

// ─── Page ─────────────────────────────────────────────────────────────────────

// Fix 4: Drive rendering from the URL param directly — no duplicated local state
// that could diverge from the route on browser back/forward navigation.
export function BackupsPage() {
  const { vmName: selectedVm } = useParams<{ vmName?: string }>();
  const navigate = useNavigate();

  if (selectedVm) {
    return (
      <VmBackupsPanel
        vmName={selectedVm}
        onBack={() => navigate('/backups', { replace: true })}
      />
    );
  }

  return <BackupsList onSelect={(name) => navigate(`/backups/${name}`, { replace: true })} />;
}

function BackupsList({ onSelect }: { onSelect: (name: string) => void }) {
  const { data: summaries, isLoading: summariesLoading } = useBackupSummaries();
  const { data: vms, isLoading: vmsLoading } = useVms();

  const isLoading = summariesLoading || vmsLoading;

  // Merge: every VM from libvirt, enriched with backup data where available
  const summaryMap = new Map((summaries ?? []).map((s) => [s.vmName, s]));
  const rows: BackupVmSummary[] = (vms ?? []).map(
    (vm) =>
      summaryMap.get(vm.name) ?? {
        vmName: vm.name,
        backupCount: 0,
        totalSizeBytes: 0,
        lastBackupAt: null,
        schedule: null,
      }
  );

  return (
    <Layout title="Backups" subtitle="Manage VM backups and schedules">
      <div className="space-y-3">
        <BackupInfoPanel />
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))
        ) : rows.length > 0 ? (
          rows.map((s) => (
            <SummaryRow key={s.vmName} summary={s} onSelect={onSelect} />
          ))
        ) : (
          <EmptyState />
        )}
      </div>
    </Layout>
  );
}

// ─── Info panel ───────────────────────────────────────────────────────────────

function BackupInfoPanel() {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border border-border bg-card/50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left"
      >
        <Info size={13} className="shrink-0 text-muted-foreground" />
        <span className="flex-1 text-xs text-muted-foreground">Understanding backup states</span>
        <ChevronLeft
          size={13}
          className={`text-muted-foreground transition-transform ${open ? '-rotate-90' : 'rotate-90'}`}
        />
      </button>

      {open && (
        <div className="border-t border-border px-4 pb-4 pt-3">
          <div className="space-y-3">
            <div className="flex gap-3">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                <Check size={13} className="text-emerald-400" />
              </div>
              <div>
                <p className="text-xs font-semibold text-foreground">App-consistent</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  The VM's filesystems were frozen via the QEMU guest agent before the disk was
                  copied. All writes were flushed and paused, so the backup is guaranteed to be
                  in a clean state — safe to restore databases and any application without extra steps.
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                <ShieldAlert size={13} className="text-amber-400" />
              </div>
              <div>
                <p className="text-xs font-semibold text-foreground">No guest agent <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-px text-[10px] font-semibold text-amber-400"><ShieldAlert size={8} />No guest agent</span></p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  The QEMU guest agent was not available, so filesystems were not frozen before
                  copying. The backup may capture a disk mid-write. Simple workloads and stopped
                  VMs recover cleanly; databases or applications with open transactions may need
                  a consistency check (e.g. <code className="rounded bg-muted px-1 font-mono">fsck</code>,{' '}
                  <code className="rounded bg-muted px-1 font-mono">mysqlcheck</code>) after restore.
                </p>
                <p className="mt-1.5 text-xs text-muted-foreground/70">
                  To enable app-consistent backups, install{' '}
                  <code className="rounded bg-muted px-1 font-mono">qemu-guest-agent</code> inside
                  the VM and ensure the service is running.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Summary row ──────────────────────────────────────────────────────────────

function SummaryRow({ summary, onSelect }: { summary: BackupVmSummary; onSelect: (v: string) => void }) {
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const createBackup = useCreateBackup(summary.vmName);

  function handleBackupNow() {
    toast.promise(createBackup.mutateAsync(), {
      loading: 'Creating backup…',
      success: 'Backup created',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      error: (e: any) => `Backup failed: ${String(e.response?.data?.error ?? e.message)}`,
    });
  }

  return (
    <>
      <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-5 py-4 transition-all hover:border-border/80 hover:bg-card/80">
        <button
          type="button"
          onClick={() => onSelect(summary.vmName)}
          className="flex min-w-0 flex-1 items-center gap-4 text-left"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <HardDrive size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">{summary.vmName}</p>
            <p className="text-xs text-muted-foreground">
              {summary.backupCount === 0
                ? 'No backups'
                : `${summary.backupCount} backup${summary.backupCount !== 1 ? 's' : ''} · ${formatBytes(summary.totalSizeBytes)}`}
              {summary.lastBackupAt && ` · Last: ${formatRelative(summary.lastBackupAt)}`}
            </p>
          </div>
          {summary.schedule ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
              <CalendarClock size={10} />
              {frequencyLabel(summary.schedule.frequency)}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
              No schedule
            </span>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-1.5 pl-1">
          <Button
            variant="secondary"
            size="sm"
            className="h-7 gap-1 px-2.5 text-xs"
            onClick={() => setScheduleOpen(true)}
          >
            <CalendarClock size={12} />
            {summary.schedule ? 'Schedule' : 'Set Schedule'}
          </Button>
          <Button
            size="sm"
            className="h-7 gap-1 px-2.5 text-xs"
            onClick={handleBackupNow}
            disabled={createBackup.isPending}
          >
            {createBackup.isPending ? (
              <Clock size={12} className="animate-spin" />
            ) : (
              <Play size={12} />
            )}
            Back Up
          </Button>
          <button
            type="button"
            onClick={() => onSelect(summary.vmName)}
            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`View backup history for ${summary.vmName}`}
          >
            <ChevronLeft size={14} className="rotate-180" />
          </button>
        </div>
      </div>
      {scheduleOpen && (
        <ScheduleDialog
          vmName={summary.vmName}
          existing={summary.schedule}
          onClose={() => setScheduleOpen(false)}
        />
      )}
    </>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-border py-16 text-center">
      <HardDrive size={28} className="mx-auto mb-3 text-muted-foreground/40" />
      <p className="text-sm font-medium text-muted-foreground">No virtual machines</p>
      <p className="mt-1 text-xs text-muted-foreground/60">
        Create a VM first, then use "Back Up" to create a backup.
      </p>
    </div>
  );
}

// ─── Per-VM panel ─────────────────────────────────────────────────────────────

function VmBackupsPanel({ vmName, onBack }: { vmName: string; onBack: () => void }) {
  const { data, isLoading } = useVmBackups(vmName);
  const createBackup = useCreateBackup(vmName);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BackupEntry | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupEntry | null>(null);

  function handleBackupNow() {
    toast.promise(createBackup.mutateAsync(), {
      loading: 'Creating backup…',
      success: 'Backup created',
      error: (e) => `Backup failed: ${String(e.response?.data?.error ?? e.message)}`,
    });
  }

  const backups = data?.backups ?? [];
  const schedule = data?.schedule ?? null;

  return (
    <Layout
      title={vmName}
      subtitle="Backups"
      actions={
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ChevronLeft size={14} className="mr-1" /> All VMs
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setScheduleOpen(true)}>
            <CalendarClock size={14} className="mr-1.5" />
            {schedule ? 'Edit Schedule' : 'Set Schedule'}
          </Button>
          <Button size="sm" onClick={handleBackupNow} disabled={createBackup.isPending}>
            {createBackup.isPending ? (
              <span className="flex items-center gap-1.5"><Clock size={13} className="animate-spin" /> Backing up…</span>
            ) : (
              <span className="flex items-center gap-1.5"><Play size={13} /> Back Up Now</span>
            )}
          </Button>
        </div>
      }
    >
      {schedule && <ScheduleBanner schedule={schedule} vmName={vmName} />}

      <div className="mt-4 space-y-2">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)
        ) : backups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-12 text-center">
            <HardDrive size={24} className="mx-auto mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No backups for this VM</p>
          </div>
        ) : (
          backups.map((b) => (
            <BackupRow
              key={b.id}
              backup={b}
              onDelete={() => setDeleteTarget(b)}
              onRestore={() => setRestoreTarget(b)}
            />
          ))
        )}
      </div>

      {scheduleOpen && (
        <ScheduleDialog
          vmName={vmName}
          existing={schedule}
          onClose={() => setScheduleOpen(false)}
        />
      )}

      {deleteTarget && (
        <DeleteBackupDialog
          backup={deleteTarget}
          vmName={vmName}
          onClose={() => setDeleteTarget(null)}
        />
      )}

      {restoreTarget && (
        <RestoreDialog
          backup={restoreTarget}
          vmName={vmName}
          onClose={() => setRestoreTarget(null)}
        />
      )}
    </Layout>
  );
}

// ─── Schedule banner ──────────────────────────────────────────────────────────

function ScheduleBanner({ schedule, vmName }: { schedule: BackupSchedule; vmName: string }) {
  // Fix 13: Confirm before deleting a schedule
  const [confirmOpen, setConfirmOpen] = useState(false);
  const deleteSchedule = useDeleteSchedule(vmName);

  function handleConfirmDelete() {
    toast.promise(deleteSchedule.mutateAsync().then(() => setConfirmOpen(false)), {
      loading: 'Removing schedule…',
      success: 'Schedule removed',
      error: 'Failed to remove schedule',
    });
  }

  return (
    <>
      <div className="flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
        <CalendarClock size={15} className="shrink-0 text-primary" />
        <div className="flex-1 text-sm">
          <span className="font-medium text-foreground">{frequencyLabel(schedule.frequency)} backups</span>
          {schedule.nextRunAt && (
            <span className="ml-2 text-muted-foreground">· Next: {formatDate(schedule.nextRunAt)}</span>
          )}
          {schedule.retentionDays != null && (
            <span className="ml-2 text-muted-foreground">· Keep {schedule.retentionDays} days</span>
          )}
        </div>
        {!schedule.enabled && (
          <span className="inline-flex items-center rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">Paused</span>
        )}
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          className="rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
          aria-label="Remove schedule"
        >
          <Trash2 size={13} />
        </button>
      </div>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Remove Schedule"
        description="This will stop future automatic backups for this VM."
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleConfirmDelete}
              disabled={deleteSchedule.isPending}
            >
              Remove Schedule
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          Remove the <span className="font-medium text-foreground">{frequencyLabel(schedule.frequency).toLowerCase()}</span> backup
          schedule? Existing backups will not be deleted.
        </p>
      </Dialog>
    </>
  );
}

// ─── Backup row ───────────────────────────────────────────────────────────────

function BackupRow({
  backup,
  onDelete,
  onRestore,
}: {
  backup: BackupEntry;
  onDelete: () => void;
  onRestore: () => void;
}) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50">
        {backup.consistent ? (
          <Check size={14} className="text-emerald-400" />
        ) : (
          <ShieldAlert size={14} className="text-amber-400" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-foreground">{formatDate(backup.createdAt)}</p>
          {!backup.consistent && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-400">
              <ShieldAlert size={9} />
              No guest agent
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {formatBytes(backup.sizeBytes)} · {backup.disks.length} disk{backup.disks.length !== 1 ? 's' : ''}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        {backup.triggerType === 'scheduled' && backup.scheduleFrequency && (
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
            <CalendarClock size={9} />
            {frequencyLabel(backup.scheduleFrequency)}
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={onRestore} className="h-7 gap-1 px-2 text-xs">
          <ArchiveRestore size={12} /> Restore
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete} className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive">
          <Trash2 size={13} />
        </Button>
      </div>
    </div>
  );
}

// ─── Schedule dialog ──────────────────────────────────────────────────────────

function ScheduleDialog({
  vmName,
  existing,
  onClose,
}: {
  vmName: string;
  existing: BackupSchedule | null;
  onClose: () => void;
}) {
  const saveSchedule = useSaveSchedule(vmName);
  const [frequency, setFrequency] = useState<BackupFrequency>(existing?.frequency ?? 'daily');
  const [hour, setHour] = useState(String(existing?.hour ?? 2));
  const [minute, setMinute] = useState(String(existing?.minute ?? 0).padStart(2, '0'));
  const [dayOfWeek, setDayOfWeek] = useState(String(existing?.dayOfWeek ?? 1));
  const [dayOfMonth, setDayOfMonth] = useState(String(existing?.dayOfMonth ?? 1));
  const [retentionDays, setRetentionDays] = useState(
    existing?.retentionDays != null ? String(existing.retentionDays) : ''
  );

  function handleSave() {
    toast.promise(
      saveSchedule.mutateAsync({
        frequency,
        hour: parseInt(hour),
        minute: parseInt(minute),
        dayOfWeek: parseInt(dayOfWeek),
        dayOfMonth: parseInt(dayOfMonth),
        retentionDays: retentionDays === '' ? null : parseInt(retentionDays),
        enabled: true,
      }).then(onClose),
      { loading: 'Saving schedule…', success: 'Schedule saved', error: 'Failed to save schedule' }
    );
  }

  const DAY_OPTIONS = [
    { value: '1', label: 'Monday' }, { value: '2', label: 'Tuesday' },
    { value: '3', label: 'Wednesday' }, { value: '4', label: 'Thursday' },
    { value: '5', label: 'Friday' }, { value: '6', label: 'Saturday' },
    { value: '0', label: 'Sunday' },
  ];

  return (
    <Dialog
      open
      onClose={onClose}
      title={existing ? 'Edit Backup Schedule' : 'Set Backup Schedule'}
      description={`Automated backups for ${vmName}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={saveSchedule.isPending}>Save Schedule</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Frequency</label>
          <Select value={frequency} onChange={(e) => setFrequency(e.target.value as BackupFrequency)}>
            <option value="hourly">Hourly</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </Select>
        </div>

        {frequency !== 'hourly' && (
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Hour (0–23)</label>
              <Input type="number" min={0} max={23} value={hour} onChange={(e) => setHour(e.target.value)} />
            </div>
            <div className="flex-1">
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Minute</label>
              <Input type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(e.target.value)} />
            </div>
          </div>
        )}

        {frequency === 'hourly' && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Minute past the hour</label>
            <Input type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(e.target.value)} />
          </div>
        )}

        {frequency === 'weekly' && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Day of week</label>
            <Select value={dayOfWeek} onChange={(e) => setDayOfWeek(e.target.value)}>
              {DAY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </div>
        )}

        {frequency === 'monthly' && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Day of month (1–28)</label>
            <Input type="number" min={1} max={28} value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} />
          </div>
        )}

        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Retention (days) <span className="text-muted-foreground/60">— leave blank to use global default</span>
          </label>
          <Input
            type="number"
            min={0}
            placeholder="Use global default"
            value={retentionDays}
            onChange={(e) => setRetentionDays(e.target.value)}
          />
        </div>
      </div>
    </Dialog>
  );
}

// ─── Delete dialog ────────────────────────────────────────────────────────────

function DeleteBackupDialog({
  backup,
  vmName,
  onClose,
}: {
  backup: BackupEntry;
  vmName: string;
  onClose: () => void;
}) {
  const deleteBackup = useDeleteBackup(vmName);

  function handleDelete() {
    toast.promise(
      deleteBackup.mutateAsync(backup.id).then(onClose),
      { loading: 'Deleting backup…', success: 'Backup deleted', error: 'Failed to delete backup' }
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Delete Backup"
      description="This cannot be undone."
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={handleDelete} disabled={deleteBackup.isPending}>
            Delete
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        Delete backup from <span className="font-medium text-foreground">{formatDate(backup.createdAt)}</span>?
        ({formatBytes(backup.sizeBytes)})
      </p>
    </Dialog>
  );
}

// ─── Restore dialog ───────────────────────────────────────────────────────────

function RestoreDialog({
  backup,
  vmName,
  onClose,
}: {
  backup: BackupEntry;
  vmName: string;
  onClose: () => void;
}) {
  const restoreBackup = useRestoreBackup(vmName);
  const [newVmName, setNewVmName] = useState('');
  const [mode, setMode] = useState<'overwrite' | 'new'>('overwrite');

  function handleRestore() {
    const targetName = mode === 'new' ? newVmName.trim() : undefined;
    if (mode === 'new' && !targetName) return;
    toast.promise(
      restoreBackup.mutateAsync({ backupId: backup.id, newVmName: targetName }).then(onClose),
      {
        loading: 'Restoring…',
        success: 'Restore complete — VM disks replaced',
        error: (e) => `Restore failed: ${String(e.response?.data?.error ?? e.message)}`,
      }
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Restore Backup"
      description={`Backup from ${formatDate(backup.createdAt)}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            size="sm"
            onClick={handleRestore}
            disabled={restoreBackup.isPending || (mode === 'new' && !newVmName.trim())}
          >
            <Zap size={13} className="mr-1.5" /> Restore
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Restoring will overwrite the VM's current disk(s). The VM must be{' '}
          <strong className="text-foreground">stopped</strong> before restoring — the server will
          reject the request if it is running.
        </p>

        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border p-3 transition-colors hover:bg-muted/30">
            <input
              type="radio"
              name="restore-mode"
              checked={mode === 'overwrite'}
              onChange={() => setMode('overwrite')}
              className="accent-primary"
            />
            <div>
              <p className="text-sm font-medium">Overwrite existing VM</p>
              <p className="text-xs text-muted-foreground">Replace disks of <strong>{vmName}</strong></p>
            </div>
          </label>
          <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border p-3 transition-colors hover:bg-muted/30">
            <input
              type="radio"
              name="restore-mode"
              checked={mode === 'new'}
              onChange={() => setMode('new')}
              className="accent-primary"
            />
            <div className="flex-1">
              <p className="text-sm font-medium">Restore as new VM</p>
              <p className="text-xs text-muted-foreground">Copy disks to a new VM directory</p>
            </div>
          </label>
        </div>

        {mode === 'new' && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">New VM name</label>
            <Input
              value={newVmName}
              onChange={(e) => setNewVmName(e.target.value)}
              placeholder={`${vmName}-restored`}
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}
