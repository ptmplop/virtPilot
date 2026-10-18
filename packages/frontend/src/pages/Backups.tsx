import { useLayoutEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArchiveRestore,
  ArrowLeft,
  CalendarClock,
  ChevronDown,
  Layers,
  Link2,
  Play,
  Server,
  ShieldCheck,
  Trash2,
  Unlink,
} from 'lucide-react';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { formatDateTime, formatBytes } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tooltip } from '@/components/ui/Tooltip';
import { Panel, Stat, StatStrip } from '@/components/ui/Panel';
import { StatusGlyph, WarnGlyph } from '@/components/ui/Badge';
import { VmLogo } from '@/components/ui/OsLogoPicker';
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
import { useLogoStore } from '@/store/logoStore';
import { osSlugFromImage } from '@/data/templateSets';
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

// ─── Shared chrome ────────────────────────────────────────────────────────────

// Callouts (DESIGN.md): attention is amber with the warning glyph, info is the quiet
// surface well. One shape for both, so a note never looks like a different component.
const CALLOUT_ATTENTION =
  'rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-amber-800 dark:text-amber-200';
const CALLOUT_INFO =
  'rounded-md border border-border bg-surface px-3.5 py-2.5 text-[12.5px] leading-relaxed text-muted-foreground';

// Row actions: ghost icon buttons; the destructive one only turns red on approach.
const ROW_ACTION =
  'flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50';
const ROW_ACTION_DANGER =
  'flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive';

// True while the element is narrower than `minWidth`. The tables use it to fall back
// to icon-only row actions rather than letting the actions scroll out of sight (a
// 1024px window with the sidebar open). Measured on the table itself, so collapsing
// the sidebar counts as much as resizing the window.
function useNarrow<T extends HTMLElement>(minWidth: number) {
  const ref = useRef<T>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setNarrow(el.clientWidth < minWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [minWidth]);
  return [ref, narrow] as const;
}

// Wraps an icon-only control in its tooltip; a control showing its own label needs none.
function withTip(label: string, show: boolean, node: React.ReactElement) {
  return show ? <Tooltip label={label}>{node}</Tooltip> : node;
}

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
      'rounded-md border px-4 py-3',
      tone === 'destructive'
        ? 'border-destructive/30 bg-destructive/[0.06]'
        : 'border-amber-500/30 bg-amber-500/[0.06]',
    )}>
      <p className={cn(
        'flex items-center gap-2 text-[13px] font-semibold',
        tone === 'destructive' ? 'text-red-800 dark:text-red-200' : 'text-amber-800 dark:text-amber-200',
      )}>
        {tone === 'destructive' ? <StatusGlyph status="crashed" size={9} /> : <WarnGlyph size={10} />}
        {alerts.length} backup {alerts.length === 1 ? 'problem needs' : 'problems need'} attention
      </p>
      <ul className="mt-1.5 space-y-1 pl-[19px]">
        {alerts.map((a, i) => (
          <li key={`${a.vmUuid}-${a.kind}-${i}`} className="text-[12.5px] leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">{a.vmName}</span>
            {' — '}{a.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// The app's one date-and-time format ("8 Oct 2026, 16:33").
const formatDate = formatDateTime;

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// A time still to come. formatRelative() measures the past: handed a future time its
// difference is negative, so it fell into the `mins < 1` branch and every upcoming run
// read "just now".
function formatUntil(iso: string): string {
  const mins = Math.floor((new Date(iso).getTime() - Date.now()) / 60_000);
  if (mins < 1) return 'Soon';
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  return `in ${Math.floor(hrs / 24)}d`;
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

// The actions column is sized to what it holds (Set schedule · Back up); the row itself
// opens the VM's history, so it needs no button of its own. Where the full set does not
// fit, the narrow set takes over with icon-only actions; below even that, the panel
// scrolls sideways rather than letting columns collide.
const LIST_COLS = 'minmax(0,1fr) 64px 84px 108px 124px 224px';
const LIST_COLS_NARROW = 'minmax(0,1fr) 56px 76px 96px 112px 76px';
const LIST_FULL_MIN = 892;

function BackupsList({ onSelect }: { onSelect: (uuid: string) => void }) {
  const { data: summaries, isLoading: summariesLoading } = useBackupSummaries();
  const { data: vms, isLoading: vmsLoading } = useVms();
  const { data: runningBackups = [] } = useRunningBackups();

  const isLoading = summariesLoading || vmsLoading;
  const runningSet = new Set(runningBackups.map((r) => r.vmUuid));
  const templateByVm = new Map((vms ?? []).map((vm) => [vm.id, vm.sourceTemplateFilename]));
  const [tableRef, narrow] = useNarrow<HTMLDivElement>(LIST_FULL_MIN);

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
    <Layout title="Backups" subtitle="VM backups and the schedules that create them.">
      <div className="space-y-6 animate-slide-up">

        {/* Readouts */}
        <StatStrip>
          <Stat label="Virtual machines" value={String(vms?.length ?? '—')} />
          <Stat label="VMs backed up" value={isLoading ? '—' : String(withBackups)} />
          <Stat label="Total backups" value={isLoading ? '—' : String(totalBackups)} />
          <Stat label="Storage used" value={isLoading ? '—' : formatBytes(totalSize)} />
        </StatStrip>

        <BackupAlertsBanner />

        {/* Info panel */}
        <BackupInfoPanel />

        {/* Table */}
        <Panel className="overflow-hidden">
          <div ref={tableRef} className="overflow-x-auto">
            <div className={narrow ? 'min-w-[624px]' : undefined}>
              <div
                className={cn('table-head grid items-center px-5 py-2.5', narrow ? 'gap-3' : 'gap-4')}
                style={{ gridTemplateColumns: narrow ? LIST_COLS_NARROW : LIST_COLS }}
              >
                <span>Virtual machine</span>
                <span className="text-right">Backups</span>
                <span className="text-right">Size</span>
                {/* A left-aligned column after a right-aligned figure needs air, or they read as one. */}
                <span className="pl-4">Last backup</span>
                <span>Schedule</span>
                <span className="text-right">Actions</span>
              </div>

              {!isLoading && rows.length > 0 && (
                <div className="divide-y divide-border">
                  {rows.map((s, i) => (
                    <SummaryRow
                      key={s.vmUuid}
                      summary={s}
                      templateFilename={templateByVm.get(s.vmUuid)}
                      onSelect={onSelect}
                      index={i}
                      isRunning={runningSet.has(s.vmUuid)}
                      narrow={narrow}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {isLoading && (
            <div className="space-y-2 p-4">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 rounded-md" />)}
            </div>
          )}

          {!isLoading && rows.length === 0 && <EmptyState />}

          {!isLoading && rows.length > 0 && scheduled > 0 && (
            <div className="border-t border-border bg-surface/60 px-5 py-2.5">
              <p className="text-[12px] text-muted-foreground">
                {scheduled} VM{scheduled !== 1 ? 's' : ''} with active schedule
              </p>
            </div>
          )}
        </Panel>
      </div>
    </Layout>
  );
}

// ─── Info panel ───────────────────────────────────────────────────────────────

function BackupInfoPanel() {
  const [open, setOpen] = useState(false);

  return (
    <Panel className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2.5 px-5 py-3 text-left transition-colors hover:bg-surface/70 focus-visible:outline-offset-[-2px]"
      >
        <ChevronDown
          size={14}
          className={cn(
            'shrink-0 text-muted-foreground transition-transform duration-200 group-hover:text-foreground',
            !open && '-rotate-90',
          )}
        />
        <span className="flex-1 text-[13px] font-medium text-foreground">Understanding backup states</span>
      </button>

      {open && (
        <div className="grid divide-y divide-border border-t border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <InfoStateCard
            glyph={<StatusGlyph status="running" size={8} />}
            title="App-consistent"
            body="Filesystems were frozen via the QEMU guest agent before copying. All writes were flushed — safe to restore any application or database without extra checks."
          />
          <InfoStateCard
            glyph={<StatusGlyph status="stopped" size={8} />}
            title="VM offline"
            body="The VM was powered off when the backup ran. The disk was idle with no writes in flight — always safe to restore, no guest agent needed."
          />
          <InfoStateCard
            glyph={<WarnGlyph size={9} />}
            title="No guest agent"
            body={
              <>
                VM was running without a guest agent — filesystems were not frozen.
                Databases or apps with open transactions may need{' '}
                <InlineCode>fsck</InlineCode> or{' '}
                <InlineCode>mysqlcheck</InlineCode> after
                restore. Install{' '}
                <InlineCode>qemu-guest-agent</InlineCode>{' '}
                inside the VM to fix this.
              </>
            }
          />
        </div>
      )}
    </Panel>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-[4px] bg-muted px-1 py-px font-mono text-[11.5px] text-foreground">{children}</code>
  );
}

// The glyphs are the ones each state wears in the backup table, so this legend
// reads straight across to the rows below it.
function InfoStateCard({
  glyph,
  title,
  body,
}: {
  glyph: React.ReactNode;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="px-5 py-4">
      <p className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
        {glyph}
        {title}
      </p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

// ─── Summary row ──────────────────────────────────────────────────────────────

function SummaryRow({
  summary,
  templateFilename,
  onSelect,
  index,
  isRunning,
  narrow,
}: {
  summary: BackupVmSummary;
  /** The live VM's source image, for its OS mark; absent for orphaned backups. */
  templateFilename?: string;
  onSelect: (v: string) => void;
  index: number;
  isRunning: boolean;
  /** The table is too narrow for labelled actions: show icon buttons. */
  narrow: boolean;
}) {
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const createBackup = useCreateBackup(summary.vmUuid, summary.vmName);
  const logoSlug = useLogoStore((s) => s.vms[summary.vmName]) ?? osSlugFromImage(templateFilename);
  const busy = isRunning || createBackup.isPending;
  // Backups left behind by a deleted VM. Nothing can be backed up or scheduled
  // against a VM that no longer exists, but History (and the deletes it offers)
  // has to stay reachable or the space can never be freed.
  const orphaned = summary.vmExists === false;

  // Honour the VM's own policy: a VM set up for incremental backups should get
  // an incremental from this button too, not silently a full one.
  const kind: BackupKindRequest = summary.schedule?.mode === 'incremental' ? 'auto' : 'full';
  const scheduleLabel = summary.schedule ? 'Schedule' : 'Set schedule';

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
        // The whole row opens the VM's history (the name's button is stretched over it);
        // the actions sit above that layer.
        className={cn('table-row relative grid items-center px-5 py-2.5 has-[button:focus-visible]:bg-surface/70', narrow ? 'gap-3' : 'gap-4', busy && 'bg-surface/70')}
        style={{ gridTemplateColumns: narrow ? LIST_COLS_NARROW : LIST_COLS, animationDelay: `${index * 30}ms` }}
      >
        {/* Name */}
        <button
          type="button"
          onClick={() => onSelect(summary.vmUuid)}
          className="group/name flex min-w-0 items-center gap-3 rounded-sm text-left after:absolute after:inset-0 after:content-['']"
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center">
            {busy ? <Spinner className="h-4 w-4" /> : <VmLogo slug={logoSlug} size={20} />}
          </span>
          <span className="flex min-w-0 items-center gap-2.5">
            <span
              className="truncate text-[13.5px] font-medium text-foreground transition-colors group-hover/name:text-primary"
              title={summary.vmName}
            >
              {summary.vmName}
              <span className="sr-only">: backup history</span>
            </span>
            {orphaned && (
              <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-amber-700 dark:text-amber-300">
                <WarnGlyph size={9} />
                Orphaned
              </span>
            )}
          </span>
        </button>

        {/* Count — an empty cell's dash stays in the sans face so every blank in the row matches */}
        <span className={cn(
          'text-right text-[13px] tabular-nums',
          summary.backupCount > 0 ? 'font-medium text-foreground' : 'text-muted-foreground'
        )}>
          {summary.backupCount > 0 ? summary.backupCount : '—'}
        </span>

        {/* Size */}
        <span className={cn(
          'text-right text-[13px] tabular-nums',
          summary.totalSizeBytes > 0 ? 'font-medium text-foreground' : 'text-muted-foreground'
        )}>
          {summary.totalSizeBytes > 0 ? formatBytes(summary.totalSizeBytes) : '—'}
        </span>

        {/* Last backup */}
        <span
          className="pl-4 text-[13px] text-muted-foreground"
          title={!busy && summary.lastBackupAt ? formatDate(summary.lastBackupAt) : undefined}
        >
          {busy ? 'Backing up…' : (summary.lastBackupAt ? formatRelative(summary.lastBackupAt) : '—')}
        </span>

        {/* Schedule */}
        <span className="min-w-0">
          {summary.schedule?.enabled ? (
            <span className="inline-flex max-w-full items-center gap-1.5 text-[13px] text-foreground">
              <CalendarClock size={13} className="shrink-0 text-muted-foreground" />
              <span className="truncate">
                {frequencyLabel(summary.schedule.frequency)}
                {summary.schedule.mode === 'incremental' && (
                  <span className="text-muted-foreground" title="Incremental"> · Inc</span>
                )}
              </span>
            </span>
          ) : summary.schedule ? (
            // A schedule exists but is switched off — say so, rather than "None".
            <span className="inline-flex items-center gap-1.5 text-[13px] text-amber-700 dark:text-amber-300">
              <StatusGlyph status="paused" size={7} />
              Paused
            </span>
          ) : (
            <span className="text-[13px] text-muted-foreground">None</span>
          )}
        </span>

        {/* Actions */}
        <div className={cn('relative z-10 flex items-center justify-end', narrow ? 'gap-1' : 'gap-1.5')}>
          {withTip(scheduleLabel, narrow,
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setScheduleOpen(true)}
              disabled={orphaned}
              aria-label={narrow ? scheduleLabel : undefined}
              className={narrow ? 'w-8 px-0' : undefined}
            >
              <CalendarClock size={narrow ? 14 : 13} />
              {!narrow && scheduleLabel}
            </Button>
          )}
          {withTip('Back up', narrow,
            // Secondary, like its neighbours: a column of solid ink buttons drowns the
            // table. Ink is kept for the one main action on a page.
            <Button
              variant="secondary"
              size="sm"
              onClick={handleBackupNow}
              disabled={busy || orphaned}
              aria-label={narrow ? 'Back up' : undefined}
              className={narrow ? 'w-8 px-0' : undefined}
            >
              {busy
                ? <Spinner className="h-3.5 w-3.5 text-current" />
                : <Play size={narrow ? 14 : 13} />}
              {!narrow && 'Back up'}
            </Button>
          )}
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
    <div className="px-6 py-12 text-center">
      <p className="text-[13.5px] font-medium text-foreground">No virtual machines</p>
      <p className="mt-1 text-[12.5px] text-muted-foreground">Create a VM first, then come back to set up backups.</p>
    </div>
  );
}

// ─── Per-VM panel ─────────────────────────────────────────────────────────────

// Actions hold Verify · Restore · Delete; at 80px they ran over the Trigger column.
const BACKUP_COLS = 'minmax(0,1fr) 92px 52px 136px 108px 160px';
const BACKUP_COLS_NARROW = 'minmax(0,1fr) 80px 44px 124px 92px 108px';
const BACKUP_FULL_MIN = 900;

function backupCols(narrow: boolean) {
  return narrow ? BACKUP_COLS_NARROW : BACKUP_COLS;
}

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
  const nextRunAt = schedule?.enabled ? schedule.nextRunAt : null;

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

  const emptyTable = !isLoading && backups.length === 0 && !busy;
  const [tableRef, narrow] = useNarrow<HTMLDivElement>(BACKUP_FULL_MIN);

  return (
    <Layout docTitle={`Backups of ${vmName}`}>
      <div className="space-y-6 animate-slide-up">

        {/* Breadcrumb */}
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-sm text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft size={14} />
          Backups
        </button>

        {/* Title + actions */}
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h1 className="truncate text-[26px] font-semibold leading-8 tracking-[-0.024em] text-foreground">{vmName}</h1>
            <p className="mt-1 text-[13.5px] text-muted-foreground">
              {isLoading ? 'Loading…' : `${backups.length} backup${backups.length !== 1 ? 's' : ''}${totalSize > 0 ? ` · ${formatBytes(totalSize)} total` : ''}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => setScheduleOpen(true)} disabled={isLoading}>
              <CalendarClock size={14} />
              {schedule ? 'Edit schedule' : 'Set schedule'}
            </Button>
            <Tooltip label={incrementalHint}>
              <Button
                variant="secondary"
                onClick={() => handleBackupNow('incremental')}
                disabled={busy || !incremental.supported}
              >
                <Layers size={14} />
                Incremental
              </Button>
            </Tooltip>
            <Button
              onClick={() => (fullWouldEndChain ? setConfirmFullOpen(true) : handleBackupNow('full'))}
              disabled={busy}
            >
              {busy ? (
                <><Spinner className="h-3.5 w-3.5 text-current" />Backing up…</>
              ) : (
                <><Play size={14} />Full backup</>
              )}
            </Button>
          </div>
        </div>

        {/* Readouts */}
        <StatStrip>
          <Stat label="Backups" value={isLoading ? '—' : String(backups.length)} />
          <Stat label="Total size" value={isLoading ? '—' : (totalSize > 0 ? formatBytes(totalSize) : '—')} />
          <Stat
            label="Last backup"
            value={isLoading ? '—' : (lastBackupAt ? formatRelative(lastBackupAt) : 'Never')}
            sub={!isLoading && lastBackupAt ? formatDate(lastBackupAt) : undefined}
            tone={!isLoading && !lastBackupAt ? 'muted' : undefined}
          />
          <Stat
            label="Next scheduled"
            value={nextRunAt ? formatUntil(nextRunAt) : '—'}
            sub={nextRunAt ? formatDate(nextRunAt) : undefined}
          />
        </StatStrip>

        {/* Chain banner */}
        {incremental.chainLength > 0 && (
          <div className={cn(CALLOUT_INFO, 'flex items-start gap-2.5')}>
            <Layers size={14} className="mt-[3px] shrink-0 text-muted-foreground" />
            <p>
              <span className="font-medium text-foreground">
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
          <div className={cn(CALLOUT_ATTENTION, 'flex items-start gap-2.5')}>
            <WarnGlyph size={10} className="mt-[5px]" />
            <p>
              <span className="font-semibold">
                {unusableCount} backup director{unusableCount !== 1 ? 'ies' : 'y'} ({formatBytes(unusableSize)})
              </span>{' '}
              hold data no backup can use — left by a run that was interrupted, or by a manifest that has become
              unreadable. Interrupted runs are cleared automatically once they are a day old.
            </p>
          </div>
        )}

        {/* Backup table */}
        <Panel className="overflow-hidden">
          <div ref={tableRef} className="overflow-x-auto">
            <div className={narrow ? 'min-w-[680px]' : undefined}>
              <div
                className={cn('table-head grid items-center px-5 py-2.5', narrow ? 'gap-3' : 'gap-4')}
                style={{ gridTemplateColumns: backupCols(narrow) }}
              >
                <span>Date</span>
                <span>Size</span>
                <span>Disks</span>
                <span>State</span>
                <span>Trigger</span>
                <span className="text-right">Actions</span>
              </div>

              {!isLoading && !emptyTable && (
                <div className="divide-y divide-border">
                  {busy && <BackupInProgressRow triggerType={runningEntry?.triggerType ?? 'manual'} narrow={narrow} />}
                  {backups.map((b, i) => (
                    <BackupRow
                      key={b.id}
                      backup={b}
                      index={i}
                      narrow={narrow}
                      vmUuid={vmUuid}
                      onDelete={() => setDeleteTarget(b)}
                      onRestore={() => setRestoreTarget(b)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {isLoading && (
            <div className="space-y-2 p-4">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 rounded-md" />)}
            </div>
          )}

          {emptyTable && (
            <div className="px-6 py-12 text-center">
              <p className="text-[13.5px] font-medium text-foreground">No backups yet</p>
              {/* Named the button that exists: there has never been a "Back Up Now" on this page. */}
              <p className="mt-1 text-[12.5px] text-muted-foreground">Click “Full backup” to create the first backup.</p>
            </div>
          )}
        </Panel>
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
              Take full backup
            </Button>
          </>
        }
      >
        <p className="text-[13.5px] leading-relaxed text-muted-foreground">
          A full backup taken by hand records no checkpoint, so the next scheduled run will have nothing to measure
          changes against and will take a full backup too. Existing backups are unaffected, and the chain resumes on
          the run after that.
        </p>
        <p className="mt-3 text-[13.5px] leading-relaxed text-muted-foreground">
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
      <Panel className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-3.5">
        <CalendarClock size={16} className="shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-3 text-[13.5px] font-semibold text-foreground">
            {frequencyLabel(schedule.frequency)} backups
            {!schedule.enabled && (
              <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-amber-700 dark:text-amber-300">
                <StatusGlyph status="paused" size={8} />
                Paused
              </span>
            )}
          </p>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            {schedule.nextRunAt && `Next run: ${formatDate(schedule.nextRunAt)}`}
            {schedule.retentionDays != null && ` · Keep ${schedule.retentionDays} days`}
            {schedule.mode === 'incremental'
              ? ` · Incremental, full every ${schedule.fullEvery ?? 7}`
              : ' · Always full'}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="secondary" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Tooltip label="Remove schedule">
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              className={ROW_ACTION_DANGER}
              aria-label="Remove schedule"
            >
              <Trash2 size={14} />
            </button>
          </Tooltip>
        </div>
      </Panel>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Remove schedule"
        description="This will stop future automatic backups for this VM."
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={handleConfirmDelete} disabled={deleteSchedule.isPending}>
              Remove schedule
            </Button>
          </>
        }
      >
        <p className="text-[13.5px] leading-relaxed text-muted-foreground">
          Remove the <span className="font-medium text-foreground">{frequencyLabel(schedule.frequency).toLowerCase()}</span> backup
          schedule? Existing backups will not be deleted.
        </p>
      </Dialog>
    </>
  );
}

// ─── In-progress row ─────────────────────────────────────────────────────────

function BackupInProgressRow({ triggerType, narrow }: { triggerType: 'manual' | 'scheduled'; narrow: boolean }) {
  return (
    <div
      className={cn('grid items-center bg-surface/70 px-5 py-3', narrow ? 'gap-3' : 'gap-4')}
      style={{ gridTemplateColumns: backupCols(narrow) }}
    >
      {/* Date cell */}
      <span className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
        <Spinner className="h-3.5 w-3.5 shrink-0" />
        Backing up…
      </span>
      {/* Size */}
      <span className="text-[12.5px] text-muted-foreground">—</span>
      {/* Disks */}
      <span />
      {/* State */}
      <span />
      {/* Trigger */}
      <span>
        {triggerType === 'scheduled' ? (
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-foreground">
            <CalendarClock size={13} className="shrink-0 text-muted-foreground" />
            Scheduled
          </span>
        ) : (
          <span className="text-[12.5px] text-muted-foreground">Manual</span>
        )}
      </span>
      {/* Actions */}
      <span />
    </div>
  );
}

// ─── Backup row ───────────────────────────────────────────────────────────────

// Each state wears the app's status-glyph language: a solid disc for a copy taken
// from a running guest with its filesystems frozen, an open ring for a VM that was
// off, the warning triangle where nothing was frozen.
const consistencyConfig: Record<BackupConsistency, {
  glyph: React.ReactNode;
  label: string;
  tone: string;
}> = {
  'app-consistent': {
    glyph: <StatusGlyph status="running" size={8} />,
    label: 'App-consistent',
    tone: 'text-emerald-700 dark:text-emerald-300',
  },
  'offline': {
    glyph: <StatusGlyph status="stopped" size={8} />,
    label: 'VM offline',
    tone: 'text-muted-foreground',
  },
  'crash-consistent': {
    glyph: <WarnGlyph size={9} />,
    label: 'No guest agent',
    tone: 'text-amber-700 dark:text-amber-300',
  },
};

function BackupRow({
  backup,
  index,
  narrow,
  vmUuid,
  onDelete,
  onRestore,
}: {
  backup: BackupEntry;
  index: number;
  /** The table is too narrow for a labelled Restore: show it as an icon button. */
  narrow: boolean;
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
      className={cn('table-row grid items-center px-5 py-2.5', narrow ? 'gap-3' : 'gap-4')}
      style={{ gridTemplateColumns: backupCols(narrow), animationDelay: `${index * 20}ms` }}
    >
      {/* Date + kind */}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-[13px] font-medium tabular-nums text-foreground">{formatDate(backup.createdAt)}</span>
          {backup.kind === 'incremental' ? (
            <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
              <Layers size={12} className="shrink-0" />
              Incremental
            </span>
          ) : (
            <span className="text-[12px] text-muted-foreground">Full</span>
          )}
          {/* Which backup carries a checkpoint is the difference between "the
              next run will be incremental" and "it will be another full", and
              nothing in the UI used to say. */}
          {backup.hasCheckpoint && (
            <Tooltip label="This backup recorded a checkpoint, so an incremental can be layered on top of it">
              <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
                <Link2 size={12} className="shrink-0" />
                Chainable
              </span>
            </Tooltip>
          )}
          {backup.chainBroken && (
            <span className="inline-flex items-center gap-1 text-[12px] font-medium text-red-700 dark:text-red-300">
              <Unlink size={12} className="shrink-0" />
              Chain broken
            </span>
          )}
          {backup.lastVerify && (
            <Tooltip label={`${backup.lastVerify.summary} · checked ${formatRelative(backup.lastVerify.checkedAt)}`}>
              <span className={cn(
                'inline-flex items-center gap-1 text-[12px] font-medium',
                backup.lastVerify.ok
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : 'text-red-700 dark:text-red-300',
              )}>
                <ShieldCheck size={12} className="shrink-0" />
                {backup.lastVerify.ok ? 'Verified' : 'Verify failed'}
              </span>
            </Tooltip>
          )}
        </div>
        {backup.chainBroken && (
          <p className="mt-1 text-[12px] leading-snug text-red-700 dark:text-red-300">
            A backup this one builds on is missing — it can no longer be restored.
          </p>
        )}
        {!backup.chainBroken && backup.notes?.length ? (
          <p className="mt-1 text-[12px] leading-snug text-amber-700 dark:text-amber-300">{backup.notes.join(' ')}</p>
        ) : null}
      </div>

      {/* Size — for an incremental, its own delta plus what the full chain costs */}
      <span className="font-mono text-[12.5px] tabular-nums text-foreground">
        {formatBytes(backup.sizeBytes)}
        {backup.kind === 'incremental' && backup.chainSizeBytes > backup.sizeBytes && (
          <span className="block font-sans text-[11.5px] text-muted-foreground">
            {formatBytes(backup.chainSizeBytes)} chain
          </span>
        )}
      </span>

      {/* Disks */}
      <span className="font-mono text-[12.5px] tabular-nums text-muted-foreground">
        {backup.disks.length}
      </span>

      {/* Consistency */}
      <span className={cn('inline-flex items-center gap-1.5 text-[12.5px] font-medium', cons.tone)}>
        {cons.glyph}
        {cons.label}
      </span>

      {/* Trigger */}
      <span>
        {backup.triggerType === 'scheduled' && backup.scheduleFrequency ? (
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-foreground">
            <CalendarClock size={13} className="shrink-0 text-muted-foreground" />
            {frequencyLabel(backup.scheduleFrequency)}
          </span>
        ) : (
          <span className="text-[12.5px] text-muted-foreground">Manual</span>
        )}
      </span>

      {/* Actions */}
      <div className="flex items-center justify-end gap-1">
        <Tooltip label="Read every image this backup depends on and check it for corruption">
          <button
            type="button"
            onClick={handleVerify}
            disabled={verify.isPending}
            className={ROW_ACTION}
            aria-label="Verify backup"
          >
            {verify.isPending ? <Spinner className="h-3.5 w-3.5" /> : <ShieldCheck size={14} />}
          </button>
        </Tooltip>
        {withTip('Restore', narrow,
          <Button
            variant="ghost"
            size="sm"
            onClick={onRestore}
            disabled={backup.chainBroken}
            aria-label={narrow ? 'Restore' : undefined}
            className={narrow ? 'w-8 px-0' : 'px-2.5'}
          >
            <ArchiveRestore size={narrow ? 14 : 13} />
            {!narrow && 'Restore'}
          </Button>
        )}
        <Tooltip label="Delete backup">
          <button type="button" onClick={onDelete} className={ROW_ACTION_DANGER} aria-label="Delete backup">
            <Trash2 size={14} />
          </button>
        </Tooltip>
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
      title={existing ? 'Edit backup schedule' : 'Set backup schedule'}
      description={`Automated backups for ${vmName}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={saveSchedule.isPending}>Save schedule</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Select
          id="schedule-frequency"
          label="Frequency"
          value={frequency}
          onChange={(e) => setFrequency(e.target.value as BackupFrequency)}
        >
          <option value="hourly">Hourly</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </Select>

        {frequency !== 'hourly' && (
          <div className="grid grid-cols-2 gap-3">
            <Input
              id="schedule-hour"
              label="Hour (0–23)"
              type="number"
              min={0}
              max={23}
              value={hour}
              onChange={(e) => setHour(e.target.value)}
              className="font-mono tabular-nums"
            />
            <Input
              id="schedule-minute"
              label="Minute"
              type="number"
              min={0}
              max={59}
              value={minute}
              onChange={(e) => setMinute(e.target.value)}
              className="font-mono tabular-nums"
            />
          </div>
        )}

        {frequency === 'hourly' && (
          <Input
            id="schedule-minute"
            label="Minute past the hour"
            type="number"
            min={0}
            max={59}
            value={minute}
            onChange={(e) => setMinute(e.target.value)}
            className="font-mono tabular-nums"
          />
        )}

        {frequency === 'weekly' && (
          <Select
            id="schedule-day-of-week"
            label="Day of week"
            value={dayOfWeek}
            onChange={(e) => setDayOfWeek(e.target.value)}
          >
            {DAY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        )}

        {frequency === 'monthly' && (
          <Input
            id="schedule-day-of-month"
            label="Day of month (1–28)"
            type="number"
            min={1}
            max={28}
            value={dayOfMonth}
            onChange={(e) => setDayOfMonth(e.target.value)}
            className="font-mono tabular-nums"
          />
        )}

        <div className="space-y-1.5">
          <label htmlFor="schedule-retention" className="block text-[13px] font-semibold text-foreground">
            Retention (days) <span className="font-normal text-muted-foreground">— leave blank to use global default</span>
          </label>
          <Input
            id="schedule-retention"
            type="number"
            min={0}
            placeholder="Use global default"
            value={retentionDays}
            onChange={(e) => setRetentionDays(e.target.value)}
            className="font-mono tabular-nums"
          />
        </div>

        <div className="space-y-3 border-t border-border pt-4">
          <Select
            id="schedule-mode"
            label="Backup type"
            value={mode}
            onChange={(e) => setMode(e.target.value as BackupScheduleMode)}
          >
            <option value="full">Always full — a complete copy every run</option>
            <option value="incremental">Incremental — copy only what changed</option>
          </Select>
          {mode === 'incremental' && (
            <div className="space-y-2.5">
              <Input
                id="schedule-full-every"
                label="Take a fresh full backup every"
                type="number"
                min={1}
                max={60}
                value={fullEvery}
                onChange={(e) => setFullEvery(e.target.value)}
                className="font-mono tabular-nums"
              />
              <p className="text-[12px] leading-relaxed text-muted-foreground">
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
                <p className={CALLOUT_INFO}>
                  <span className="font-medium text-foreground">The first run will still be a full backup.</span>{' '}
                  Only a backup taken with this setting on records the checkpoint an incremental measures changes
                  against, so the first run lays one down and everything after it copies just what has changed.
                </p>
              )}
              {incremental && !incremental.supported && (
                <p className={cn(CALLOUT_ATTENTION, 'flex items-start gap-2.5')}>
                  <WarnGlyph size={10} className="mt-[5px]" />
                  <span>
                    <span className="font-semibold">This host cannot take incremental backups.</span>{' '}
                    Its libvirt/qemu does not report backup support, so every run will fall back to a full backup.
                  </span>
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
      title="Delete backup"
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
        <p className="text-[13.5px] leading-relaxed text-muted-foreground">
          Delete backup from <span className="font-medium text-foreground">{formatDate(backup.createdAt)}</span>?{' '}
          <span className="font-mono text-[12.5px]">({formatBytes(backup.sizeBytes)})</span>
        </p>

        {/* Deleting a link mid-chain silently corrupts every incremental above
            it, so the destructive option has to be asked for explicitly. */}
        {backup.hasDependents && (
          <div className={CALLOUT_ATTENTION}>
            <p className="flex items-start gap-2.5">
              <WarnGlyph size={10} className="mt-[5px]" />
              <span>
                Later incremental backups are built on top of this one. Deleting it on its own would leave them
                unrestorable, so it is only possible together with them.
              </span>
            </p>
            <label className="mt-2.5 flex items-start gap-2 pl-[19px] text-[12.5px] font-medium text-foreground">
              <input
                type="checkbox"
                checked={cascade}
                onChange={(e) => setCascade(e.target.checked)}
                className="mt-[2px] h-3.5 w-3.5 shrink-0 accent-primary"
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
      title="Restore backup"
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
            <ArchiveRestore size={13} />
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
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            Restoring will overwrite <strong className="font-semibold text-foreground">{vmName}</strong>'s current disk(s).
            The VM must be <strong className="font-semibold text-foreground">stopped</strong> before restoring.
          </p>
        ) : (
          <div className="space-y-3.5">
            <p className="text-[13.5px] leading-relaxed text-muted-foreground">
              Builds a complete new machine from this backup — its own UUID, MAC addresses and IP. Works even if
              the original VM has been deleted.
            </p>
            <Input
              id="restore-new-name"
              label="New VM name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="restored-vm"
            />
            <StorageDirSelect purpose="vmDisks" value={storageDirId} onChange={setStorageDirId} />
            <label className="flex items-center gap-2 text-[13px] text-foreground">
              <input
                type="checkbox"
                checked={startAfter}
                onChange={(e) => setStartAfter(e.target.checked)}
                className="h-3.5 w-3.5 shrink-0 accent-primary"
              />
              <span>Start the VM once it is created</span>
            </label>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              cloud-init runs again on first boot so the guest picks up the new hostname and network settings.
              Attached ISOs are carried over; the original's cloud-init seed is not.
            </p>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// A selectable option card (DESIGN.md): hairline at rest, steel border and wash when chosen.
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
      aria-pressed={active}
      className={cn(
        'rounded-lg border px-3 py-2.5 text-left transition-[border-color,background-color] duration-150',
        active
          ? 'border-primary bg-accent ring-1 ring-primary/30'
          : 'border-border bg-card hover:border-muted-foreground/40',
      )}
    >
      <span className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
        <span className={cn('flex shrink-0', active ? 'text-primary' : 'text-muted-foreground')}>{icon}</span>
        {title}
      </span>
      <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">{body}</span>
    </button>
  );
}
