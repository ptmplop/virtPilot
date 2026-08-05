import { useRef, useState } from 'react';
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
  Layers,
  Play,
  Power,
  Server,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Link2,
  Unlink,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  useBackupSummaries,
  useVmBackups,
  useCreateBackup,
  useDeleteBackup,
  useRestoreBackup,
  useRestoreBackupAsNewVm,
  useVerifyBackup,
  useBackupAlerts,
  useSaveSchedule,
  useDeleteSchedule,
  useRunningBackups,
} from '@/hooks/useBackups';
import { Spinner } from '@/components/ui/Spinner';
import { StorageDirSelect } from '@/components/StorageDirSelect';
import { useVms } from '@/hooks/useVms';
import { cn } from '@/lib/cn';
import type {
  BackupConsistency,
  BackupEntry,
  BackupFrequency,
  BackupInProgress,
  BackupKindRequest,
  BackupSchedule,
  BackupScheduleMode,
  BackupVmSummary,
  IncrementalStatus,
} from '@/types';

// ─── Backup health banner ─────────────────────────────────────────────────────

// A backup that has quietly stopped working is the failure that actually costs
// you something, and until now the only trace of a failed scheduled run was a
// line in journalctl.
function BackupAlertsBanner() {
  const { data: alerts = [] } = useBackupAlerts();
  if (alerts.length === 0) return null;
  const errors = alerts.filter((a) => a.severity === 'error');
  const tone = errors.length > 0 ? 'destructive' : 'amber';

  return (
    <div className={cn(
      'space-y-2 rounded-xl border px-5 py-4',
      tone === 'destructive' ? 'border-destructive/30 bg-destructive/5' : 'border-amber-500/30 bg-amber-500/5',
    )}>
      <div className="flex items-center gap-2.5">
        <ShieldAlert size={15} className={tone === 'destructive' ? 'text-destructive' : 'text-amber-400'} />
        <p className="text-sm font-semibold text-foreground">
          {alerts.length} backup {alerts.length === 1 ? 'problem' : 'problems'} need attention
        </p>
      </div>
      <ul className="space-y-1 pl-[26px]">
        {alerts.map((a, i) => (
          <li key={`${a.vmUuid}-${a.kind}-${i}`} className="text-xs leading-relaxed text-muted-foreground">
            <span className="font-mono font-semibold text-foreground">{a.vmName}</span>
            {' — '}{a.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

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

function apiError(e: unknown): string {
  const err = e as { response?: { data?: { error?: string } }; message?: string };
  return String(err.response?.data?.error ?? err.message ?? e);
}

// ─── Page router ──────────────────────────────────────────────────────────────

export function BackupsPage() {
  const { vmUuid: selectedVm } = useParams<{ vmUuid?: string }>();
  const navigate = useNavigate();

  if (selectedVm) {
    return (
      <VmBackupsPanel
        vmUuid={selectedVm}
        onBack={() => navigate('/backups', { replace: true })}
      />
    );
  }

  return <BackupsList onSelect={(uuid) => navigate(`/backups/${uuid}`, { replace: true })} />;
}

// ─── Main list ────────────────────────────────────────────────────────────────

const LIST_COLS = 'minmax(0,1fr) 90px 110px 150px 130px 186px';

function BackupsList({ onSelect }: { onSelect: (uuid: string) => void }) {
  const { data: summaries, isLoading: summariesLoading } = useBackupSummaries();
  const { data: vms, isLoading: vmsLoading } = useVms();
  const { data: runningBackups = [] } = useRunningBackups();

  const isLoading = summariesLoading || vmsLoading;
  const runningSet = new Set(runningBackups.map((r) => r.vmUuid));

  const summaryMap = new Map((summaries ?? []).map((s) => [s.vmUuid, s]));
  const liveRows: BackupVmSummary[] = (vms ?? []).map(
    (vm): BackupVmSummary =>
      summaryMap.get(vm.id) ?? {
        vmUuid: vm.id,
        vmName: vm.name,
        backupCount: 0,
        totalSizeBytes: 0,
        unusableSizeBytes: 0,
        unusableCount: 0,
        lastBackupAt: null,
        schedule: null,
        vmExists: true,
      }
  );

  // Deleting a VM doesn't remove its backup tree, so summaries can outlive the
  // VM. Listing only live VMs made that space invisible — and this page is the
  // only way to reclaim it — so orphans go at the bottom, counted in the tiles.
  const liveUuids = new Set((vms ?? []).map((vm) => vm.id));
  const orphanRows = (summaries ?? []).filter((s) => !liveUuids.has(s.vmUuid));
  const rows: BackupVmSummary[] = [...liveRows, ...orphanRows];

  const totalBackups = rows.reduce((n, r) => n + r.backupCount, 0);
  // Counts the directories no backup can use as well. They occupy the volume
  // just the same, and leaving them out meant this tile could report 40 GB
  // while the filesystem held 95 GB — with nothing in the product to explain
  // the difference. The alert banner names the shortfall.
  const totalSize = rows.reduce((n, r) => n + r.totalSizeBytes + r.unusableSizeBytes, 0);
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

        <BackupAlertsBanner />

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
                <SummaryRow key={s.vmUuid} summary={s} onSelect={onSelect} index={i} isRunning={runningSet.has(s.vmUuid)} />
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
  isRunning,
}: {
  summary: BackupVmSummary;
  onSelect: (v: string) => void;
  index: number;
  isRunning: boolean;
}) {
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const createBackup = useCreateBackup(summary.vmUuid, summary.vmName);
  const busy = isRunning || createBackup.isPending;
  // Backups left behind by a deleted VM. Nothing can be backed up or scheduled
  // against a VM that no longer exists, but History (and the deletes it offers)
  // has to stay reachable or the space can never be freed.
  const orphaned = summary.vmExists === false;

  // Honour the VM's own policy: a VM set up for incremental backups should get
  // an incremental from this button too, not silently a full one.
  const kind: BackupKindRequest = summary.schedule?.mode === 'incremental' ? 'auto' : 'full';

  function handleBackupNow() {
    toast.promise(createBackup.mutateAsync(kind), {
      loading: 'Creating backup…',
      success: (b) => `${b.kind === 'incremental' ? 'Incremental' : 'Full'} backup created`,
      error: (e) => `Backup failed: ${apiError(e)}`,
    });
  }

  return (
    <>
      <div
        className={cn('grid items-center gap-4 px-5 py-3.5 transition-colors', busy ? 'bg-muted/20' : 'hover:bg-muted/40')}
        style={{ gridTemplateColumns: LIST_COLS, animationDelay: `${index * 30}ms` }}
      >
        {/* Name */}
        <button
          type="button"
          onClick={() => onSelect(summary.vmUuid)}
          className="flex min-w-0 items-center gap-2.5 text-left"
        >
          <div className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors',
            summary.backupCount > 0 ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
          )}>
            {busy ? <Spinner className="h-3.5 w-3.5" /> : <HardDrive size={14} />}
          </div>
          <div className="min-w-0">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-mono text-sm font-semibold text-foreground transition-colors hover:text-primary">
                {summary.vmName}
              </span>
              {orphaned && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-px text-[10px] font-semibold text-amber-400">
                  <ShieldAlert size={8} />Orphaned
                </span>
              )}
            </span>
            {busy && (
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full w-2/5 animate-pulse rounded-full bg-primary" />
              </div>
            )}
          </div>
        </button>

        {/* Count */}
        <span className={cn(
          'font-mono text-sm',
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
          {busy ? 'Backing up…' : (summary.lastBackupAt ? formatRelative(summary.lastBackupAt) : '—')}
        </span>

        {/* Schedule */}
        <span>
          {summary.schedule?.enabled ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
              <CalendarClock size={9} />
              {frequencyLabel(summary.schedule.frequency)}
              {summary.schedule.mode === 'incremental' && <span className="opacity-70">· Inc</span>}
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
            disabled={orphaned}
          >
            <CalendarClock size={12} />
            {summary.schedule ? 'Schedule' : 'Set Schedule'}
          </Button>
          <Button
            size="sm"
            className="h-7 gap-1 px-2.5 text-xs"
            onClick={handleBackupNow}
            disabled={busy || orphaned}
          >
            {busy
              ? <Spinner className="h-3 w-3" />
              : <Play size={12} />}
            Back Up
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onSelect(summary.vmUuid)}
            className="ml-1 h-7 px-1.5 text-[11px]"
            aria-label={`View backups for ${summary.vmName}`}
          >
            History →
          </Button>
        </div>
      </div>

      {scheduleOpen && (
        <ScheduleDialog
          vmUuid={summary.vmUuid}
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

function VmBackupsPanel({ vmUuid, onBack }: { vmUuid: string; onBack: () => void }) {
  const { data, isLoading } = useVmBackups(vmUuid);
  const { data: runningBackups = [] } = useRunningBackups();
  // Friendly name comes from the backup summaries (live VM > most recent
  // manifest > schedule). Falls back to the UUID if no summary exists.
  const { data: summaries } = useBackupSummaries();
  const summary = summaries?.find((s) => s.vmUuid === vmUuid);
  const vmName = summary?.vmName ?? vmUuid;
  const createBackup = useCreateBackup(vmUuid, vmName);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [confirmFullOpen, setConfirmFullOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BackupEntry | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupEntry | null>(null);

  const runningEntry: BackupInProgress | undefined = runningBackups.find((r) => r.vmUuid === vmUuid);
  const busy = !!runningEntry || createBackup.isPending;

  function handleBackupNow(kind: BackupKindRequest) {
    toast.promise(createBackup.mutateAsync(kind), {
      loading: kind === 'full' ? 'Creating full backup…' : 'Creating incremental backup…',
      success: (b) => `${b.kind === 'incremental' ? 'Incremental' : 'Full'} backup created`,
      error: (e) => `Backup failed: ${apiError(e)}`,
    });
  }

  const backups = data?.backups ?? [];
  // Falls back to the summaries cache while the per-VM query is in flight.
  // ScheduleDialog snapshots `existing` at mount, so opening it during that
  // window used to build a blank form and then explicitly PUT its defaults —
  // silently downgrading an incremental schedule to "always full" (and losing
  // its frequency, time and retention) with a "Schedule saved" toast.
  const schedule = data?.schedule ?? summary?.schedule ?? null;
  // Latches on the first schedule seen — see the ScheduleDialog key below.
  const everSeenSchedule = useRef(false);
  if (schedule) everSeenSchedule.current = true;
  const incremental: IncrementalStatus = data?.incremental ?? { supported: false, chainLength: 0, canChain: false };
  const totalSize = backups.reduce((n, b) => n + b.sizeBytes, 0);
  const lastBackupAt = backups[0]?.createdAt ?? null;
  const unusableSize = summary?.unusableSizeBytes ?? 0;
  const unusableCount = summary?.unusableCount ?? 0;

  // Taking a full backup by hand on an incremental-mode VM leaves no
  // checkpoint, so the next scheduled run cannot chain onto it and takes a
  // full as well. Worth one confirmation rather than an unexplained extra full.
  const fullWouldEndChain = schedule?.mode === 'incremental' && incremental.canChain;

  const incrementalHint = !incremental.supported
    ? 'This host\'s libvirt/qemu cannot do incremental backups'
    : !incremental.canChain
      // Deliberately still enabled: the engine handles this case by taking a
      // full backup *and* recording the checkpoint the next run needs. The
      // button used to be disabled here, with a tooltip telling the operator to
      // take a full backup first — which never worked, because a full backup
      // taken from the button beside it records no checkpoint either.
      //
      // "if the VM is running" is not padding: a checkpoint can only be laid
      // down on a live domain, and this status carries no power state to
      // condition on, so promising one outright would be a promise the run
      // cannot keep for a stopped VM.
      ? 'No checkpoint to measure changes against yet — this run takes a full backup and, if the VM is running, records one so the next can be a true incremental'
      : 'Copy only the blocks that changed since the last backup';

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
            <Button variant="secondary" size="sm" onClick={() => setScheduleOpen(true)} disabled={isLoading}>
              <CalendarClock size={14} className="mr-1.5" />
              {schedule ? 'Edit Schedule' : 'Set Schedule'}
            </Button>
            <Tooltip label={incrementalHint}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleBackupNow('incremental')}
                disabled={busy || !incremental.supported}
              >
                <Layers size={13} className="mr-1.5" />
                Incremental
              </Button>
            </Tooltip>
            <Button
              size="sm"
              onClick={() => (fullWouldEndChain ? setConfirmFullOpen(true) : handleBackupNow('full'))}
              disabled={busy}
            >
              {busy ? (
                <><Spinner className="mr-1.5 h-3.5 w-3.5" />Backing up…</>
              ) : (
                <><Play size={13} className="mr-1.5" />Full Backup</>
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

        {/* Chain banner */}
        {incremental.chainLength > 0 && (
          <div className="flex items-center gap-4 rounded-xl border border-border bg-card px-5 py-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10">
              <Layers size={14} className="text-violet-400" />
            </div>
            <p className="flex-1 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">
                {incremental.chainLength} incremental{incremental.chainLength !== 1 ? 's' : ''}
              </span>{' '}
              currently sit on top of the most recent full backup. Restoring any of them rebuilds the whole chain
              automatically; the full backup underneath cannot be deleted while they exist.
            </p>
          </div>
        )}

        {/* Schedule banner */}
        {schedule && <ScheduleBanner schedule={schedule} vmUuid={vmUuid} onEdit={() => setScheduleOpen(true)} />}

        {/* Space held by directories no backup can use. Previously invisible:
            they are filtered out of every listing, so the disk they occupied
            never appeared in any total the product showed. */}
        {unusableCount > 0 && (
          <div className="flex items-center gap-4 rounded-xl border border-amber-500/25 bg-amber-500/5 px-5 py-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
              <ShieldAlert size={14} className="text-amber-400" />
            </div>
            <p className="flex-1 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">
                {unusableCount} backup director{unusableCount !== 1 ? 'ies' : 'y'} ({formatBytes(unusableSize)})
              </span>{' '}
              hold data no backup can use — left by a run that was interrupted, or by a manifest that has become
              unreadable. Interrupted runs are cleared automatically once they are a day old.
            </p>
          </div>
        )}

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
          ) : backups.length === 0 && !busy ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
                <HardDrive className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-semibold text-foreground">No backups yet</p>
              <p className="mt-1 text-xs text-muted-foreground">Click "Back Up Now" to create the first backup.</p>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {busy && <BackupInProgressRow triggerType={runningEntry?.triggerType ?? 'manual'} />}
              {backups.map((b, i) => (
                <BackupRow
                  key={b.id}
                  backup={b}
                  index={i}
                  vmUuid={vmUuid}
                  onDelete={() => setDeleteTarget(b)}
                  onRestore={() => setRestoreTarget(b)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {scheduleOpen && (
        // Keyed so a schedule arriving after the dialog opened remounts it with
        // the real values rather than leaving the form on its blank defaults.
        //
        // The key only ever advances: once a schedule has been seen it stays
        // 'loaded', so a refetch that transiently returns none — or the delete
        // button in the banner behind the dialog — cannot remount the form and
        // wipe what the operator has typed.
        <ScheduleDialog
          key={everSeenSchedule.current ? 'loaded' : 'new'}
          vmUuid={vmUuid}
          vmName={vmName}
          existing={schedule}
          incremental={incremental}
          onClose={() => setScheduleOpen(false)}
        />
      )}
      <Dialog
        open={confirmFullOpen}
        onClose={() => setConfirmFullOpen(false)}
        title="Take a full backup?"
        description="This VM is scheduled for incremental backups."
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmFullOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              onClick={() => { setConfirmFullOpen(false); handleBackupNow('full'); }}
            >
              Take Full Backup
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          A full backup taken by hand records no checkpoint, so the next scheduled run will have nothing to measure
          changes against and will take a full backup too. Existing backups are unaffected, and the chain resumes on
          the run after that.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          To take a backup now <em>and</em> keep the chain going, use <span className="font-medium text-foreground">Incremental</span> instead.
        </p>
      </Dialog>
      {deleteTarget && (
        <DeleteBackupDialog backup={deleteTarget} vmUuid={vmUuid} onClose={() => setDeleteTarget(null)} />
      )}
      {restoreTarget && (
        <RestoreDialog backup={restoreTarget} vmUuid={vmUuid} vmName={vmName} onClose={() => setRestoreTarget(null)} />
      )}
    </Layout>
  );
}

// ─── Schedule banner ──────────────────────────────────────────────────────────

function ScheduleBanner({
  schedule,
  vmUuid,
  onEdit,
}: {
  schedule: BackupSchedule;
  vmUuid: string;
  onEdit: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const deleteSchedule = useDeleteSchedule(vmUuid);

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
            {schedule.mode === 'incremental'
              ? ` · Incremental, full every ${schedule.fullEvery ?? 7}`
              : ' · Always full'}
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

// ─── In-progress row ─────────────────────────────────────────────────────────

function BackupInProgressRow({ triggerType }: { triggerType: 'manual' | 'scheduled' }) {
  return (
    <div
      className="grid items-center gap-4 bg-muted/20 px-5 py-3.5"
      style={{ gridTemplateColumns: BACKUP_COLS }}
    >
      {/* Date cell: spinner + label + progress bar */}
      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <Spinner className="h-3 w-3 shrink-0" />
          <span className="text-sm font-medium text-muted-foreground">Backing up…</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full w-2/5 animate-pulse rounded-full bg-primary" />
        </div>
      </div>
      {/* Size */}
      <span className="font-mono text-sm text-muted-foreground/40">—</span>
      {/* Disks */}
      <span />
      {/* State */}
      <span />
      {/* Trigger */}
      <span>
        {triggerType === 'scheduled' ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
            <CalendarClock size={9} />
            Scheduled
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Manual</span>
        )}
      </span>
      {/* Actions */}
      <span />
    </div>
  );
}

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
  vmUuid,
  onDelete,
  onRestore,
}: {
  backup: BackupEntry;
  index: number;
  vmUuid: string;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const cons = consistencyConfig[backup.consistency];
  const verify = useVerifyBackup(vmUuid);

  function handleVerify() {
    toast.promise(verify.mutateAsync(backup.id), {
      loading: 'Checking every image in the chain…',
      success: (r) => (r.ok ? `Verified — ${r.summary}` : `Verification FAILED — ${r.summary}`),
      error: (e) => `Could not verify: ${apiError(e)}`,
    });
  }

  return (
    <div
      className="grid items-center gap-4 px-5 py-3.5 transition-colors hover:bg-muted/40"
      style={{ gridTemplateColumns: BACKUP_COLS, animationDelay: `${index * 20}ms` }}
    >
      {/* Date + kind */}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{formatDate(backup.createdAt)}</span>
          {backup.kind === 'incremental' ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-1.5 py-px text-[10px] font-semibold text-violet-400">
              <Layers size={8} />Incremental
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full border border-border bg-muted/50 px-1.5 py-px text-[10px] font-semibold text-muted-foreground">
              Full
            </span>
          )}
          {/* Which backup carries a checkpoint is the difference between "the
              next run will be incremental" and "it will be another full", and
              nothing in the UI used to say. */}
          {backup.hasCheckpoint && (
            <Tooltip label="This backup recorded a checkpoint, so an incremental can be layered on top of it">
              <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/25 bg-violet-500/5 px-1.5 py-px text-[10px] font-semibold text-violet-400/90">
                <Link2 size={8} />Chainable
              </span>
            </Tooltip>
          )}
          {backup.chainBroken && (
            <span className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-1.5 py-px text-[10px] font-semibold text-destructive">
              <Unlink size={8} />Chain broken
            </span>
          )}
          {backup.lastVerify && (
            <Tooltip label={`${backup.lastVerify.summary} · checked ${formatRelative(backup.lastVerify.checkedAt)}`}>
              <span className={cn(
                'inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-semibold',
                backup.lastVerify.ok
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                  : 'border-destructive/30 bg-destructive/10 text-destructive',
              )}>
                <ShieldCheck size={8} />
                {backup.lastVerify.ok ? 'Verified' : 'Verify failed'}
              </span>
            </Tooltip>
          )}
        </div>
        {backup.chainBroken && (
          <p className="mt-1 text-[11px] leading-snug text-destructive">
            A backup this one builds on is missing — it can no longer be restored.
          </p>
        )}
        {!backup.chainBroken && backup.notes?.length ? (
          <p className="mt-1 text-[11px] leading-snug text-amber-400">{backup.notes.join(' ')}</p>
        ) : null}
      </div>

      {/* Size — for an incremental, its own delta plus what the full chain costs */}
      <span className="font-mono text-sm text-muted-foreground">
        {formatBytes(backup.sizeBytes)}
        {backup.kind === 'incremental' && backup.chainSizeBytes > backup.sizeBytes && (
          <span className="block text-[10px] text-muted-foreground/60">
            {formatBytes(backup.chainSizeBytes)} chain
          </span>
        )}
      </span>

      {/* Disks */}
      <span className="font-mono text-sm text-muted-foreground">
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
        <Tooltip label="Read every image this backup depends on and check it for corruption">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleVerify}
            disabled={verify.isPending}
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
            aria-label="Verify backup"
          >
            {verify.isPending ? <Spinner className="h-3 w-3" /> : <ShieldCheck size={13} />}
          </Button>
        </Tooltip>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRestore}
          disabled={backup.chainBroken}
          className="h-7 gap-1 px-2 text-xs"
        >
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
  vmUuid,
  vmName,
  existing,
  incremental,
  onClose,
}: {
  vmUuid: string;
  vmName: string;
  existing: BackupSchedule | null;
  /** Absent from the list page, which has no per-VM incremental status to hand. */
  incremental?: IncrementalStatus;
  onClose: () => void;
}) {
  const saveSchedule = useSaveSchedule(vmUuid);
  const [frequency, setFrequency] = useState<BackupFrequency>(existing?.frequency ?? 'daily');
  const [hour, setHour] = useState(String(existing?.hour ?? 2));
  const [minute, setMinute] = useState(String(existing?.minute ?? 0).padStart(2, '0'));
  const [dayOfWeek, setDayOfWeek] = useState(String(existing?.dayOfWeek ?? 1));
  const [dayOfMonth, setDayOfMonth] = useState(String(existing?.dayOfMonth ?? 1));
  const [retentionDays, setRetentionDays] = useState(
    existing?.retentionDays != null ? String(existing.retentionDays) : ''
  );
  const [mode, setMode] = useState<BackupScheduleMode>(existing?.mode ?? 'full');
  const [fullEvery, setFullEvery] = useState(String(existing?.fullEvery ?? 7));

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
        mode,
        fullEvery: parseInt(fullEvery) || 7,
      }).then(onClose),
      { loading: 'Saving schedule…', success: 'Schedule saved', error: (e) => `Failed to save schedule: ${apiError(e)}` }
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

        <div className="border-t border-border/60 pt-4">
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Backup type</label>
          <Select value={mode} onChange={(e) => setMode(e.target.value as BackupScheduleMode)}>
            <option value="full">Always full — a complete copy every run</option>
            <option value="incremental">Incremental — copy only what changed</option>
          </Select>
          {mode === 'incremental' && (
            <div className="mt-3 space-y-2">
              <Input
                label="Take a fresh full backup every"
                type="number"
                min={1}
                max={60}
                value={fullEvery}
                onChange={(e) => setFullEvery(e.target.value)}
              />
              <p className="text-[11px] leading-snug text-muted-foreground">
                Counted in backups, not days. Capping the chain keeps restores quick and limits how much a single
                damaged link can cost. A run that cannot produce an incremental — the VM was off, the host does not
                support it, or the previous run recorded no checkpoint — falls back to a full backup rather than
                being skipped.
              </p>
              {/* The one fallback cause that is near-certain the moment this
                  setting is saved. Leaving it out of the list above meant the
                  first run's warning looked like a fault rather than the
                  documented bootstrap. */}
              {/* Only where a bootstrap is what will actually happen. On a host
                  that cannot do incrementals at all, promising "everything
                  after it copies just what has changed" would be untrue. */}
              {incremental?.supported && !incremental.canChain && (
                <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
                  <span className="font-medium text-foreground">The first run will still be a full backup.</span>{' '}
                  Only a backup taken with this setting on records the checkpoint an incremental measures changes
                  against, so the first run lays one down and everything after it copies just what has changed.
                </p>
              )}
              {incremental && !incremental.supported && (
                <p className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
                  <span className="font-medium text-foreground">This host cannot take incremental backups.</span>{' '}
                  Its libvirt/qemu does not report backup support, so every run will fall back to a full backup.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// ─── Delete dialog ────────────────────────────────────────────────────────────

function DeleteBackupDialog({
  backup,
  vmUuid,
  onClose,
}: {
  backup: BackupEntry;
  vmUuid: string;
  onClose: () => void;
}) {
  const deleteBackup = useDeleteBackup(vmUuid);
  const [cascade, setCascade] = useState(false);

  function handleDelete() {
    toast.promise(
      deleteBackup.mutateAsync({ backupId: backup.id, cascade }).then(onClose),
      {
        loading: 'Deleting backup…',
        success: cascade ? 'Backup and its incrementals deleted' : 'Backup deleted',
        error: (e) => `Failed to delete backup: ${apiError(e)}`,
      }
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
          <Button
            variant="danger"
            size="sm"
            onClick={handleDelete}
            disabled={deleteBackup.isPending || (backup.hasDependents && !cascade)}
          >
            Delete
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Delete backup from <span className="font-medium text-foreground">{formatDate(backup.createdAt)}</span>?{' '}
          ({formatBytes(backup.sizeBytes)})
        </p>

        {/* Deleting a link mid-chain silently corrupts every incremental above
            it, so the destructive option has to be asked for explicitly. */}
        {backup.hasDependents && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
            <p className="text-xs text-amber-400">
              Later incremental backups are built on top of this one. Deleting it on its own would leave them
              unrestorable, so it is only possible together with them.
            </p>
            <label className="mt-2 flex items-start gap-2 text-xs text-foreground">
              <input
                type="checkbox"
                checked={cascade}
                onChange={(e) => setCascade(e.target.checked)}
                className="mt-0.5"
              />
              <span>Also delete every backup built on this one</span>
            </label>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ─── Restore dialog ───────────────────────────────────────────────────────────

type RestoreMode = 'overwrite' | 'new';

function RestoreDialog({
  backup,
  vmUuid,
  vmName,
  onClose,
}: {
  backup: BackupEntry;
  vmUuid: string;
  vmName: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const restoreBackup = useRestoreBackup(vmUuid);
  const restoreAsNew = useRestoreBackupAsNewVm(vmUuid);
  const [mode, setMode] = useState<RestoreMode>('overwrite');
  const [newName, setNewName] = useState(`${vmName}-restored`);
  const [storageDirId, setStorageDirId] = useState('');
  const [startAfter, setStartAfter] = useState(false);

  const pending = restoreBackup.isPending || restoreAsNew.isPending;

  function handleRestore() {
    if (mode === 'overwrite') {
      toast.promise(
        restoreBackup.mutateAsync({ backupId: backup.id }).then(onClose),
        {
          loading: 'Restoring…',
          success: 'Restore complete — VM disks replaced',
          error: (e) => `Restore failed: ${apiError(e)}`,
        }
      );
      return;
    }

    toast.promise(
      restoreAsNew
        .mutateAsync({
          backupId: backup.id,
          name: newName.trim(),
          storageDirId: storageDirId || undefined,
          start: startAfter,
        })
        .then((created) => {
          onClose();
          created.warnings.forEach((w) => toast.warning(w));
          navigate(`/vms/${created.uuid}`);
          return created;
        }),
      {
        loading: 'Rebuilding VM from backup…',
        success: (created) => `Created "${created.name}" from this backup`,
        error: (e) => `Restore failed: ${apiError(e)}`,
      }
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Restore Backup"
      description={`${backup.kind === 'incremental' ? 'Incremental backup' : 'Full backup'} from ${formatDate(backup.createdAt)}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            variant={mode === 'overwrite' ? 'danger' : 'primary'}
            size="sm"
            onClick={handleRestore}
            disabled={pending || (mode === 'new' && !newName.trim())}
          >
            <Zap size={13} className="mr-1.5" />
            {mode === 'overwrite' ? 'Overwrite' : 'Create VM'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <ModeCard
            active={mode === 'overwrite'}
            onClick={() => setMode('overwrite')}
            icon={<ArchiveRestore size={14} />}
            title="Roll back"
            body={`Replace ${vmName}'s disks`}
          />
          <ModeCard
            active={mode === 'new'}
            onClick={() => setMode('new')}
            icon={<Server size={14} />}
            title="New VM"
            body="Leave the original alone"
          />
        </div>

        {mode === 'overwrite' ? (
          <p className="text-sm text-muted-foreground">
            Restoring will overwrite <strong className="text-foreground">{vmName}</strong>'s current disk(s).
            The VM must be <strong className="text-foreground">stopped</strong> before restoring.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Builds a complete new machine from this backup — its own UUID, MAC addresses and IP. Works even if
              the original VM has been deleted.
            </p>
            <Input
              label="New VM name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="restored-vm"
            />
            <StorageDirSelect purpose="vmDisks" value={storageDirId} onChange={setStorageDirId} />
            <label className="flex items-center gap-2 text-xs text-foreground">
              <input type="checkbox" checked={startAfter} onChange={(e) => setStartAfter(e.target.checked)} />
              <span>Start the VM once it is created</span>
            </label>
            <p className="text-[11px] leading-snug text-muted-foreground">
              cloud-init runs again on first boot so the guest picks up the new hostname and network settings.
              Attached ISOs are carried over; the original's cloud-init seed is not.
            </p>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function ModeCard({
  active,
  onClick,
  icon,
  title,
  body,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-lg border px-3 py-2.5 text-left transition-colors',
        active ? 'border-primary bg-primary/10' : 'border-border bg-card hover:bg-muted/40',
      )}
    >
      <span className={cn('flex items-center gap-1.5 text-xs font-semibold', active ? 'text-primary' : 'text-foreground')}>
        {icon}
        {title}
      </span>
      <span className="mt-0.5 block text-[11px] text-muted-foreground">{body}</span>
    </button>
  );
}
