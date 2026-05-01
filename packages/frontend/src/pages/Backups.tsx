import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  CalendarClock,
  Check,
  Clock,
  Database,
  HardDrive,
  Info,
  Play,
  Power,
  Server,
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
import { cn } from '@/lib/cn';
import type { BackupConsistency, BackupEntry, BackupFrequency, BackupSchedule, BackupVmSummary } from '@/types';

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

// ─── Page router ──────────────────────────────────────────────────────────────

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

// ─── Main list ────────────────────────────────────────────────────────────────

const LIST_COLS = 'minmax(0,1fr) 90px 110px 150px 130px 186px';

function BackupsList({ onSelect }: { onSelect: (name: string) => void }) {
  const { data: summaries, isLoading: summariesLoading } = useBackupSummaries();
  const { data: vms, isLoading: vmsLoading } = useVms();

  const isLoading = summariesLoading || vmsLoading;

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

  const totalBackups = rows.reduce((n, r) => n + r.backupCount, 0);
  const totalSize = rows.reduce((n, r) => n + r.totalSizeBytes, 0);
  const withBackups = rows.filter((r) => r.backupCount > 0).length;
  const scheduled = rows.filter((r) => r.schedule?.enabled).length;

  return (
    <Layout title="Backups" subtitle="Manage VM backups and schedules">
      <div className="space-y-6 animate-slide-up">

        {/* Stats */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard icon={Server} label="Virtual Machines" value={String(vms?.length ?? '—')} iconClass="bg-blue-500/10 text-blue-500" />
          <StatCard icon={HardDrive} label="VMs Backed Up" value={isLoading ? '—' : String(withBackups)} iconClass="bg-emerald-500/10 text-emerald-500" />
          <StatCard icon={Archive} label="Total Backups" value={isLoading ? '—' : String(totalBackups)} iconClass="bg-violet-500/10 text-violet-500" />
          <StatCard icon={Database} label="Storage Used" value={isLoading ? '—' : formatBytes(totalSize)} iconClass="bg-amber-500/10 text-amber-500" />
        </div>

        {/* Info panel */}
        <BackupInfoPanel />

        {/* Table */}
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div
            className="grid items-center gap-4 border-b border-border bg-muted/40 px-5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
            style={{ gridTemplateColumns: LIST_COLS }}
          >
            <span>Virtual Machine</span>
            <span>Backups</span>
            <span>Size</span>
            <span>Last Backup</span>
            <span>Schedule</span>
            <span className="text-right">Actions</span>
          </div>

          {isLoading ? (
            <div className="space-y-px p-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-[60px] rounded-xl" />)}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="divide-y divide-border/60">
              {rows.map((s, i) => (
                <SummaryRow key={s.vmName} summary={s} onSelect={onSelect} index={i} />
              ))}
            </div>
          )}

          {!isLoading && rows.length > 0 && scheduled > 0 && (
            <div className="border-t border-border/60 bg-muted/20 px-5 py-2">
              <p className="text-[11px] text-muted-foreground">
                {scheduled} VM{scheduled !== 1 ? 's' : ''} with active schedule
              </p>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  iconClass,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  iconClass: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', iconClass)}>
          <Icon size={15} />
        </div>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</p>
          <p className="mt-0.5 text-xl font-bold tabular-nums leading-tight text-foreground">{value}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Info panel ───────────────────────────────────────────────────────────────

function BackupInfoPanel() {
  const [open, setOpen] = useState(false);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-5 py-3 text-left transition-colors hover:bg-muted/30"
      >
        <Info size={13} className="shrink-0 text-muted-foreground" />
        <span className="flex-1 text-xs font-medium text-muted-foreground">Understanding backup states</span>
        <span className={cn('text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 transition-opacity', open ? 'opacity-0' : 'opacity-100')}>
          Click to expand
        </span>
      </button>

      {open && (
        <div className="border-t border-border/60 bg-muted/20 px-5 pb-5 pt-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <InfoStateCard
              icon={<Check size={13} className="text-emerald-400" />}
              iconBg="bg-emerald-500/10"
              title="App-consistent"
              body="Filesystems were frozen via the QEMU guest agent before copying. All writes were flushed — safe to restore any application or database without extra checks."
            />
            <InfoStateCard
              icon={<Power size={13} className="text-muted-foreground" />}
              iconBg="bg-muted"
              title="VM offline"
              body="The VM was powered off when the backup ran. The disk was idle with no writes in flight — always safe to restore, no guest agent needed."
            />
            <InfoStateCard
              icon={<ShieldAlert size={13} className="text-amber-400" />}
              iconBg="bg-amber-500/10"
              title="No guest agent"
              badge={
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-px text-[10px] font-semibold text-amber-400">
                  <ShieldAlert size={8} />No guest agent
                </span>
              }
              body={
                <>
                  VM was running without a guest agent — filesystems were not frozen.
                  Databases or apps with open transactions may need{' '}
                  <code className="rounded bg-muted px-1 font-mono text-[11px]">fsck</code> or{' '}
                  <code className="rounded bg-muted px-1 font-mono text-[11px]">mysqlcheck</code> after
                  restore. Install{' '}
                  <code className="rounded bg-muted px-1 font-mono text-[11px]">qemu-guest-agent</code>{' '}
                  inside the VM to fix this.
                </>
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}

function InfoStateCard({
  icon,
  iconBg,
  title,
  badge,
  body,
}: {
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  badge?: React.ReactNode;
  body: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', iconBg)}>
        {icon}
      </div>
      <div>
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="text-xs font-semibold text-foreground">{title}</p>
          {badge}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

// ─── Summary row ──────────────────────────────────────────────────────────────

function SummaryRow({
  summary,
  onSelect,
  index,
}: {
  summary: BackupVmSummary;
  onSelect: (v: string) => void;
  index: number;
}) {
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
      <div
        className="grid items-center gap-4 px-5 py-3.5 transition-colors hover:bg-muted/40"
        style={{ gridTemplateColumns: LIST_COLS, animationDelay: `${index * 30}ms` }}
      >
        {/* Name */}
        <button
          type="button"
          onClick={() => onSelect(summary.vmName)}
          className="flex items-center gap-3 text-left"
        >
          <div className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors',
            summary.backupCount > 0 ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
          )}>
            <HardDrive size={14} />
          </div>
          <span className="font-medium text-foreground transition-colors hover:text-primary">
            {summary.vmName}
          </span>
        </button>

        {/* Count */}
        <span className={cn(
          'text-sm tabular-nums',
          summary.backupCount > 0 ? 'font-semibold text-foreground' : 'text-muted-foreground'
        )}>
          {summary.backupCount > 0 ? summary.backupCount : '—'}
        </span>

        {/* Size */}
        <span className="font-mono text-sm text-muted-foreground">
          {summary.totalSizeBytes > 0 ? formatBytes(summary.totalSizeBytes) : '—'}
        </span>

        {/* Last backup */}
        <span className="text-sm text-muted-foreground">
          {summary.lastBackupAt ? formatRelative(summary.lastBackupAt) : '—'}
        </span>

        {/* Schedule */}
        <span>
          {summary.schedule?.enabled ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
              <CalendarClock size={9} />
              {frequencyLabel(summary.schedule.frequency)}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground/50">None</span>
          )}
        </span>

        {/* Actions */}
        <div className="flex items-center justify-end gap-1.5">
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
            {createBackup.isPending
              ? <Clock size={12} className="animate-spin" />
              : <Play size={12} />}
            Back Up
          </Button>
          <button
            type="button"
            onClick={() => onSelect(summary.vmName)}
            className="ml-1 flex h-7 items-center gap-1 rounded px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`View backups for ${summary.vmName}`}
          >
            History →
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
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
        <Server className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="text-sm font-semibold text-foreground">No virtual machines</p>
      <p className="mt-1 text-xs text-muted-foreground">Create a VM first, then come back to set up backups.</p>
    </div>
  );
}

// ─── Per-VM panel ─────────────────────────────────────────────────────────────

const BACKUP_COLS = 'minmax(0,1fr) 90px 60px 170px 110px 80px';

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      error: (e: any) => `Backup failed: ${String(e.response?.data?.error ?? e.message)}`,
    });
  }

  const backups = data?.backups ?? [];
  const schedule = data?.schedule ?? null;
  const totalSize = backups.reduce((n, b) => n + b.sizeBytes, 0);
  const lastBackupAt = backups[0]?.createdAt ?? null;

  return (
    <Layout>
      <div className="space-y-6 animate-slide-up">

        {/* Breadcrumb */}
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft size={14} />
          Backups
        </button>

        {/* Hero */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <HardDrive className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground">{vmName}</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {isLoading ? 'Loading…' : `${backups.length} backup${backups.length !== 1 ? 's' : ''}${totalSize > 0 ? ` · ${formatBytes(totalSize)} total` : ''}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setScheduleOpen(true)}>
              <CalendarClock size={14} className="mr-1.5" />
              {schedule ? 'Edit Schedule' : 'Set Schedule'}
            </Button>
            <Button size="sm" onClick={handleBackupNow} disabled={createBackup.isPending}>
              {createBackup.isPending ? (
                <><Clock size={13} className="mr-1.5 animate-spin" />Backing up…</>
              ) : (
                <><Play size={13} className="mr-1.5" />Back Up Now</>
              )}
            </Button>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard icon={Archive} label="Backups" value={isLoading ? '—' : String(backups.length)} iconClass="bg-primary/10 text-primary" />
          <StatCard icon={Database} label="Total Size" value={isLoading ? '—' : (totalSize > 0 ? formatBytes(totalSize) : '—')} iconClass="bg-violet-500/10 text-violet-500" />
          <StatCard icon={Clock} label="Last Backup" value={isLoading ? '—' : (lastBackupAt ? formatRelative(lastBackupAt) : 'Never')} iconClass="bg-blue-500/10 text-blue-500" />
          <StatCard
            icon={CalendarClock}
            label="Next Scheduled"
            value={schedule?.enabled && schedule.nextRunAt ? formatRelative(schedule.nextRunAt).replace('ago', '').trim() || 'Soon' : '—'}
            iconClass={schedule?.enabled ? 'bg-emerald-500/10 text-emerald-500' : 'bg-muted text-muted-foreground'}
          />
        </div>

        {/* Schedule banner */}
        {schedule && <ScheduleBanner schedule={schedule} vmName={vmName} onEdit={() => setScheduleOpen(true)} />}

        {/* Backup table */}
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div
            className="grid items-center gap-4 border-b border-border bg-muted/40 px-5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
            style={{ gridTemplateColumns: BACKUP_COLS }}
          >
            <span>Date</span>
            <span>Size</span>
            <span>Disks</span>
            <span>State</span>
            <span>Trigger</span>
            <span className="text-right">Actions</span>
          </div>

          {isLoading ? (
            <div className="space-y-px p-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-[56px] rounded-xl" />)}
            </div>
          ) : backups.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-muted">
                <HardDrive className="h-4.5 w-4.5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-muted-foreground">No backups yet</p>
              <p className="mt-1 text-xs text-muted-foreground/60">Click "Back Up Now" to create the first backup.</p>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {backups.map((b, i) => (
                <BackupRow
                  key={b.id}
                  backup={b}
                  index={i}
                  onDelete={() => setDeleteTarget(b)}
                  onRestore={() => setRestoreTarget(b)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {scheduleOpen && (
        <ScheduleDialog vmName={vmName} existing={schedule} onClose={() => setScheduleOpen(false)} />
      )}
      {deleteTarget && (
        <DeleteBackupDialog backup={deleteTarget} vmName={vmName} onClose={() => setDeleteTarget(null)} />
      )}
      {restoreTarget && (
        <RestoreDialog backup={restoreTarget} vmName={vmName} onClose={() => setRestoreTarget(null)} />
      )}
    </Layout>
  );
}

// ─── Schedule banner ──────────────────────────────────────────────────────────

function ScheduleBanner({
  schedule,
  vmName,
  onEdit,
}: {
  schedule: BackupSchedule;
  vmName: string;
  onEdit: () => void;
}) {
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
      <div className="flex items-center gap-4 rounded-xl border border-primary/20 bg-primary/5 px-5 py-3.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <CalendarClock size={14} className="text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">
            {frequencyLabel(schedule.frequency)} backups
            {!schedule.enabled && (
              <span className="ml-2 inline-flex items-center rounded-full border border-border bg-muted/50 px-2 py-px text-[10px] font-semibold text-muted-foreground">
                Paused
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {schedule.nextRunAt && `Next run: ${formatDate(schedule.nextRunAt)}`}
            {schedule.retentionDays != null && ` · Keep ${schedule.retentionDays} days`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" className="h-7 px-2.5 text-xs" onClick={onEdit}>
            Edit
          </Button>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:text-destructive"
            aria-label="Remove schedule"
          >
            <Trash2 size={13} />
          </button>
        </div>
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
            <Button variant="danger" size="sm" onClick={handleConfirmDelete} disabled={deleteSchedule.isPending}>
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

const consistencyConfig: Record<BackupConsistency, {
  icon: React.ReactNode;
  label: string;
  badge?: React.ReactNode;
}> = {
  'app-consistent': {
    icon: <Check size={12} className="text-emerald-400" />,
    label: 'App-consistent',
  },
  'offline': {
    icon: <Power size={12} className="text-muted-foreground" />,
    label: 'VM offline',
  },
  'crash-consistent': {
    icon: <ShieldAlert size={12} className="text-amber-400" />,
    label: 'No guest agent',
    badge: (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-px text-[10px] font-semibold text-amber-400">
        <ShieldAlert size={8} />No guest agent
      </span>
    ),
  },
};

function BackupRow({
  backup,
  index,
  onDelete,
  onRestore,
}: {
  backup: BackupEntry;
  index: number;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const cons = consistencyConfig[backup.consistency];

  return (
    <div
      className="grid items-center gap-4 px-5 py-3.5 transition-colors hover:bg-muted/40"
      style={{ gridTemplateColumns: BACKUP_COLS, animationDelay: `${index * 20}ms` }}
    >
      {/* Date */}
      <span className="text-sm font-medium text-foreground">{formatDate(backup.createdAt)}</span>

      {/* Size */}
      <span className="font-mono text-sm text-muted-foreground">{formatBytes(backup.sizeBytes)}</span>

      {/* Disks */}
      <span className="text-sm text-muted-foreground">
        {backup.disks.length}
      </span>

      {/* Consistency */}
      <div className="flex items-center gap-2">
        <div className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
          backup.consistency === 'app-consistent' && 'bg-emerald-500/10',
          backup.consistency === 'offline' && 'bg-muted',
          backup.consistency === 'crash-consistent' && 'bg-amber-500/10',
        )}>
          {cons.icon}
        </div>
        {cons.badge ?? (
          <span className={cn(
            'text-xs font-medium',
            backup.consistency === 'app-consistent' && 'text-emerald-400',
            backup.consistency === 'offline' && 'text-muted-foreground',
          )}>
            {cons.label}
          </span>
        )}
      </div>

      {/* Trigger */}
      <span>
        {backup.triggerType === 'scheduled' && backup.scheduleFrequency ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
            <CalendarClock size={9} />
            {frequencyLabel(backup.scheduleFrequency)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Manual</span>
        )}
      </span>

      {/* Actions */}
      <div className="flex items-center justify-end gap-1">
        <Button variant="ghost" size="sm" onClick={onRestore} className="h-7 gap-1 px-2 text-xs">
          <ArchiveRestore size={12} />Restore
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
          <Button variant="danger" size="sm" onClick={handleDelete} disabled={deleteBackup.isPending}>Delete</Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        Delete backup from <span className="font-medium text-foreground">{formatDate(backup.createdAt)}</span>?{' '}
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
        error: (e: any) => `Restore failed: ${String(e.response?.data?.error ?? e.message)}`,
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
            <Zap size={13} className="mr-1.5" />Restore
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Restoring will overwrite the VM's current disk(s). The VM must be{' '}
          <strong className="text-foreground">stopped</strong> before restoring.
        </p>

        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border p-3 transition-colors hover:bg-muted/30">
            <input type="radio" name="restore-mode" checked={mode === 'overwrite'} onChange={() => setMode('overwrite')} className="accent-primary" />
            <div>
              <p className="text-sm font-medium">Overwrite existing VM</p>
              <p className="text-xs text-muted-foreground">Replace disks of <strong>{vmName}</strong></p>
            </div>
          </label>
          <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border p-3 transition-colors hover:bg-muted/30">
            <input type="radio" name="restore-mode" checked={mode === 'new'} onChange={() => setMode('new')} className="accent-primary" />
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
