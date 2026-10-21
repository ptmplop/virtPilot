import { useRef, useState } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Activity, ArrowLeft, ArrowUp, Camera, Check, ChevronDown, ChevronUp,
  Copy, CopyPlus, Disc, Download, Eye, EyeOff, FolderInput, Gauge, HardDrive, Info, Pencil, Plus,
  Power, PowerOff, RotateCcw, Server, Shield, Terminal, Trash2, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { StatusGlyph, WarnGlyph } from '@/components/ui/Badge';
import { Panel, PanelHeader, Stat, StatStrip } from '@/components/ui/Panel';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { MetricChart } from '@/components/ui/MetricChart';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { StorageDirSelect } from '@/components/StorageDirSelect';
import { MoveDialog } from '@/components/MoveDialog';
import { CloneVmDialog } from '@/components/CloneVmDialog';
import { useMoveVmDisk } from '@/hooks/useVmDisks';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  useVm, useVmMeta, useVmCredentials, useVmAction, useDeleteVm, useAddDisk, useDetachDisk,
  useAttachCdrom, useDetachCdrom, useAddNic, useDetachNic, useSetNicBandwidth,
  useSetBootOrder, useBootOnce,
  useSnapshots, useCreateSnapshot, useDeleteSnapshot, useRevertSnapshot, useSnapshotToTemplate,
  useVmIfAddrs, useVmReservations,
  useVmFirewall, useSaveFirewall, useApplyFirewall,
  useSetAutostart, useResizeDisk, useUpdateVmResources, useVmStats, useVmMetricsHistory,
  useRenameVm,
} from '@/hooks/useVms';
import type { VmMetricsRange } from '@/types';
import { VmDevicesTab } from '@/components/devices/VmDevicesTab';
import { RowAction } from '@/components/ui/RowAction';
import { apiErrorMessage } from '@/lib/api';
import { useDownloadVmDisk } from '@/hooks/useVmDisks';
import { useVmPortForwards, useCreatePortForward, useDeletePortForward, useReserveIp } from '@/hooks/usePortForwards';
import { useIsos } from '@/hooks/useIsos';
import { useNetworks, useNetwork } from '@/hooks/useNetworks';
import { formatMemory, formatDisk, formatBytes, formatDateTime, formatChartTime, formatChartMoment, formatRate, networkTypeLabel } from '@/lib/format';
import { cn } from '@/lib/cn';
import { CHART } from '@/lib/chartColors';
import { useSettings } from '@/hooks/useSettings';
import type { DhcpReservation, FirewallConfig, FirewallRule, Network as NetworkConfig, PortForward, VmDisk, VmMeta, VmNic, VmSnapshot, VmStatsSample, VmStatus } from '@/types';
import { useLogoStore } from '@/store/logoStore';
import { VmLogo } from '@/components/ui/OsLogoPicker';
import { DeleteVmDialog } from '@/components/DeleteVmDialog';
import { Callout } from '@/components/ui/Callout';
import { osSlugFromImage } from '@/data/templateSets';
import { useVmOpsStore } from '@/store/vmOpsStore';
import { useUserPrefsStore } from '@/store/userPrefsStore';
import { openVmConsole } from '@/lib/consoleOpener';

type Tab = 'overview' | 'disks' | 'network' | 'snapshots' | 'firewall' | 'devices' | 'metrics';

const isSeedIso = (d: VmDisk): boolean => !!d.source?.endsWith('-seed.iso');

// The disks the operator manages: not the cloud-init seed, not an empty CD-ROM drive.
// The Overview count and the Disks tab both use this, so they can't disagree.
const isListedDisk = (d: VmDisk): boolean => !isSeedIso(d) && !(d.type === 'cdrom' && !d.source);

// Same words as the VM list and the dashboard roster (StatusBadge) — a VM shouldn't be
// "Running" on one page and "Active" on the next.
const statusLabels: Record<VmStatus, string> = {
  running: 'Running',
  stopped: 'Stopped',
  paused: 'Paused',
  crashed: 'Crashed',
  unknown: 'Unknown',
};

const statusTextColour: Record<VmStatus, string> = {
  running: 'text-emerald-700 dark:text-emerald-300',
  stopped: 'text-muted-foreground',
  paused: 'text-amber-700 dark:text-amber-300',
  crashed: 'text-red-700 dark:text-red-300',
  unknown: 'text-muted-foreground',
};

const TABS: Tab[] = ['overview', 'disks', 'network', 'snapshots', 'firewall', 'devices', 'metrics'];

// ─── Local building blocks ────────────────────────────────────────────────────


// Smaller sibling for actions that sit inline with a value (copy, reveal).
const inlineAction =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50';

// The shared head row every table in a panel uses. An unlabelled column is the
// actions column: right-aligned, named for screen readers only.
function TableHead({ columns, right = [], pad = 'px-5' }: { columns: string[]; right?: string[]; pad?: string }) {
  return (
    <thead>
      <tr className="table-head">
        {columns.map((h, i) => (
          <th
            key={h || `col-${i}`}
            scope="col"
            className={cn(pad, 'whitespace-nowrap py-2.5 font-medium', h === '' || right.includes(h) ? 'text-right' : 'text-left')}
          >
            {h === '' ? <span className="sr-only">Actions</span> : h}
          </th>
        ))}
      </tr>
    </thead>
  );
}

// A tab's main list centres its empty state in the panel; a secondary panel on the same
// tab (port forwards, rules, devices) says it in one line rather than reserving a block.
function EmptyState({ children, compact }: { children: React.ReactNode; compact?: boolean }) {
  return compact
    ? <div className="px-5 py-3.5 text-[13px] text-muted-foreground">{children}</div>
    : <div className="px-6 py-12 text-center text-[13px] text-muted-foreground">{children}</div>;
}


// An operation in flight: a short steel sweep on the gauge track.
function WorkingBar() {
  return (
    <div className="relative mt-2 h-[3px] w-full max-w-[12rem] overflow-hidden rounded-[2px] bg-gauge-track">
      <div className="absolute inset-y-0 left-0 w-1/3 animate-[vp-progress_1.4s_ease-in-out_infinite] bg-primary motion-reduce:animate-none" />
    </div>
  );
}

export function VmDetailPage() {
  const { uuid } = useParams<{ uuid: string }>();
  const navigate = useNavigate();
  // The open tab lives in the URL (?tab=snapshots), so a reload, the way back from the
  // console, or a link someone was sent all land on the same tab.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(tabParam ?? '') ? (tabParam as Tab) : 'overview';
  const setTab = (t: Tab) =>
    setSearchParams((p) => {
      const next = new URLSearchParams(p);
      if (t === 'overview') next.delete('tab'); else next.set('tab', t);
      return next;
    }, { replace: true });
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // Arrow keys move between tabs (the selected tab is the one tab stop), as in any tab list.
  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    const last = TABS.length - 1;
    const to = e.key === 'ArrowRight' ? (i === last ? 0 : i + 1)
      : e.key === 'ArrowLeft' ? (i === 0 ? last : i - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null;
    if (to === null) return;
    e.preventDefault();
    setTab(TABS[to]);
    tabRefs.current[TABS[to]]?.focus();
  };
  const { data: vm, isLoading } = useVm(uuid!);
  const { data: metaData } = useVmMeta(uuid!);
  const vmMeta = metaData?.meta ?? null;
  // The VM's mark, as on the list: one picked by hand, else the one its image implies.
  const chosenLogo = useLogoStore((s) => (vm ? s.vms[vm.name] : undefined));
  const logoSlug = chosenLogo ?? osSlugFromImage(vmMeta?.sourceTemplateFilename);
  const action = useVmAction(uuid!);
  const openConsoleInPopup = useUserPrefsStore((s) => s.openConsoleInPopup);
  const { data: hostSettings } = useSettings();

  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [cloneOpen, setCloneOpen] = useState(false);
  const rename = useRenameVm(uuid!);
  // Deleting is on the VM's own page too: a phone's list shows no row actions.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteVm = useDeleteVm();
  const handleDeleteVm = async (deleteStorage: boolean) => {
    try {
      await deleteVm.mutateAsync({ uuid: uuid!, deleteStorage });
      toast.success(`${vm?.name ?? 'VM'} deleted`);
      setDeleteOpen(false);
      navigate('/vms');
    } catch {
      toast.error('Failed to delete VM');
    }
  };

  const handleRenameStart = () => {
    setRenameValue(vm?.name ?? '');
    setRenaming(true);
  };
  const handleRenameCancel = () => setRenaming(false);
  const handleRenameSubmit = async () => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === vm?.name) { setRenaming(false); return; }
    try {
      await rename.mutateAsync(trimmed);
      setRenaming(false);
      // URL is keyed on UUID — stays valid across renames, no navigation needed.
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to rename VM');
    }
  };

  const handleAction = async (a: 'start' | 'stop' | 'reboot', force?: boolean) => {
    try {
      await action.mutateAsync({ action: a, params: force ? { force: 'true' } : undefined });
      toast.success(`${a.charAt(0).toUpperCase() + a.slice(1)} command sent`);
    } catch (err) {
      // A start held up by a passed-through device says which and why.
      toast.error(apiErrorMessage(err, `Failed to ${a}`), { duration: 10_000 });
    }
  };

  return (
    <Layout docTitle={vm?.name}>
      {/* Breadcrumb — back to the VM list (/vms); "/" is the dashboard. */}
      <nav aria-label="Breadcrumb" className="mb-5">
        <Link
          to="/vms"
          className="group inline-flex items-center gap-1.5 rounded-md text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5 transition-transform duration-200 group-hover:-translate-x-0.5" />
          Virtual machines
        </Link>
      </nav>

      {isLoading ? (
        <div className="space-y-6">
          <div className="space-y-2.5">
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-4 w-72" />
          </div>
          <Skeleton className="h-9 w-full max-w-xl" />
          <Skeleton className="h-28 rounded-lg" />
          <Skeleton className="h-56 rounded-lg" />
        </div>
      ) : !vm ? (
        <Panel className="flex flex-col items-center justify-center px-6 py-16 text-center">
          <Server className="h-5 w-5 text-muted-foreground" aria-hidden />
          <p className="mt-3 text-[15px] font-semibold text-foreground">VM not found</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            <span className="font-mono text-[12.5px]">"{uuid}"</span> does not exist or has been deleted.
          </p>
          <Button size="sm" variant="secondary" className="mt-5" onClick={() => navigate('/vms')}>
            <ArrowLeft size={14} /> Back to list
          </Button>
        </Panel>
      ) : (
        <>
          {/* Header: the name is the page title, the status line reads like the list row.
              Wraps rather than overflows: below ~1100px of content the action group drops
              under the name instead of pushing the page sideways. */}
          <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
            <div className="flex min-w-0 items-center gap-3.5">
              {/* Its distro's mark beside the name — the same muted mark the list row shows.
                  Nothing at all when no image is known, rather than a generic glyph. */}
              {logoSlug && !renaming && <VmLogo slug={logoSlug} size={40} />}
              <div className="min-w-0">
                {renaming ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      autoFocus
                      aria-label="VM name"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRenameSubmit();
                        if (e.key === 'Escape') handleRenameCancel();
                      }}
                      className="w-64 max-w-full text-[14px] font-medium"
                    />
                    <Button onClick={handleRenameSubmit} disabled={rename.isPending}>
                      {rename.isPending ? <Spinner className="h-3.5 w-3.5 text-current" /> : 'Save'}
                    </Button>
                    <Button variant="secondary" onClick={handleRenameCancel} disabled={rename.isPending}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex min-w-0 items-center gap-1.5">
                    <h1 className="truncate text-[26px] font-semibold leading-8 tracking-[-0.024em] text-foreground">{vm.name}</h1>
                    {vm.status === 'stopped' && (
                      <RowAction label="Rename VM" onClick={handleRenameStart}>
                        <Pencil size={14} />
                      </RowAction>
                    )}
                  </div>
                )}
                <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px]">
                  <span className={cn('inline-flex items-center gap-1.5 font-medium', statusTextColour[vm.status])}>
                    <StatusGlyph status={vm.status} />
                    {statusLabels[vm.status]}
                  </span>
                  <span aria-hidden className="text-muted-foreground">·</span>
                  <span className="whitespace-nowrap tabular-nums text-muted-foreground">
                    {vm.cpus} {vm.cpus === 1 ? 'vCPU' : 'vCPUs'} · {formatMemory(vm.memoryMb)}
                    {/* The host decides acceleration (xmlBuilder picks kvm vs qemu by /dev/kvm);
                        this used to say KVM unconditionally, even on TCG-only hosts. */}
                    {hostSettings && (hostSettings.kvmAvailable ? ' · KVM' : ' · TCG')}
                  </span>
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {vm.status === 'stopped' && (
                <Button size="sm" onClick={() => handleAction('start')} disabled={action.isPending}>
                  <Power size={14} /> Power on
                </Button>
              )}
              {vm.status === 'running' && (
                <>
                  <Tooltip label="Reboot (ACPI)">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => handleAction('reboot')}
                      disabled={action.isPending}
                    >
                      <RotateCcw size={14} /> Reboot
                    </Button>
                  </Tooltip>
                  <Tooltip label="Hard reset (immediate)">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => handleAction('reboot', true)}
                      disabled={action.isPending}
                    >
                      <Zap size={14} /> Hard reset
                    </Button>
                  </Tooltip>
                  <Tooltip label="Shutdown (ACPI)">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => handleAction('stop')}
                      disabled={action.isPending}
                    >
                      <Power size={14} /> Power off
                    </Button>
                  </Tooltip>
                  <Tooltip label="Force off (kill immediately)">
                    <Button
                      size="sm"
                      variant="dangerOutline"
                      onClick={() => handleAction('stop', true)}
                      disabled={action.isPending}
                    >
                      <PowerOff size={14} /> Force off
                    </Button>
                  </Tooltip>
                </>
              )}
              {/* A paused or crashed VM can't shut down gracefully, but it can always be
                  forced off — otherwise it would offer no power control at all. */}
              {(vm.status === 'paused' || vm.status === 'crashed') && (
                <Tooltip label="Force off (kill immediately)">
                  <Button
                    size="sm"
                    variant="dangerOutline"
                    onClick={() => handleAction('stop', true)}
                    disabled={action.isPending}
                  >
                    <PowerOff size={14} /> Force off
                  </Button>
                </Tooltip>
              )}
              {/* Power actions, then the tools: a hairline keeps the graceful, the forceful
                  and the everyday apart. Each state has one ink action — Power on when
                  stopped, Console when running. */}
              {vm.status !== 'unknown' && (
                <span aria-hidden className="mx-1 h-5 w-px bg-border" />
              )}
              <Tooltip label={openConsoleInPopup ? 'Open console (popup)' : 'Open console'}>
                <Button
                  size="sm"
                  variant={vm.status === 'running' ? 'primary' : 'secondary'}
                  onClick={() => openVmConsole(uuid!, openConsoleInPopup, navigate)}
                >
                  <Terminal size={14} /> Console
                </Button>
              </Tooltip>
              <Tooltip label="Clone this VM into a new machine">
                <Button size="sm" variant="secondary" onClick={() => setCloneOpen(true)}>
                  <CopyPlus size={14} /> Clone
                </Button>
              </Tooltip>
              <span aria-hidden className="mx-1 h-5 w-px bg-border" />
              <RowAction label="Delete VM" danger onClick={() => setDeleteOpen(true)}>
                <Trash2 size={14} />
              </RowAction>
            </div>
          </div>

          <DeleteVmDialog
            open={deleteOpen}
            vmName={vm.name}
            isPending={deleteVm.isPending}
            onClose={() => setDeleteOpen(false)}
            onConfirm={handleDeleteVm}
          />

          {cloneOpen && (
            <CloneVmDialog
              open
              vmUuid={uuid!}
              vmName={vm.name}
              vmStatus={vm.status}
              onClose={() => setCloneOpen(false)}
            />
          )}

          {/* Tab bar: underline tabs on a full-width hairline. The underline hugs the
              label, so the first tab lines up with the content edge. Only on a phone does
              the bar scroll sideways — there the hairline is an inset shadow (a scroll box
              would clip tabs hanging over a real border) and the focus ring is drawn inside
              the tab. Wider screens keep the plain border and the usual outside ring. */}
          <div
            role="tablist"
            aria-label="VM sections"
            className="mb-6 flex items-center gap-6 overflow-x-auto shadow-[inset_0_-1px_0_hsl(var(--border))] [scrollbar-width:none] sm:mb-7 sm:overflow-visible sm:border-b sm:border-border sm:shadow-none [&::-webkit-scrollbar]:hidden"
          >
            {TABS.map((t, i) => (
              <button
                key={t}
                ref={(el) => { tabRefs.current[t] = el; }}
                type="button"
                role="tab"
                id={`vm-tab-${t}`}
                aria-controls={`vm-panel-${t}`}
                aria-selected={tab === t}
                tabIndex={tab === t ? 0 : -1}
                onKeyDown={(e) => onTabKey(e, i)}
                onClick={() => setTab(t)}
                className={cn(
                  'shrink-0 whitespace-nowrap border-b-2 pb-2.5 pt-1 text-[13.5px] font-medium capitalize transition-colors duration-150 focus-visible:outline-offset-[-2px] sm:-mb-px sm:focus-visible:outline-offset-2',
                  tab === t
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:border-input hover:text-foreground'
                )}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Always mount tab panels so in-flight operations (e.g. snapshot progress) survive tab switches */}
          <div role="tabpanel" id="vm-panel-overview" aria-labelledby="vm-tab-overview" className={tab !== 'overview' ? 'hidden' : undefined}><OverviewTab vm={vm} vmUuid={uuid!} /></div>
          <div role="tabpanel" id="vm-panel-disks" aria-labelledby="vm-tab-disks" className={tab !== 'disks' ? 'hidden' : undefined}><DisksTab vmUuid={uuid!} disks={vm.disks} vmStatus={vm.status} /></div>
          <div role="tabpanel" id="vm-panel-network" aria-labelledby="vm-tab-network" className={tab !== 'network' ? 'hidden' : undefined}><NetworkTab vmUuid={uuid!} nics={vm.nics} meta={vmMeta} /></div>
          <div role="tabpanel" id="vm-panel-snapshots" aria-labelledby="vm-tab-snapshots" className={tab !== 'snapshots' ? 'hidden' : undefined}><SnapshotsTab vmUuid={uuid!} vmStatus={vm.status} /></div>
          <div role="tabpanel" id="vm-panel-firewall" aria-labelledby="vm-tab-firewall" className={tab !== 'firewall' ? 'hidden' : undefined}><FirewallTab vmUuid={uuid!} vmStatus={vm.status} /></div>
          <div role="tabpanel" id="vm-panel-devices" aria-labelledby="vm-tab-devices" className={tab !== 'devices' ? 'hidden' : undefined}><VmDevicesTab vmUuid={uuid!} vmName={vm.name} /></div>
          <div role="tabpanel" id="vm-panel-metrics" aria-labelledby="vm-tab-metrics" className={tab !== 'metrics' ? 'hidden' : undefined}><MetricsTab vmUuid={uuid!} vmStatus={vm.status} /></div>
        </>
      )}
    </Layout>
  );
}

// ─── Overview ─────────────────────────────────────────────────────────────────

function OverviewTab({
  vm,
  vmUuid,
}: {
  vm: NonNullable<ReturnType<typeof useVm>['data']>;
  vmUuid: string;
}) {
  const { data: metaData } = useVmMeta(vmUuid);
  const meta = metaData?.meta ?? null;
  const ip = metaData?.ip ?? null;
  const credentials = useVmCredentials(vmUuid);
  const [showPassword, setShowPassword] = useState(false);
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null);
  const handleTogglePassword = async () => {
    if (showPassword) {
      setShowPassword(false);
      return;
    }
    if (revealedPassword === null) {
      try {
        const { password } = await credentials.mutateAsync();
        setRevealedPassword(password);
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : 'Failed to fetch password');
        return;
      }
    }
    setShowPassword(true);
  };
  const handleCopyPassword = async () => {
    try {
      const password = revealedPassword ?? (await credentials.mutateAsync()).password;
      if (revealedPassword === null) setRevealedPassword(password);
      await navigator.clipboard.writeText(password);
      toast.success('Password copied');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to copy password');
    }
  };
  const [editResourcesOpen, setEditResourcesOpen] = useState(false);
  const [editCpus, setEditCpus] = useState(String(vm.cpus));
  const [editMemMb, setEditMemMb] = useState(String(vm.memoryMb));
  // While it runs, the Overview reads the machine itself; the Metrics tab (always
  // mounted) already polls these stats, so this shares that query rather than adding one.
  const { data: stats } = useVmStats(vmUuid, vm.status === 'running');
  const live = vm.status === 'running' ? stats?.current : undefined;
  const updateResources = useUpdateVmResources(vmUuid);
  const setAutostart = useSetAutostart(vmUuid);

  const handleSaveResources = async () => {
    const cpus = parseInt(editCpus, 10);
    const memoryMb = parseInt(editMemMb, 10);
    if (!cpus || cpus < 1 || !memoryMb || memoryMb < 128) {
      toast.error('Invalid values - vCPUs must be ≥ 1 and memory ≥ 128 MB');
      return;
    }
    try {
      await updateResources.mutateAsync({ cpus, memoryMb });
      toast.success('Resources updated - changes take effect on next boot');
      setEditResourcesOpen(false);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to update resources');
    }
  };

  const handleAutostartToggle = async () => {
    const newVal = !(vm.autostart ?? false);
    try {
      await setAutostart.mutateAsync(newVal);
      toast.success(newVal ? 'Autostart enabled' : 'Autostart disabled');
    } catch {
      toast.error('Failed to update autostart');
    }
  };

  return (
    <div className="space-y-8">
      {/* Resource summary — one strip of readouts */}
      <section className="space-y-3.5">
        <SectionHeading label="Resources">
          {vm.status !== 'stopped' ? (
            <Tooltip label="Stop the VM to resize CPU or memory" side="left">
              <Button size="sm" variant="secondary" disabled>
                <Pencil size={14} /> Edit
              </Button>
            </Tooltip>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setEditCpus(String(vm.cpus));
                setEditMemMb(String(vm.memoryMb));
                setEditResourcesOpen(true);
              }}
            >
              <Pencil size={14} /> Edit
            </Button>
          )}
        </SectionHeading>
        {live ? (
          // Running: what it is doing now, with what it was given underneath.
          <StatStrip>
            <Stat
              label="CPU"
              value={`${Math.round(live.cpuPercent)}%`}
              sub={`${vm.cpus} ${vm.cpus === 1 ? 'vCPU' : 'vCPUs'}`}
              tone={live.cpuPercent > 80 ? 'warn' : undefined}
            />
            <MemoryStat sample={live} />
            <Stat
              label="Disk I/O"
              value={formatRate(live.diskReadBps + live.diskWriteBps)}
              sub={`Read ${formatRate(live.diskReadBps)} · Write ${formatRate(live.diskWriteBps)}`}
            />
            <Stat
              label="Network"
              value={formatRate(live.netRxBps + live.netTxBps)}
              sub={`In ${formatRate(live.netRxBps)} · Out ${formatRate(live.netTxBps)}`}
            />
          </StatStrip>
        ) : (
          <StatStrip>
            <Stat label="vCPUs" value={String(vm.cpus)} />
            <Stat label="Memory" value={formatMemory(vm.memoryMb)} />
            <Stat label="Disks" value={String(vm.disks.filter(isListedDisk).length)} />
            <Stat label="NICs" value={String(vm.nics.length)} />
          </StatStrip>
        )}
        {/* Why Edit is greyed, in words: a tooltip never reaches touch or keyboard users. */}
        {vm.status !== 'stopped' && (
          <p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Shut down the VM to edit CPU and memory allocation.
          </p>
        )}
      </section>

      {/* Edit Resources dialog */}
      <Dialog
        open={editResourcesOpen}
        onClose={() => setEditResourcesOpen(false)}
        title="Edit resources"
        description="The VM must be stopped. Changes take effect on the next boot."
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setEditResourcesOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSaveResources} disabled={updateResources.isPending}>
              {updateResources.isPending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="vCPUs"
            id="edit-vcpus"
            type="number"
            min={1}
            max={64}
            value={editCpus}
            onChange={(e) => setEditCpus(e.target.value)}
          />
          <Input
            label="Memory (MB)"
            id="edit-memory-mb"
            type="number"
            min={128}
            step={256}
            value={editMemMb}
            onChange={(e) => setEditMemMb(e.target.value)}
          />
        </div>
      </Dialog>

      {/* Access credentials */}
      {meta && (
        <section className="space-y-3.5">
          <SectionHeading label="Access" />
          <Panel className="overflow-hidden">
            <dl className="grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <InfoField label="IP address">
                {ip ? (
                  <>
                    <span className="truncate font-mono text-[13px] text-foreground">{ip}</span>
                    <CopyButton text={ip} label="Copy IP address" />
                  </>
                ) : (
                  // ip is resolved from leases/the guest agent; a running VM may simply not
                  // have reported one yet, so don't tell its operator to start it.
                  <span className="text-[12.5px] text-muted-foreground">
                    {vm.status === 'running' ? 'Not resolved yet' : 'Start VM to resolve'}
                  </span>
                )}
              </InfoField>
              <InfoField label="Username">
                <span className="truncate font-mono text-[13px] text-foreground">{meta.username}</span>
                <CopyButton text={meta.username} label="Copy username" />
              </InfoField>
              <InfoField label="Password">
                <span className="truncate font-mono text-[13px] text-foreground">
                  {showPassword && revealedPassword !== null ? revealedPassword : '••••••••'}
                </span>
                <Tooltip label={showPassword ? 'Hide password' : 'Reveal password'}>
                  <button
                    type="button"
                    onClick={handleTogglePassword}
                    disabled={credentials.isPending}
                    className={inlineAction}
                    aria-label={showPassword ? 'Hide password' : 'Reveal password'}
                  >
                    {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </Tooltip>
                <Tooltip label="Copy password">
                  <button
                    type="button"
                    onClick={handleCopyPassword}
                    disabled={credentials.isPending}
                    className={inlineAction}
                    aria-label="Copy password"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              </InfoField>
            </dl>
            {ip && (
              <div className="flex items-center justify-between gap-3 border-t border-border bg-surface/60 px-5 py-2.5">
                <code className="block min-w-0 select-all truncate font-mono text-[12px] text-muted-foreground">
                  ssh {meta.username}@{ip}
                </code>
                <CopyButton text={`ssh ${meta.username}@${ip}`} label="Copy SSH command" />
              </div>
            )}
          </Panel>
        </section>
      )}

      {/* Configuration — keys and values, ruled */}
      <section className="space-y-3.5">
        <SectionHeading label="Configuration" />
        <Panel>
          <dl className="divide-y divide-border">
            <ConfigRow label="UUID">
              <span className="truncate font-mono text-[12px] text-foreground">{vm.id}</span>
              <CopyButton text={vm.id} label="Copy UUID" />
            </ConfigRow>
            {meta?.sourceTemplateFilename && (
              <ConfigRow label="Source image">
                <span className="truncate font-mono text-[12px] text-foreground" title={meta.sourceTemplateFilename}>
                  {meta.sourceTemplateFilename}
                </span>
              </ConfigRow>
            )}
            {meta?.createdAt && (
              <ConfigRow label="Created">
                <span className="text-[12.5px] tabular-nums text-foreground">{formatDateTime(meta.createdAt)}</span>
              </ConfigRow>
            )}
            {/* Autostart toggle */}
            <ConfigRow label="Autostart on host boot" labelId="autostart-label">
              <button
                type="button"
                role="switch"
                aria-checked={vm.autostart ?? false}
                aria-labelledby="autostart-label"
                disabled={setAutostart.isPending}
                onClick={handleAutostartToggle}
                className={cn(
                  'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50',
                  vm.autostart ? 'bg-primary' : 'bg-input'
                )}
              >
                <span
                  className={cn(
                    'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgb(27_36_51/0.25)] transition-transform duration-150',
                    vm.autostart ? 'translate-x-4' : 'translate-x-0'
                  )}
                />
              </button>
            </ConfigRow>
            {vm.status === 'running' && vm.guestAgent !== undefined && (
              <ConfigRow label="Guest agent">
                {/* Plain words: the status glyphs are kept for a VM's own state. */}
                {vm.guestAgent ? (
                  <span className="text-[12.5px] font-medium text-emerald-700 dark:text-emerald-300">Connected</span>
                ) : (
                  <span className="text-[12.5px] text-muted-foreground">Not available</span>
                )}
              </ConfigRow>
            )}
            {/* One fact, one row: display :0 is port 5900. */}
            {(vm.vncDisplay || vm.vncPort != null) && (
              <ConfigRow label="VNC">
                <span className="truncate font-mono text-[12px] tabular-nums text-foreground">
                  {[vm.vncDisplay, vm.vncPort != null ? `port ${vm.vncPort}` : null].filter(Boolean).join(' · ')}
                </span>
              </ConfigRow>
            )}
          </dl>
        </Panel>
      </section>
    </div>
  );
}

// Memory in use, with what it is measured against. Without the balloon driver's stats a
// guest can't say what it uses; the figure is then what the host has handed it so far,
// and the line says so.
function MemoryStat({ sample }: { sample: VmStatsSample }) {
  const pct = sample.memTotalMb > 0 ? Math.round((sample.memUsedMb / sample.memTotalMb) * 100) : 0;
  const amounts = `${formatMemory(sample.memUsedMb)} of ${formatMemory(sample.memTotalMb)}`;
  return (
    <Stat
      label="Memory"
      value={`${pct}%`}
      sub={sample.memSource === 'host' ? (
        <span title="This guest doesn't report its own memory use (no balloon driver), so this is the memory the host has given it so far.">
          {amounts} · resident on host
        </span>
      ) : amounts}
      tone={pct > 90 ? 'warn' : undefined}
    />
  );
}

function CopyButton({ text, label = 'Copy to clipboard' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip label={copied ? 'Copied' : 'Copy'}>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className={inlineAction}
        aria-label={label}
      >
        {copied
          ? <Check className="h-3.5 w-3.5 text-success" />
          : <Copy className="h-3.5 w-3.5" />}
      </button>
    </Tooltip>
  );
}

// One cell of the Access strip: a readout label over a mono value and its actions.
function InfoField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 px-5 py-4">
      <dt className="readout-label">{label}</dt>
      <dd className="mt-2 flex min-h-[24px] min-w-0 items-center gap-1.5">{children}</dd>
    </div>
  );
}

// One key/value row: a quiet label in a fixed column, then the value — the same plate
// the dashboard's Host panel uses.
function ConfigRow({ label, labelId, children }: { label: string; labelId?: string; children: React.ReactNode }) {
  return (
    // A phone stacks the label over its value, so a UUID or path keeps the full width.
    <div className="grid min-h-[46px] grid-cols-1 items-center gap-x-4 gap-y-1 px-5 py-2.5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:gap-y-0 sm:py-2">
      <dt id={labelId} className="text-[12.5px] text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">{children}</dd>
    </div>
  );
}

// ─── Disks ────────────────────────────────────────────────────────────────────

function DisksTab({
  vmUuid,
  disks,
  vmStatus,
}: {
  vmUuid: string;
  disks: VmDisk[];
  vmStatus: import('@/types').VmStatus;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [addStorageDirId, setAddStorageDirId] = useState('');
  const [cdromOpen, setCdromOpen] = useState(false);
  const [sizeGb, setSizeGb] = useState('20');
  const [isoFilename, setIsoFilename] = useState('');
  const [resizingDisk, setResizingDisk] = useState<VmDisk | null>(null);
  const [resizeAddGb, setResizeAddGb] = useState('10');
  const [movingDisk, setMovingDisk] = useState<VmDisk | null>(null);
  const moveVmDisk = useMoveVmDisk();
  const addDisk = useAddDisk(vmUuid);
  const detachDisk = useDetachDisk(vmUuid);
  const attachCdrom = useAttachCdrom(vmUuid);
  const detachCdrom = useDetachCdrom(vmUuid);
  const resizeDisk = useResizeDisk(vmUuid);
  const setBootOrder = useSetBootOrder(vmUuid);
  const bootOnce = useBootOnce(vmUuid);
  const downloadDisk = useDownloadVmDisk();
  const { data: isos = [] } = useIsos();

  // Exclude the cloud-init seed ISO — it's a system detail, not user-managed
  const bootableDisks = disks.filter(isListedDisk);
  const initialOrder = (): string[] => {
    const withOrder = bootableDisks
      .filter((d) => d.bootOrder != null)
      .sort((a, b) => (a.bootOrder ?? 0) - (b.bootOrder ?? 0))
      .map((d) => d.target);
    if (withOrder.length > 0) return withOrder;
    // Default: main disk first
    return bootableDisks.map((d) => d.target);
  };

  const [localOrder, setLocalOrder] = useState<string[]>(initialOrder);
  const [orderDirty, setOrderDirty] = useState(false);

  // Re-sync when disks change (e.g. after ISO attach/detach or VM refresh)
  const disksKey = disks.map((d) => `${d.target}:${d.bootOrder}:${d.source ?? ''}`).join(',');
  const [prevDisksKey, setPrevDisksKey] = useState(disksKey);
  if (disksKey !== prevDisksKey) {
    setPrevDisksKey(disksKey);
    setLocalOrder(initialOrder());
    setOrderDirty(false);
  }

  const moveUp = (target: string) => {
    setLocalOrder((prev) => {
      const i = prev.indexOf(target);
      if (i <= 0) return prev;
      const next = [...prev];
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      return next;
    });
    setOrderDirty(true);
  };

  const moveDown = (target: string) => {
    setLocalOrder((prev) => {
      const i = prev.indexOf(target);
      if (i < 0 || i >= prev.length - 1) return prev;
      const next = [...prev];
      [next[i], next[i + 1]] = [next[i + 1], next[i]];
      return next;
    });
    setOrderDirty(true);
  };

  const handleSaveBootOrder = async () => {
    try {
      await setBootOrder.mutateAsync(localOrder);
      toast.success('Boot order saved - stop and start the VM to apply (reboot is not sufficient)');
      setOrderDirty(false);
    } catch {
      toast.error('Failed to save boot order');
    }
  };

  // A cleared Size field parses to NaN, which JSON-serialises to null — the
  // request then went through and the user silently got a disk they never
  // asked for. Block it here rather than relying on the backend's shape check.
  const parsedSizeGb = parseInt(sizeGb, 10);
  const sizeGbValid = Number.isFinite(parsedSizeGb) && parsedSizeGb >= 1;

  const handleAddDisk = async () => {
    if (!sizeGbValid) return;
    try {
      await addDisk.mutateAsync({ sizeGb: parsedSizeGb, storageDirId: addStorageDirId || undefined });
      toast.success('Disk added');
      setAddOpen(false);
    } catch {
      toast.error('Failed to add disk');
    }
  };

  const handleAttachCdrom = async () => {
    try {
      await attachCdrom.mutateAsync({ isoFilename });
      toast.success('ISO attached');
      setCdromOpen(false);
    } catch {
      toast.error('Failed to attach ISO');
    }
  };

  // sdb cdrom with an ISO mounted — eligible for boot-once
  const isoSlot = disks.find((d) => d.target === 'sdb' && d.type === 'cdrom' && d.source);

  return (
    <div className="space-y-6">
      {/* Disk table */}
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Disks & storage"
          actions={
            <>
              <Button size="sm" variant="secondary" onClick={() => setCdromOpen(true)}>
                <Disc size={14} /> Attach ISO
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
                <Plus size={14} /> Add disk
              </Button>
            </>
          }
        />

        {/* Same filter as the rows: a VM whose only drives are the seed ISO or an empty
            CD-ROM used to get a bare header instead of this line. */}
        {bootableDisks.length === 0 ? (
          <EmptyState>No disks attached.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <TableHead columns={['Device', 'Type', 'Bus', 'Size', 'Source', '']} />
              <tbody className="divide-y divide-border">
                {bootableDisks.map((d) => (
                  <tr key={d.target} className="table-row">
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <span className="font-mono text-[12.5px] font-medium text-foreground">{d.target}</span>
                        {d.fileMissing && (
                          <Tooltip label={`File missing on disk: ${d.source}. The VM will fail to start until the file is restored or the path is corrected.`}>
                            <span className="inline-flex cursor-help items-center gap-1 text-[12px] font-medium text-amber-700 dark:text-amber-300">
                              <WarnGlyph /> missing
                            </span>
                          </Tooltip>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-2.5 text-muted-foreground">
                      <Tooltip label={d.type === 'cdrom' ? 'CD-ROM' : 'Disk'}>
                        {d.type === 'cdrom'
                          ? <Disc size={15} className="text-muted-foreground" aria-hidden />
                          : <HardDrive size={15} className="text-muted-foreground" aria-hidden />}
                        <span className="sr-only">{d.type === 'cdrom' ? 'CD-ROM' : 'Disk'}</span>
                      </Tooltip>
                    </td>
                    <td className="px-5 py-2.5 font-mono text-[12px] text-muted-foreground">{d.bus || <span className="font-sans">Unknown</span>}</td>
                    <td className="whitespace-nowrap px-5 py-2.5 text-[12.5px] tabular-nums text-foreground">
                      {d.sizeGb != null && d.sizeGb > 0 ? formatDisk(d.sizeGb) : d.type === 'cdrom' ? null : <span className="text-muted-foreground">Unknown</span>}
                    </td>
                    {/* Elastic column: w-full takes the slack, max-w-0 lets it give way first,
                        so a long path truncates instead of pushing the row actions out. */}
                    <td className="w-full max-w-0 px-5 py-2.5" title={d.source}>
                      <div className={cn('truncate font-mono text-[12px]', d.fileMissing ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>
                        {d.source || <span className="font-sans">None</span>}
                        {d.storageDirName && (
                          <span className="ml-2 font-sans text-[12px] text-muted-foreground">· {d.storageDirName}</span>
                        )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-5 py-1.5 text-right">
                      <div className="inline-flex items-center justify-end gap-0.5">
                        {d.type === 'disk' && d.source && /\.qcow2$/i.test(d.source) && d.storageDirId && (
                          <RowAction
                            label="Move to another storage directory"
                            tooltip={vmStatus === 'stopped' ? 'Move to another storage directory' : 'Stop the VM before moving its disk'}
                            disabled={vmStatus !== 'stopped'}
                            onClick={() => setMovingDisk(d)}
                          >
                            <FolderInput size={14} />
                          </RowAction>
                        )}
                        {d.type === 'disk' && d.source && /\.qcow2$/i.test(d.source) && (
                          <RowAction
                            label="Download disk image"
                            tooltip={vmStatus === 'stopped' ? 'Download disk image' : 'Stop the VM before downloading its disk'}
                            disabled={vmStatus !== 'stopped' || downloadDisk.isPending}
                            onClick={async () => {
                              const filename = d.source!.split('/').pop()!;
                              try {
                                await downloadDisk.mutateAsync({ vmUuid, filename });
                              } catch (err: unknown) {
                                toast.error(err instanceof Error ? err.message : 'Failed to start download');
                              }
                            }}
                          >
                            <Download size={14} />
                          </RowAction>
                        )}
                        {d.type === 'disk' && d.source && (
                          <RowAction label="Grow disk" onClick={() => { setResizeAddGb('10'); setResizingDisk(d); }}>
                            <ArrowUp size={14} />
                          </RowAction>
                        )}
                        {d.target !== 'vda' && d.target !== 'sda' && (
                          <RowAction
                            label="Detach"
                            danger
                            onClick={async () => {
                              try {
                                if (d.type === 'cdrom') await detachCdrom.mutateAsync(d.target);
                                else await detachDisk.mutateAsync(d.target);
                                toast.success('Detached');
                              } catch {
                                toast.error('Failed to detach');
                              }
                            }}
                          >
                            <Trash2 size={14} />
                          </RowAction>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Resize disk dialog */}
      <Dialog
        open={!!resizingDisk}
        onClose={() => setResizingDisk(null)}
        title="Grow disk"
        description={`Disk image will be extended. Partition/filesystem resize must be done inside the guest.${vmStatus === 'stopped' ? '' : ' The VM will be notified of the new size immediately.'}`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setResizingDisk(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={async () => {
                if (!resizingDisk) return;
                const gb = parseInt(resizeAddGb, 10);
                if (!gb || gb <= 0) { toast.error('Enter a valid number of GB'); return; }
                try {
                  await resizeDisk.mutateAsync({ target: resizingDisk.target, addGb: gb });
                  toast.success(`${resizingDisk.target} grown by ${gb} GB`);
                  setResizingDisk(null);
                } catch (err: unknown) {
                  toast.error(err instanceof Error ? err.message : 'Failed to resize disk');
                }
              }}
              disabled={resizeDisk.isPending}
            >
              {resizeDisk.isPending ? 'Resizing…' : `Add ${resizeAddGb || '?'} GB`}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="rounded-md border border-border bg-surface px-3.5 py-2.5">
            <p className="truncate font-mono text-[12px] text-foreground">
              {resizingDisk?.target} <span className="text-muted-foreground">- {resizingDisk?.source?.split('/').pop() ?? ''}</span>
            </p>
          </div>
          <Input
            label="Gigabytes to add"
            id="grow-disk-gb"
            type="number"
            min={1}
            max={10240}
            value={resizeAddGb}
            onChange={(e) => setResizeAddGb(e.target.value)}
            placeholder="e.g. 10"
          />
        </div>
      </Dialog>

      {/* Boot order — only when there is an order to choose */}
      {bootableDisks.length > 1 && (
        <Panel className="overflow-hidden">
          <PanelHeader
            title="Boot order"
            meta={orderDirty ? 'Unsaved changes' : undefined}
            actions={
              orderDirty ? (
                <Button
                  size="sm"
                  onClick={handleSaveBootOrder}
                  disabled={setBootOrder.isPending}
                >
                  {setBootOrder.isPending ? 'Saving…' : 'Save boot order'}
                </Button>
              ) : undefined
            }
          />
          <ol className="divide-y divide-border">
            {localOrder.map((target, idx) => {
              const disk = disks.find((d) => d.target === target);
              if (!disk) return null;
              return (
                <li key={target} className="flex items-center gap-4 px-5 py-1.5">
                  <span className="w-4 shrink-0 text-right font-mono text-[12px] tabular-nums text-muted-foreground">
                    {idx + 1}
                  </span>
                  <span className="flex min-w-0 flex-1 items-baseline gap-2.5 font-mono">
                    <span className="shrink-0 text-[12.5px] font-medium text-foreground">{target}</span>
                    {disk.source && (
                      <span className="min-w-0 truncate text-[12px] text-muted-foreground">
                        {disk.source.split('/').pop()}
                      </span>
                    )}
                  </span>
                  <span className="text-[12.5px] text-muted-foreground">
                    {disk.type}
                  </span>
                  <div className="flex gap-0.5">
                    <RowAction label="Move up" onClick={() => moveUp(target)} disabled={idx === 0}>
                      <ChevronUp size={15} />
                    </RowAction>
                    <RowAction label="Move down" onClick={() => moveDown(target)} disabled={idx === localOrder.length - 1}>
                      <ChevronDown size={15} />
                    </RowAction>
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="flex items-center gap-1.5 border-t border-border bg-surface/60 px-5 py-2.5 text-[12px] text-muted-foreground">
            <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Changes take effect after stopping and starting the VM. Rebooting is not sufficient.
          </p>
        </Panel>
      )}

      {/* Boot Once from ISO */}
      {isoSlot && (
        <Panel>
          <PanelHeader
            title="One-shot boot from ISO"
            actions={
              <Tooltip label={vmStatus === 'running' ? 'Power off the VM first' : 'Boot from ISO once'}>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={vmStatus !== 'stopped' || bootOnce.isPending}
                  onClick={async () => {
                    try {
                      await bootOnce.mutateAsync('cdrom');
                      toast.success('Starting from ISO…');
                    } catch {
                      toast.error('Failed to start');
                    }
                  }}
                >
                  <Zap size={14} />
                  {bootOnce.isPending ? 'Starting…' : 'Boot once from ISO'}
                </Button>
              </Tooltip>
            }
          />
          <div className="space-y-1.5 px-5 py-3.5">
            <p className="text-[13px] leading-5 text-muted-foreground">
              Start the VM once from the attached ISO without changing the persistent boot order.
              {vmStatus === 'running' && (
                <span className="ml-1 text-amber-700 dark:text-amber-300">
                  Power off the VM first to use this option.
                </span>
              )}
            </p>
            <p className="font-mono text-[12px] text-foreground">
              {isoSlot.source.split('/').pop()}
            </p>
          </div>
        </Panel>
      )}

      <MoveDialog
        open={movingDisk !== null}
        onClose={() => setMovingDisk(null)}
        itemLabel={movingDisk?.source ? movingDisk.source.split('/').pop()! : ''}
        purpose="vmDisks"
        currentStorageDirId={movingDisk?.storageDirId ?? ''}
        notes={
          <>
            VM must be stopped - moving a live qcow2 underneath QEMU corrupts it.
            The domain XML is rewritten to point at the new path on success.
          </>
        }
        busy={moveVmDisk.isPending}
        onMove={async (storageDirId) => {
          if (!movingDisk?.source) return;
          const filename = movingDisk.source.split('/').pop()!;
          await moveVmDisk.mutateAsync({ vmUuid, filename, storageDirId });
        }}
      />

      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add disk"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleAddDisk} disabled={addDisk.isPending || !sizeGbValid}>
              {addDisk.isPending ? 'Adding…' : 'Add disk'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Size (GB)"
            type="number"
            min="1"
            value={sizeGb}
            onChange={(e) => setSizeGb(e.target.value)}
            error={sizeGbValid ? undefined : 'Enter a size of at least 1 GB'}
          />
          <StorageDirSelect purpose="vmDisks" value={addStorageDirId} onChange={setAddStorageDirId} />
        </div>
      </Dialog>

      <Dialog
        open={cdromOpen}
        onClose={() => setCdromOpen(false)}
        title="Attach ISO"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setCdromOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleAttachCdrom}
              disabled={attachCdrom.isPending || !isoFilename}
            >
              {attachCdrom.isPending ? 'Attaching…' : 'Attach'}
            </Button>
          </>
        }
      >
        <Select
          label="ISO"
          value={isoFilename}
          onChange={(e) => setIsoFilename(e.target.value)}
          required
        >
          <option value="">Select an ISO…</option>
          {isos.map((iso) => (
            <option key={iso.filename} value={iso.filename}>
              {iso.name}
            </option>
          ))}
        </Select>
        {isos.length === 0 && (
          <p className="mt-2 text-[12.5px] text-muted-foreground">
            No ISOs found. Upload one on the ISOs page.
          </p>
        )}
      </Dialog>
    </div>
  );
}

// ─── Snapshots ────────────────────────────────────────────────────────────────

// libvirt's snapshot-list "State" column reports what was captured at snapshot
// time, not the VM's live state. Map the raw values to clearer labels.
function snapshotStateLabel(vmState: string): string {
  switch (vmState) {
    case 'disk-snapshot': return 'Disk only';
    case 'running': return 'Live (with RAM)';
    case 'shutoff': return 'Offline';
    case 'paused': return 'Paused';
    default: return vmState;
  }
}

function SnapshotsTab({ vmUuid, vmStatus }: { vmUuid: string; vmStatus: VmStatus }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [revertTarget, setRevertTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [toTemplateTarget, setToTemplateTarget] = useState<string | null>(null);
  const [snapshotName, setSnapshotName] = useState('');
  const [templateName, setTemplateName] = useState('');

  const {
    pendingSnapshot: allPendingSnapshots, setPendingSnapshot: storePendingSnapshot,
    pendingRevert: allPendingReverts, setPendingRevert: storePendingRevert,
    pendingConvert: allPendingConverts, setPendingConvert: storePendingConvert,
  } = useVmOpsStore();
  const pendingSnapshot = allPendingSnapshots[vmUuid] ?? null;
  const pendingRevert = allPendingReverts[vmUuid] ?? null;
  const pendingConvert = allPendingConverts[vmUuid] ?? null;
  const setPendingSnapshot = (name: string | null) => storePendingSnapshot(vmUuid, name);
  const setPendingRevert = (name: string | null) => storePendingRevert(vmUuid, name);
  const setPendingConvert = (name: string | null) => storePendingConvert(vmUuid, name);

  const { data: snapshots = [], isLoading } = useSnapshots(vmUuid);
  const { templates: templateLogos, setTemplateLogo } = useLogoStore();
  const createSnapshot = useCreateSnapshot(vmUuid);
  const deleteSnapshot = useDeleteSnapshot(vmUuid);
  const revertSnapshot = useRevertSnapshot(vmUuid);
  const snapshotToTemplate = useSnapshotToTemplate(vmUuid);

  const handleCreate = async () => {
    const name = snapshotName.trim();
    if (!name) return;
    setCreateOpen(false);
    setSnapshotName('');
    setPendingSnapshot(name);
    try {
      await createSnapshot.mutateAsync({ name });
      toast.success('Snapshot created');
    } catch (err: unknown) {
      const isTimeout = (err as { code?: string })?.code === 'ECONNABORTED';
      if (isTimeout) {
        toast.warning('Snapshot is taking longer than expected - check the list in a moment');
      } else {
        toast.error(apiErrorMessage(err, 'Failed to create snapshot'), { duration: 10_000 });
      }
    } finally {
      setPendingSnapshot(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteSnapshot.mutateAsync(deleteTarget);
      toast.success('Snapshot deleted');
      setDeleteTarget(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to delete snapshot'), { duration: 10_000 });
    }
  };

  const handleRevert = async () => {
    if (!revertTarget) return;
    const target = revertTarget;
    setRevertTarget(null);
    setPendingRevert(target);
    try {
      await revertSnapshot.mutateAsync(target);
      toast.success('Snapshot restored - VM is starting');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to restore snapshot'), { duration: 10_000 });
    } finally {
      setPendingRevert(null);
    }
  };

  const handleToTemplate = async () => {
    if (!toTemplateTarget || !templateName.trim()) return;
    const target = toTemplateTarget;
    const name = templateName.trim();
    setToTemplateTarget(null);
    setTemplateName('');
    setPendingConvert(target);
    try {
      const { filename, sourceTemplateFilename } = await snapshotToTemplate.mutateAsync({ snapshotName: target, templateName: name });
      if (sourceTemplateFilename) {
        const inheritedSlug = templateLogos[sourceTemplateFilename];
        if (inheritedSlug) setTemplateLogo(filename, inheritedSlug);
      }
      toast.success('Template created - available on the Templates page');
    } catch (err: unknown) {
      // The 409 names the *resolved* filename ("Ubuntu 22.04" becomes
      // "Ubuntu-22-04.qcow2"), which the operator cannot work out from what
      // they typed — so show the server's message rather than a generic one.
      toast.error(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to convert snapshot to template'
      );
    } finally {
      setPendingConvert(null);
    }
  };

  return (
    <div className="space-y-6">
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Snapshots"
          actions={
            <Button size="sm" variant="secondary" onClick={() => setCreateOpen(true)}>
              <Camera size={14} /> Take snapshot
            </Button>
          }
        />
        {isLoading ? (
          <EmptyState>Loading…</EmptyState>
        ) : snapshots.length === 0 && !pendingSnapshot ? (
          <EmptyState>No snapshots yet. Take a snapshot to save the current VM state.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <TableHead columns={['Name', 'Created', 'VM state', 'Size', '']} />
              <tbody className="divide-y divide-border">
                {pendingSnapshot && (
                  <tr key="__pending" className="bg-surface/60">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <Spinner className="h-3.5 w-3.5 shrink-0" />
                        <span className="font-mono text-[12.5px] font-medium text-foreground">{pendingSnapshot}</span>
                      </div>
                      <WorkingBar />
                    </td>
                    <td className="px-5 py-3 text-[12.5px] text-muted-foreground">Taking snapshot…</td>
                    <td className="px-5 py-3" />
                    <td className="px-5 py-3" />
                    <td className="px-5 py-3" />
                  </tr>
                )}
                {snapshots.filter((snap) => snap.name !== pendingSnapshot).map((snap: VmSnapshot) => {
                  const isReverting = snap.name === pendingRevert;
                  const isConverting = snap.name === pendingConvert;
                  const isBusy = isReverting || isConverting;
                  const statusLabel = isReverting ? 'Restoring…' : isConverting ? 'Converting to template…' : null;
                  return (
                    <tr key={snap.name} className={isBusy ? 'bg-surface/60' : 'table-row'}>
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-2">
                          {isBusy && <Spinner className="h-3.5 w-3.5 shrink-0" />}
                          <span className="font-mono text-[12.5px] font-medium text-foreground">{snap.name}</span>
                        </div>
                        {isBusy && <WorkingBar />}
                      </td>
                      <td className="whitespace-nowrap px-5 py-2.5 text-[12.5px] tabular-nums text-muted-foreground">
                        {statusLabel ?? formatDateTime(snap.createdAt)}
                      </td>
                      <td className="px-5 py-2.5 text-[12.5px] text-muted-foreground">
                        {isBusy ? '' : snapshotStateLabel(snap.vmState)}
                      </td>
                      <td className="whitespace-nowrap px-5 py-2.5 text-[12.5px] tabular-nums text-foreground">
                        {/* 0 is "not measured", never an empty snapshot: an internal snapshot's figure is its
                            saved memory (none when taken offline), and a failed read also reports 0. */}
                        {isBusy ? '' : (snap.sizeBytes ? formatBytes(snap.sizeBytes) : <span className="text-muted-foreground">Not measured</span>)}
                      </td>
                      <td className="px-5 py-1.5 text-right">
                        {!isBusy && (
                          <div className="inline-flex items-center justify-end gap-0.5">
                            <RowAction
                              label="Convert to template"
                              onClick={() => { setToTemplateTarget(snap.name); setTemplateName(snap.name); }}
                            >
                              <HardDrive size={14} />
                            </RowAction>
                            <RowAction label="Restore this snapshot" onClick={() => setRevertTarget(snap.name)}>
                              <RotateCcw size={14} />
                            </RowAction>
                            <RowAction
                              label="Delete snapshot"
                              danger
                              onClick={() => setDeleteTarget(snap.name)}
                              disabled={deleteSnapshot.isPending}
                            >
                              <Trash2 size={14} />
                            </RowAction>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Create snapshot dialog */}
      <Dialog
        open={createOpen}
        onClose={() => { setCreateOpen(false); setSnapshotName(''); }}
        title="Take snapshot"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => { setCreateOpen(false); setSnapshotName(''); }}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={!snapshotName.trim()}
            >
              Take snapshot
            </Button>
          </>
        }
      >
        <Input
          label="Snapshot name"
          id="snapshot-name"
          placeholder="e.g. pre-update"
          value={snapshotName}
          onChange={(e) => setSnapshotName(e.target.value)}
        />
        <p className="mt-1.5 text-[12px] text-muted-foreground">
          Letters, numbers, hyphens, and underscores only.
        </p>
        {vmStatus === 'running' && (
          <Callout tone="warn" className="mt-3">
            The VM is running - the snapshot will include both disk and memory state.
          </Callout>
        )}
      </Dialog>

      {/* Delete confirmation: a snapshot can't be brought back */}
      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete snapshot"
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)} disabled={deleteSnapshot.isPending}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" onClick={handleDelete} disabled={deleteSnapshot.isPending}>
              {deleteSnapshot.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </>
        }
      >
        <p className="text-[13.5px] leading-6 text-muted-foreground">
          Delete{' '}
          <span className="font-mono text-[13px] font-medium text-foreground">{deleteTarget}</span>?{' '}
          The VM can no longer be restored to this point. This cannot be undone.
        </p>
      </Dialog>

      {/* Revert confirmation dialog */}
      <Dialog
        open={revertTarget !== null}
        onClose={() => setRevertTarget(null)}
        title="Restore snapshot"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setRevertTarget(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" onClick={handleRevert}>
              Restore
            </Button>
          </>
        }
      >
        <p className="text-[13.5px] leading-6 text-muted-foreground">
          Restore{' '}
          <span className="font-mono text-[13px] font-medium text-foreground">{revertTarget}</span>?{' '}
          All changes made since this snapshot was taken will be lost. The VM will be powered off
          and restarted after the restore completes.
        </p>
      </Dialog>

      {/* Convert to template dialog */}
      <Dialog
        open={toTemplateTarget !== null}
        onClose={() => { setToTemplateTarget(null); setTemplateName(''); }}
        title="Convert snapshot to template"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => { setToTemplateTarget(null); setTemplateName(''); }}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleToTemplate} disabled={!templateName.trim()}>
              Convert
            </Button>
          </>
        }
      >
        <p className="mb-4 text-[13.5px] leading-6 text-muted-foreground">
          Snapshot{' '}
          <span className="font-mono text-[13px] font-medium text-foreground">{toTemplateTarget}</span>{' '}
          will be exported as a standalone template image. This may take a few minutes for large disks.
        </p>
        <Input
          label="Template name"
          id="template-name"
          placeholder="e.g. my-base-image"
          value={templateName}
          onChange={(e) => setTemplateName(e.target.value)}
        />
      </Dialog>
    </div>
  );
}

// ─── Network ──────────────────────────────────────────────────────────────────


interface AddPortForwardForm {
  protocol: 'tcp' | 'udp';
  hostPort: string;
  vmPort: string;
  description: string;
}

const defaultPfForm: AddPortForwardForm = { protocol: 'tcp', hostPort: '', vmPort: '', description: '' };

function PortForwardsSection({
  vmUuid,
  networkId,
  networkName,
  mac,
}: {
  vmUuid: string;
  networkId: string;
  networkName: string;
  mac: string;
}) {
  const { data: allForwards = [] } = useVmPortForwards(vmUuid);
  const forwards = allForwards.filter((f) => f.networkId === networkId && f.mac === mac);
  const createForward = useCreatePortForward(networkId);
  const deleteForward = useDeletePortForward(networkId, vmUuid);

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState<AddPortForwardForm>(defaultPfForm);

  const set = (key: keyof AddPortForwardForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleAdd = async () => {
    try {
      await createForward.mutateAsync({
        vmUuid,
        mac,
        protocol: form.protocol,
        hostPort: Number(form.hostPort),
        vmPort: Number(form.vmPort),
        description: form.description || undefined,
      });
      toast.success('Port forward created - DHCP reservation added');
      setAddOpen(false);
      setForm(defaultPfForm);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to create port forward';
      toast.error(msg);
    }
  };

  const addDisabled =
    !form.hostPort ||
    !form.vmPort ||
    createForward.isPending ||
    Number(form.hostPort) < 1 ||
    Number(form.vmPort) < 1;

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Port forwards"
        meta={
          <>
            for <span className="font-mono text-[12px] text-foreground">{mac}</span>
            {' '}on <span className="font-medium text-foreground">{networkName}</span>
          </>
        }
        actions={
          <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
            <Plus size={14} /> Add rule
          </Button>
        }
      />

      {forwards.length === 0 ? (
        <EmptyState compact>No port forwards. Add a rule to expose a service to the internet.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <TableHead columns={['Protocol', 'Host port', 'VM port', 'VM IP', 'Description', '']} />
            <tbody className="divide-y divide-border">
              {forwards.map((fwd: PortForward) => (
                <tr key={fwd.id} className="table-row">
                  <td className="px-5 py-2.5 font-mono text-[12px] font-medium uppercase text-foreground">{fwd.protocol}</td>
                  <td className="px-5 py-2.5 font-mono text-[12.5px] tabular-nums text-foreground">{fwd.hostPort}</td>
                  <td className="px-5 py-2.5 font-mono text-[12.5px] tabular-nums text-muted-foreground">{fwd.vmPort}</td>
                  <td className="px-5 py-2.5 font-mono text-[12px] text-muted-foreground">{fwd.vmIp}</td>
                  <td className="px-5 py-2.5 text-[12.5px] text-muted-foreground">{fwd.description}</td>
                  <td className="px-5 py-1.5 text-right">
                    <RowAction
                      label="Delete rule"
                      danger
                      onClick={async () => {
                        try {
                          await deleteForward.mutateAsync(fwd.id);
                          toast.success('Port forward removed');
                        } catch {
                          toast.error('Failed to remove port forward');
                        }
                      }}
                    >
                      <Trash2 size={14} />
                    </RowAction>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={addOpen}
        onClose={() => { setAddOpen(false); setForm(defaultPfForm); }}
        title="Add port forward"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => { setAddOpen(false); setForm(defaultPfForm); }}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleAdd} disabled={addDisabled}>
              {createForward.isPending ? 'Creating…' : 'Add rule'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Select label="Protocol" id="pf-protocol" value={form.protocol} onChange={set('protocol')}>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
          </Select>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Host port"
              id="pf-host-port"
              type="number"
              min="1"
              max="65535"
              placeholder="e.g. 8080"
              value={form.hostPort}
              onChange={set('hostPort')}
              required
            />
            <Input
              label="VM port"
              id="pf-vm-port"
              type="number"
              min="1"
              max="65535"
              placeholder="e.g. 80"
              value={form.vmPort}
              onChange={set('vmPort')}
              required
            />
          </div>
          <Input
            label="Description (optional)"
            id="pf-description"
            placeholder="e.g. nginx"
            value={form.description}
            onChange={set('description')}
          />
          <Callout>
            A static DHCP reservation will be created for this NIC so its IP stays fixed.
            The VM must be rebooted once for the reservation to take effect if it is already running.
          </Callout>
        </div>
      </Dialog>
    </Panel>
  );
}

function IpCell({
  nic,
  ifAddrs,
  reservations,
  meta,
  networkType,
  networkId,
  vmUuid,
}: {
  nic: VmNic;
  ifAddrs: Record<string, string>;
  reservations: DhcpReservation[];
  meta: VmMeta | null;
  networkType?: string;
  networkId?: string;
  vmUuid: string;
}) {
  const reservation = reservations.find((r) => r.mac === nic.mac);
  const liveIp = ifAddrs[nic.mac];

  // For bridge/static — use meta IP (always known)
  const staticMetaIp = meta?.networks?.find((n) => n.mac === nic.mac && n.ip)?.ip;

  const displayIp = staticMetaIp ?? liveIp ?? reservation?.ip;
  const isReserved = !!reservation;
  const canReserve = networkType === 'nat' && !!networkId && !!liveIp && !isReserved;

  const reserveIp = useReserveIp(networkId ?? '', vmUuid);

  const handleReserve = async () => {
    try {
      await reserveIp.mutateAsync(nic.mac);
      toast.success('IP reserved - this address will persist across reboots');
    } catch (err: unknown) {
      toast.error((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to reserve IP');
    }
  };

  if (!displayIp) {
    return (
      <span className="text-[12.5px] text-muted-foreground">
        {networkType === 'nat' || networkType === 'bridge' || networkType === 'existing-bridge' ? 'DHCP · not resolved yet' : 'Unknown'}
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-mono text-[12.5px] text-foreground">{displayIp}</span>
      {isReserved && (
        <span className="text-[12px] font-medium text-emerald-700 dark:text-emerald-300">
          reserved
        </span>
      )}
      {canReserve && (
        <Tooltip label="Lock this IP via DHCP reservation so it persists across reboots">
          <button
            type="button"
            onClick={handleReserve}
            disabled={reserveIp.isPending}
            className="-my-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-primary transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {reserveIp.isPending ? 'Reserving…' : 'Lock IP'}
          </button>
        </Tooltip>
      )}
    </div>
  );
}

function buildNetplanSnippet(mac: string, network: NetworkConfig, staticIp?: string): string {
  const prefix = network.cidr.split('/')[1];
  const isStatic = (network.type === 'bridge' || network.type === 'existing-bridge') && network.ipMode === 'static' && staticIp;
  const lines = [
    'network:',
    '  version: 2',
    '  ethernets:',
    '    new-nic:',
    `      match:`,
    `        macaddress: "${mac}"`,
    `      set-name: eth1  # rename as needed`,
  ];
  if (isStatic) {
    lines.push(`      addresses:`);
    lines.push(`        - ${staticIp}/${prefix}`);
    if (network.dns.length > 0) {
      lines.push(`      nameservers:`);
      lines.push(`        addresses: [${network.dns.map((d) => `"${d}"`).join(', ')}]`);
    }
  } else {
    lines.push(`      dhcp4: true`);
  }
  return lines.join('\n');
}

// Convert KiB/s ↔ MB/s with two decimal places where needed (libvirt uses KiB/s).
function mbpsFromKbps(kbps: number): string {
  const mb = kbps / 1024;
  return mb >= 10 ? mb.toFixed(0) : mb.toFixed(2).replace(/\.?0+$/, '');
}

function kbpsFromMbpsInput(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n * 1024);
}

function NetworkTab({ vmUuid, nics, meta }: { vmUuid: string; nics: VmNic[]; meta: VmMeta | null }) {
  const [addOpen, setAddOpen] = useState(false);
  const [selectedNetworkId, setSelectedNetworkId] = useState('');
  const [selectedStaticIp, setSelectedStaticIp] = useState('');
  const [addInbound, setAddInbound] = useState('');
  const [addOutbound, setAddOutbound] = useState('');
  const [addedNic, setAddedNic] = useState<{ mac: string; network: NetworkConfig; staticIp?: string } | null>(null);
  const [bandwidthNic, setBandwidthNic] = useState<VmNic | null>(null);
  const [bwInbound, setBwInbound] = useState('');
  const [bwOutbound, setBwOutbound] = useState('');
  const { data: networks } = useNetworks();
  const { data: ifAddrs = {} } = useVmIfAddrs(vmUuid);
  const { data: reservations = [] } = useVmReservations(vmUuid);
  const addNic = useAddNic(vmUuid);
  const detachNic = useDetachNic(vmUuid);
  const setBandwidth = useSetNicBandwidth(vmUuid);
  // Removing a NIC cuts a running VM off that network, so it asks first.
  const [removeNic, setRemoveNic] = useState<VmNic | null>(null);
  const handleRemoveNic = async () => {
    if (!removeNic) return;
    try {
      await detachNic.mutateAsync(removeNic.mac);
      toast.success('NIC removed');
      setRemoveNic(null);
    } catch {
      toast.error('Failed to remove NIC');
    }
  };

  const attachedBridges = new Set(nics.map((n) => n.source));
  const availableNetworks = (networks ?? []).filter((n) => !attachedBridges.has(n.bridge));
  const allAttached = availableNetworks.length === 0 && (networks ?? []).length > 0;
  const selectedNetwork = availableNetworks.find((n) => n.id === selectedNetworkId);
  const isStaticNetwork = selectedNetwork &&
    (selectedNetwork.type === 'bridge' || selectedNetwork.type === 'existing-bridge') &&
    selectedNetwork.ipMode === 'static';

  // Fetch available IPs only when a static network is selected
  const { data: networkDetail } = useNetwork(isStaticNetwork ? selectedNetworkId : '');
  const availableIps = (networkDetail?.ips ?? []).filter((ip) => !ip.allocated);

  const primaryMacs = new Set((meta?.networks ?? []).filter((n) => n.isPrimary).map((n) => n.mac));

  const handleOpen = () => {
    const first = availableNetworks[0];
    setSelectedNetworkId(first?.id ?? '');
    setSelectedStaticIp('');
    setAddInbound('');
    setAddOutbound('');
    setAddedNic(null);
    setAddOpen(true);
  };

  const handleClose = () => {
    setAddOpen(false);
    setSelectedNetworkId('');
    setSelectedStaticIp('');
    setAddInbound('');
    setAddOutbound('');
    setAddedNic(null);
  };

  const openBandwidth = (nic: VmNic) => {
    setBandwidthNic(nic);
    setBwInbound(nic.inboundKbps ? mbpsFromKbps(nic.inboundKbps) : '');
    setBwOutbound(nic.outboundKbps ? mbpsFromKbps(nic.outboundKbps) : '');
  };

  const closeBandwidth = () => {
    setBandwidthNic(null);
    setBwInbound('');
    setBwOutbound('');
  };

  const submitBandwidth = async () => {
    if (!bandwidthNic) return;
    try {
      await setBandwidth.mutateAsync({
        mac: bandwidthNic.mac,
        inboundKbps: kbpsFromMbpsInput(bwInbound),
        outboundKbps: kbpsFromMbpsInput(bwOutbound),
      });
      toast.success('Rate limit updated');
      closeBandwidth();
    } catch {
      toast.error('Failed to update rate limit');
    }
  };

  const handleNetworkSelect = (id: string) => {
    setSelectedNetworkId(id);
    setSelectedStaticIp('');
  };

  const handleAddNic = async () => {
    if (!selectedNetwork) return;
    try {
      const inboundKbps = kbpsFromMbpsInput(addInbound);
      const outboundKbps = kbpsFromMbpsInput(addOutbound);
      const result = await addNic.mutateAsync({
        networkId: selectedNetworkId,
        staticIp: isStaticNetwork ? selectedStaticIp : undefined,
        inboundKbps: inboundKbps > 0 ? inboundKbps : undefined,
        outboundKbps: outboundKbps > 0 ? outboundKbps : undefined,
      });
      setAddedNic({ mac: result.mac, network: selectedNetwork, staticIp: isStaticNetwork ? selectedStaticIp : undefined });
    } catch {
      toast.error('Failed to add NIC');
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <Panel className="overflow-hidden">
          {/* On a host with one or two networks every one is usually attached already:
              the title bar says so in words, beside the disabled button. */}
          <PanelHeader
            title="Network interfaces"
            meta={allAttached ? 'Every network on this host is attached' : undefined}
            actions={
              <Button size="sm" variant="secondary" onClick={handleOpen} disabled={allAttached}>
                <Plus size={14} /> Add NIC
              </Button>
            }
          />

          {nics.length === 0 ? (
            <EmptyState>No network interfaces attached.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <TableHead columns={['MAC address', 'Network', 'IP address', 'Model', 'Rate limit', '']} />
                <tbody className="divide-y divide-border">
                  {nics.map((nic) => {
                    const network = networks?.find((n) => n.bridge === nic.source);
                    const isPrimary = primaryMacs.has(nic.mac);
                    return (
                      <tr key={nic.mac} className="table-row">
                        {/* Cells may wrap (MAC over its marker, name over its type) so the
                            row actions never get pushed out of a narrow panel. */}
                        <td className="px-5 py-2.5">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="whitespace-nowrap font-mono text-[12.5px] font-medium text-foreground">{nic.mac}</span>
                            {isPrimary && (
                              <span className="text-[12px] text-muted-foreground">primary</span>
                            )}
                          </div>
                        </td>
                        <td className="px-5 py-2.5 text-[13px]">
                          {network ? (
                            <span className="flex flex-wrap items-baseline gap-x-1.5">
                              <span className="font-medium text-foreground">{network.name}</span>
                              <span className="text-[12px] text-muted-foreground">
                                {networkTypeLabel(network.type, network.ipMode)}
                              </span>
                            </span>
                          ) : nic.source ? (
                            <span className="font-mono text-[12px] text-muted-foreground">{nic.source}</span>
                          ) : <span className="text-muted-foreground">Unknown</span>}
                        </td>
                        <td className="px-5 py-2.5">
                          <IpCell
                            nic={nic}
                            ifAddrs={ifAddrs}
                            reservations={reservations}
                            meta={meta}
                            networkType={network?.type}
                            networkId={network?.id}
                            vmUuid={vmUuid}
                          />
                        </td>
                        <td className="px-5 py-2.5 font-mono text-[12px] text-muted-foreground">{nic.model}</td>
                        <td className="px-5 py-2.5 text-[12.5px] text-muted-foreground">
                          {nic.inboundKbps || nic.outboundKbps ? (
                            <span className="whitespace-nowrap text-[12.5px] tabular-nums text-foreground">
                              ↓ {nic.inboundKbps ? `${mbpsFromKbps(nic.inboundKbps)} MB/s` : 'unlimited'}
                              <span className="text-muted-foreground">{' · '}</span>
                              ↑ {nic.outboundKbps ? `${mbpsFromKbps(nic.outboundKbps)} MB/s` : 'unlimited'}
                            </span>
                          ) : (
                            'unlimited'
                          )}
                        </td>
                        <td className="whitespace-nowrap px-5 py-1.5 text-right">
                          <div className="inline-flex items-center justify-end gap-0.5">
                            <RowAction label="Edit rate limit" onClick={() => openBandwidth(nic)}>
                              <Gauge size={14} />
                            </RowAction>
                            <RowAction label="Remove NIC" danger onClick={() => setRemoveNic(nic)}>
                              <Trash2 size={14} />
                            </RowAction>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Dialog
          open={removeNic !== null}
          onClose={() => setRemoveNic(null)}
          title="Remove network interface"
          size="sm"
          footer={
            <>
              <Button variant="secondary" size="sm" onClick={() => setRemoveNic(null)} disabled={detachNic.isPending}>
                Cancel
              </Button>
              <Button size="sm" variant="danger" onClick={handleRemoveNic} disabled={detachNic.isPending}>
                {detachNic.isPending ? 'Removing…' : 'Remove'}
              </Button>
            </>
          }
        >
          <p className="text-[13.5px] leading-6 text-muted-foreground">
            Remove <span className="font-mono text-[13px] font-medium text-foreground">{removeNic?.mac}</span>
            {removeNic?.source && (
              <> from <span className="font-medium text-foreground">{networks?.find((n) => n.bridge === removeNic.source)?.name ?? removeNic.source}</span></>
            )}?{' '}
            A running VM loses this connection at once.
          </p>
        </Dialog>

        {/* Port forward sections — one per NAT NIC */}
        {nics.map((nic) => {
          const network = networks?.find((n) => n.bridge === nic.source);
          if (!network || network.type !== 'nat') return null;
          return (
            <PortForwardsSection
              key={nic.mac}
              vmUuid={vmUuid}
              networkId={network.id}
              networkName={network.name}
              mac={nic.mac}
            />
          );
        })}
      </div>

      <Dialog
        open={addOpen}
        onClose={handleClose}
        title={addedNic ? 'NIC attached' : 'Add network interface'}
        footer={
          addedNic ? (
            <Button size="sm" onClick={handleClose}>Done</Button>
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={handleClose}>Cancel</Button>
              <Button
                size="sm"
                onClick={handleAddNic}
                disabled={!selectedNetworkId || addNic.isPending || (!!isStaticNetwork && !selectedStaticIp)}
              >
                {addNic.isPending ? 'Adding…' : 'Add NIC'}
              </Button>
            </>
          )
        }
      >
        {addedNic ? (
          // ── Success: show config snippet ───────────────────────────────────
          <div className="space-y-3">
            <p className="text-[13.5px] text-foreground">
              <span className="font-semibold">{addedNic.network.name}</span> attached with MAC{' '}
              <span className="font-mono text-[12.5px]">{addedNic.mac}</span>.
            </p>
            <p className="text-[12.5px] leading-5 text-muted-foreground">
              Cloud-init will not run again for this NIC - configure it inside the VM using your OS's
              network tools. The example below is for <span className="font-medium text-foreground">Ubuntu / Debian</span> (netplan);
              adapt as needed for other distributions or Windows.
            </p>
            <div className="relative">
              <pre className="overflow-x-auto rounded-md border border-border bg-surface px-4 py-3 font-mono text-[12px] leading-relaxed text-foreground">
                {buildNetplanSnippet(addedNic.mac, addedNic.network, addedNic.staticIp)}
              </pre>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(buildNetplanSnippet(addedNic.mac, addedNic.network, addedNic.staticIp));
                  toast.success('Copied to clipboard');
                }}
                className="absolute right-2 top-2 inline-flex h-7 items-center gap-1.5 rounded-md border border-input bg-card px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-surface"
              >
                <Copy className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                Copy
              </button>
            </div>
          </div>
        ) : availableNetworks.length === 0 ? (
          <p className="text-[13.5px] text-muted-foreground">All configured networks are already attached to this VM.</p>
        ) : (
          // ── Idle: network + IP picker ──────────────────────────────────────
          <div className="space-y-4">
            <div className="space-y-2">
              {availableNetworks.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  aria-pressed={selectedNetworkId === n.id}
                  onClick={() => handleNetworkSelect(n.id)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
                    selectedNetworkId === n.id
                      ? 'border-primary bg-accent ring-1 ring-primary/30'
                      : 'border-border bg-card hover:border-muted-foreground/40'
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-semibold text-foreground">{n.name}</p>
                    <p className="mt-0.5 font-mono text-[12px] text-muted-foreground">
                      {n.cidr} · br: {n.bridge}
                    </p>
                  </div>
                  <span className="shrink-0 text-[12px] font-medium text-muted-foreground">
                    {networkTypeLabel(n.type, n.ipMode)}
                  </span>
                </button>
              ))}
            </div>
            {isStaticNetwork && (
              <Select
                label="IP address"
                id="add-nic-ip"
                value={selectedStaticIp}
                onChange={(e) => setSelectedStaticIp(e.target.value)}
              >
                <option value="">Select an IP…</option>
                {availableIps.map((ip) => (
                  <option key={ip.ip} value={ip.ip}>{ip.ip}</option>
                ))}
              </Select>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Inbound limit (MB/s)"
                id="add-nic-inbound"
                placeholder="unlimited"
                inputMode="decimal"
                value={addInbound}
                onChange={(e) => setAddInbound(e.target.value)}
              />
              <Input
                label="Outbound limit (MB/s)"
                id="add-nic-outbound"
                placeholder="unlimited"
                inputMode="decimal"
                value={addOutbound}
                onChange={(e) => setAddOutbound(e.target.value)}
              />
            </div>
            <Callout tone="warn">
              Cloud-init will not configure this NIC automatically. Configuration steps will be shown after adding.
            </Callout>
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!bandwidthNic}
        onClose={closeBandwidth}
        title="Rate limit"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={closeBandwidth}>Cancel</Button>
            <Button size="sm" onClick={submitBandwidth} disabled={setBandwidth.isPending}>
              {setBandwidth.isPending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-[13px] leading-5 text-muted-foreground">
            Cap traffic on{' '}
            <span className="font-mono text-[12.5px] text-foreground">{bandwidthNic?.mac}</span>. Leave a field blank for
            unlimited. Inbound and outbound are from the guest's perspective. Limits apply live and persist
            across reboots.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Inbound (MB/s)"
              id="bw-inbound"
              placeholder="unlimited"
              inputMode="decimal"
              value={bwInbound}
              onChange={(e) => setBwInbound(e.target.value)}
            />
            <Input
              label="Outbound (MB/s)"
              id="bw-outbound"
              placeholder="unlimited"
              inputMode="decimal"
              value={bwOutbound}
              onChange={(e) => setBwOutbound(e.target.value)}
            />
          </div>
          <p className="text-[12px] text-muted-foreground">
            libvirt enforces these via Linux tc (token bucket). Useful for fairness; not strict policing.
          </p>
        </div>
      </Dialog>
    </div>
  );
}

// ─── Firewall ─────────────────────────────────────────────────────────────────

// crypto.randomUUID() requires HTTPS; this fallback works over HTTP too
function genId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const FW_PROTOCOLS = ['tcp', 'udp', 'icmp', 'all'] as const;
const FW_ACTIONS = ['allow', 'drop'] as const;
const FW_ICMP_TYPES = [
  { value: '', label: 'Any type' },
  { value: 'echo-request', label: 'Echo Request (ping in)' },
  { value: 'echo-reply', label: 'Echo Reply (ping out)' },
  { value: 'destination-unreachable', label: 'Destination Unreachable' },
  { value: 'time-exceeded', label: 'Time Exceeded (TTL)' },
  { value: 'redirect', label: 'Redirect' },
] as const;

interface RuleForm {
  protocol: 'tcp' | 'udp' | 'icmp' | 'all';
  portRange: string;
  source: string;
  destination: string;
  icmpType: string;
  action: 'allow' | 'drop';
  description: string;
}

const defaultRuleForm: RuleForm = {
  protocol: 'tcp',
  portRange: '',
  source: '',
  destination: '',
  icmpType: '',
  action: 'allow',
  description: '',
};

const emptyFirewallConfig: FirewallConfig = {
  rules: [],
  defaultInbound: 'allow',
  defaultOutbound: 'allow',
};

function FirewallRulesTable({
  rules,
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
  isPending,
  emptyLabel,
}: {
  rules: FirewallRule[];
  onEdit: (rule: FirewallRule) => void;
  onDelete: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  isPending: boolean;
  emptyLabel: string;
}) {
  if (rules.length === 0) {
    return <EmptyState compact>{emptyLabel}</EmptyState>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <TableHead columns={['#', 'Protocol', 'Port / type', 'Source / dest', 'Action', 'Description', '']} pad="px-4 first:pl-5 last:pr-5" />
        <tbody className="divide-y divide-border">
          {rules.map((rule, idx) => (
            <tr key={rule.id} className="table-row">
              <td className="py-2.5 pl-5 pr-4 font-mono text-[12px] tabular-nums text-muted-foreground">{idx + 1}</td>
              <td className="px-4 py-2.5 font-mono text-[12px] font-medium uppercase text-foreground">{rule.protocol}</td>
              <td className="px-4 py-2.5 font-mono text-[12px] text-muted-foreground">
                {rule.protocol === 'icmp' ? (rule.icmpType ?? 'any') : (rule.portRange ?? 'any')}
              </td>
              <td className="px-4 py-2.5 font-mono text-[12px] text-muted-foreground">{rule.source ?? rule.destination ?? 'any'}</td>
              <td className="px-4 py-2.5">
                <span className={cn(
                  'text-[12.5px] font-medium capitalize',
                  rule.action === 'allow'
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : 'text-red-700 dark:text-red-300'
                )}>
                  {rule.action}
                </span>
              </td>
              <td className="px-4 py-2.5 text-[12.5px] text-muted-foreground">{rule.description}</td>
              <td className="py-1.5 pl-4 pr-5 text-right">
                <div className="inline-flex items-center justify-end gap-0.5">
                  <RowAction label="Move up" onClick={() => onMoveUp(rule.id)} disabled={isPending || idx === 0}>
                    <ChevronUp size={15} />
                  </RowAction>
                  <RowAction label="Move down" onClick={() => onMoveDown(rule.id)} disabled={isPending || idx === rules.length - 1}>
                    <ChevronDown size={15} />
                  </RowAction>
                  <RowAction label="Edit rule" onClick={() => onEdit(rule)} disabled={isPending}>
                    <Pencil size={14} />
                  </RowAction>
                  <RowAction label="Remove rule" danger onClick={() => onDelete(rule.id)} disabled={isPending}>
                    <Trash2 size={14} />
                  </RowAction>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FirewallTab({ vmUuid, vmStatus }: { vmUuid: string; vmStatus: VmStatus }) {
  const [addDirection, setAddDirection] = useState<'inbound' | 'outbound' | null>(null);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [form, setForm] = useState<RuleForm>(defaultRuleForm);
  const { data: cfg, isLoading } = useVmFirewall(vmUuid);
  const saveFirewall = useSaveFirewall(vmUuid);
  const applyFirewall = useApplyFirewall(vmUuid);

  const current = cfg ?? emptyFirewallConfig;
  const portlessProtocol = form.protocol === 'icmp' || form.protocol === 'all';
  const portRangeValid =
    portlessProtocol || !form.portRange.trim() || /^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(form.portRange.trim());

  const setField = (key: keyof RuleForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value = e.target.value;
      setForm((f) => {
        const next = { ...f, [key]: value };
        if (key === 'protocol') {
          if (value === 'icmp' || value === 'all') next.portRange = '';
          if (value !== 'icmp') next.icmpType = '';
        }
        return next;
      });
    };

  const handleSetDefault = async (
    direction: 'inbound' | 'outbound',
    value: 'allow' | 'drop'
  ) => {
    const establishedKey = direction === 'inbound' ? 'allowEstablishedInbound' : 'allowEstablishedOutbound';
    const updated: FirewallConfig = {
      ...current,
      ...(direction === 'inbound' ? { defaultInbound: value } : { defaultOutbound: value }),
      // auto-enable when switching to drop (prevents cutting off return traffic),
      // auto-disable when switching to allow (redundant with catch-all accept)
      [establishedKey]: value === 'drop',
    };
    try {
      await saveFirewall.mutateAsync(updated);
      toast.success(`${direction === 'inbound' ? 'Inbound' : 'Outbound'} default policy updated`);
    } catch {
      toast.error('Failed to update default policy');
    }
  };

  const closeDialog = () => {
    setAddDirection(null);
    setEditingRuleId(null);
    setForm(defaultRuleForm);
  };

  const handleEditOpen = (rule: FirewallRule) => {
    setForm({
      protocol: rule.protocol,
      portRange: rule.portRange ?? '',
      source: rule.source ?? '',
      destination: rule.destination ?? '',
      icmpType: rule.icmpType ?? '',
      action: rule.action,
      description: rule.description ?? '',
    });
    setAddDirection(rule.direction);
    setEditingRuleId(rule.id);
  };

  const handleMoveRule = async (id: string, dir: 'up' | 'down') => {
    const rules = [...current.rules];
    const idx = rules.findIndex((r) => r.id === id);
    if (idx === -1) return;
    const direction = rules[idx].direction;
    let swapIdx = -1;
    if (dir === 'up') {
      for (let i = idx - 1; i >= 0; i--) {
        if (rules[i].direction === direction) { swapIdx = i; break; }
      }
    } else {
      for (let i = idx + 1; i < rules.length; i++) {
        if (rules[i].direction === direction) { swapIdx = i; break; }
      }
    }
    if (swapIdx === -1) return;
    [rules[idx], rules[swapIdx]] = [rules[swapIdx], rules[idx]];
    try {
      await saveFirewall.mutateAsync({ ...current, rules });
    } catch {
      toast.error('Failed to reorder rules');
    }
  };

  const handleSetEstablished = async (direction: 'inbound' | 'outbound', value: boolean) => {
    const updated: FirewallConfig = {
      ...current,
      ...(direction === 'inbound' ? { allowEstablishedInbound: value } : { allowEstablishedOutbound: value }),
    };
    try {
      await saveFirewall.mutateAsync(updated);
      toast.success(`${direction === 'inbound' ? 'Inbound' : 'Outbound'} established connections ${value ? 'allowed' : 'blocked'}`);
    } catch {
      toast.error('Failed to update policy');
    }
  };

  const handleAddRule = async () => {
    if (!addDirection) return;
    if (!portRangeValid) return;
    const newRule: FirewallRule = {
      id: genId(),
      direction: addDirection,
      protocol: form.protocol,
      portRange: form.portRange.trim() || undefined,
      source: addDirection === 'inbound' ? (form.source.trim() || undefined) : undefined,
      destination: addDirection === 'outbound' ? (form.destination.trim() || undefined) : undefined,
      icmpType: form.protocol === 'icmp' ? (form.icmpType || undefined) : undefined,
      action: form.action,
      description: form.description.trim() || undefined,
    };
    try {
      await saveFirewall.mutateAsync({ ...current, rules: [...current.rules, newRule] });
      toast.success(`${addDirection === 'inbound' ? 'Inbound' : 'Outbound'} rule added`);
      closeDialog();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to save rule';
      toast.error(msg);
    }
  };

  const handleSaveEdit = async () => {
    if (!editingRuleId || !addDirection) return;
    if (!portRangeValid) return;
    const updatedRule: FirewallRule = {
      id: editingRuleId,
      direction: addDirection,
      protocol: form.protocol,
      portRange: form.portRange.trim() || undefined,
      source: addDirection === 'inbound' ? (form.source.trim() || undefined) : undefined,
      destination: addDirection === 'outbound' ? (form.destination.trim() || undefined) : undefined,
      icmpType: form.protocol === 'icmp' ? (form.icmpType || undefined) : undefined,
      action: form.action,
      description: form.description.trim() || undefined,
    };
    try {
      await saveFirewall.mutateAsync({
        ...current,
        rules: current.rules.map((r) => (r.id === editingRuleId ? updatedRule : r)),
      });
      toast.success('Rule updated');
      closeDialog();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to save rule';
      toast.error(msg);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await saveFirewall.mutateAsync({ ...current, rules: current.rules.filter((r) => r.id !== id) });
      toast.success('Rule removed');
    } catch {
      toast.error('Failed to remove rule');
    }
  };

  const handleApply = async () => {
    try {
      await applyFirewall.mutateAsync();
      toast.success('Firewall rules applied');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to apply rules';
      toast.error(msg);
    }
  };

  const inboundRules = current.rules.filter((r) => r.direction === 'inbound');
  const outboundRules = current.rules.filter((r) => r.direction === 'outbound');

  return (
    <div className="space-y-6">
      {/* Header */}
      <SectionHeading label="Firewall">
        <Tooltip
          label={
            vmStatus !== 'running'
              ? 'VM must be running to apply rules'
              : 'Apply saved rules to the running VM via iptables'
          }
        >
          <Button
            size="sm"
            variant="secondary"
            onClick={handleApply}
            disabled={applyFirewall.isPending || vmStatus !== 'running'}
          >
            <Shield size={14} />
            {applyFirewall.isPending ? 'Applying…' : 'Apply rules'}
          </Button>
        </Tooltip>
      </SectionHeading>

      {/* Default Policies */}
      <Panel>
        <PanelHeader title="Default policies" />
        <div className="space-y-4 px-5 py-4">
          <p className="text-[12.5px] leading-5 text-muted-foreground">
            Applied after all explicit rules. Set to <span className="font-medium text-foreground">Drop all</span> to
            block unmatched traffic, then add <span className="font-medium text-foreground">Allow</span> rules for
            permitted ports.
          </p>
          {isLoading ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <Skeleton className="h-[60px]" />
                <Skeleton className="h-[60px]" />
              </div>
              <Skeleton className="h-9" />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <Select
                  label="Inbound default"
                  id="fw-default-inbound"
                  value={current.defaultInbound}
                  onChange={(e) => handleSetDefault('inbound', e.target.value as 'allow' | 'drop')}
                  disabled={saveFirewall.isPending}
                >
                  <option value="allow">Allow all</option>
                  <option value="drop">Drop all</option>
                </Select>
                <Select
                  label="Outbound default"
                  id="fw-default-outbound"
                  value={current.defaultOutbound}
                  onChange={(e) => handleSetDefault('outbound', e.target.value as 'allow' | 'drop')}
                  disabled={saveFirewall.isPending}
                >
                  <option value="allow">Allow all</option>
                  <option value="drop">Drop all</option>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                {(['inbound', 'outbound'] as const).map((dir) => {
                  const defaultIsAllow = dir === 'inbound' ? current.defaultInbound === 'allow' : current.defaultOutbound === 'allow';
                  const isDisabled = saveFirewall.isPending || defaultIsAllow;
                  return (
                    // Unavailable reads as muted text on the recess, not as faded text:
                    // it has to stay legible to explain why it's off.
                    <label
                      key={dir}
                      className={cn(
                        'flex h-9 items-center gap-2.5 rounded-md border px-3 text-[12.5px] transition-colors',
                        isDisabled
                          ? 'cursor-not-allowed border-border bg-surface text-muted-foreground'
                          : 'cursor-pointer border-input bg-card text-foreground hover:border-muted-foreground/40'
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={dir === 'inbound' ? (current.allowEstablishedInbound ?? false) : (current.allowEstablishedOutbound ?? false)}
                        onChange={(e) => handleSetEstablished(dir, e.target.checked)}
                        disabled={isDisabled}
                        className="shrink-0"
                      />
                      Allow established & related ({dir})
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </Panel>

      {/* Inbound Rules */}
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Inbound rules"
          meta={<span className="tabular-nums">{inboundRules.length}</span>}
          actions={
            <Button size="sm" variant="secondary" onClick={() => { setForm(defaultRuleForm); setEditingRuleId(null); setAddDirection('inbound'); }}>
              <Plus size={14} /> Add rule
            </Button>
          }
        />
        {isLoading ? (
          <div className="p-5"><Skeleton className="h-12" /></div>
        ) : (
          <FirewallRulesTable
            rules={inboundRules}
            onEdit={handleEditOpen}
            onDelete={handleDelete}
            onMoveUp={(id) => handleMoveRule(id, 'up')}
            onMoveDown={(id) => handleMoveRule(id, 'down')}
            isPending={saveFirewall.isPending}
            emptyLabel="No inbound rules - traffic follows the default inbound policy."
          />
        )}
      </Panel>

      {/* Outbound Rules */}
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Outbound rules"
          meta={<span className="tabular-nums">{outboundRules.length}</span>}
          actions={
            <Button size="sm" variant="secondary" onClick={() => { setForm(defaultRuleForm); setEditingRuleId(null); setAddDirection('outbound'); }}>
              <Plus size={14} /> Add rule
            </Button>
          }
        />
        {isLoading ? (
          <div className="p-5"><Skeleton className="h-12" /></div>
        ) : (
          <FirewallRulesTable
            rules={outboundRules}
            onEdit={handleEditOpen}
            onDelete={handleDelete}
            onMoveUp={(id) => handleMoveRule(id, 'up')}
            onMoveDown={(id) => handleMoveRule(id, 'down')}
            isPending={saveFirewall.isPending}
            emptyLabel="No outbound rules - traffic follows the default outbound policy."
          />
        )}
      </Panel>

      {/* Add / Edit Rule Dialog */}
      <Dialog
        open={addDirection !== null}
        onClose={closeDialog}
        title={`${editingRuleId ? 'Edit' : 'Add'} ${addDirection === 'inbound' ? 'inbound' : 'outbound'} rule`}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={editingRuleId ? handleSaveEdit : handleAddRule}
              disabled={saveFirewall.isPending || !portRangeValid}
            >
              {saveFirewall.isPending ? 'Saving…' : editingRuleId ? 'Save changes' : 'Add rule'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Select label="Action" id="fw-rule-action" value={form.action} onChange={setField('action')}>
              {FW_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a.charAt(0).toUpperCase() + a.slice(1)}
                </option>
              ))}
            </Select>
            <Select label="Protocol" id="fw-rule-protocol" value={form.protocol} onChange={setField('protocol')}>
              {FW_PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {p.toUpperCase()}
                </option>
              ))}
            </Select>
          </div>
          {form.protocol === 'icmp' ? (
            <Select label="ICMP type" id="fw-rule-icmp" value={form.icmpType} onChange={setField('icmpType')}>
              {FW_ICMP_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </Select>
          ) : (
            <Input
              label="Port / range (leave blank for any)"
              id="fw-rule-port"
              placeholder="e.g. 22, 80,443, or 8000-9000"
              value={form.portRange}
              onChange={setField('portRange')}
              disabled={form.protocol === 'all'}
              error={!portRangeValid ? 'A port or range, e.g. 22, 80,443 or 8000-9000' : undefined}
            />
          )}
          {addDirection !== null && (
            <Input
              label={addDirection === 'inbound' ? 'Source address (optional)' : 'Destination address (optional)'}
              id="fw-rule-address"
              placeholder="e.g. 192.168.1.0/24"
              value={addDirection === 'inbound' ? form.source : form.destination}
              onChange={setField(addDirection === 'inbound' ? 'source' : 'destination')}
            />
          )}
          <Input
            label="Description (optional)"
            id="fw-rule-description"
            placeholder="e.g. Allow SSH"
            value={form.description}
            onChange={setField('description')}
          />
        </div>
      </Dialog>
    </div>
  );
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

const fmtBps = formatRate;

type ChartRange = 'live' | VmMetricsRange;

interface ChartPoint {
  ts: number;
  cpuPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  diskReadBps: number;
  diskWriteBps: number;
  netRxBps: number;
  netTxBps: number;
}


function MetricsTab({ vmUuid, vmStatus }: { vmUuid: string; vmStatus: VmStatus }) {
  const isRunning = vmStatus === 'running';
  const { data: stats, isError } = useVmStats(vmUuid, isRunning);

  const [range, setRange] = useState<ChartRange>('1h');
  const historyEnabled = range !== 'live';
  const { data: metrics } = useVmMetricsHistory(
    vmUuid,
    range === 'live' ? '1h' : range,
    historyEnabled,
  );

  const liveHistory = stats?.history ?? [];
  const current = stats?.current;

  const points: ChartPoint[] = range === 'live'
    ? liveHistory.map((s) => ({ ...s, ts: s.timestamp }))
    : (metrics?.history ?? []);

  const timestamps = points.map((s) => s.ts);
  const cpuData = points.map((s) => s.cpuPercent);
  const memData = points.map((s) => (s.memTotalMb > 0 ? (s.memUsedMb / s.memTotalMb) * 100 : 0));
  const diskRdData = points.map((s) => s.diskReadBps);
  const diskWrData = points.map((s) => s.diskWriteBps);
  const netRxData = points.map((s) => s.netRxBps);
  const netTxData = points.map((s) => s.netTxBps);
  const formatX = (ts: number) => formatChartTime(ts, range);
  const formatTime = (ts: number) => formatChartMoment(ts, range);
  // An idle guest's I/O is all zeros, and the chart's auto-scale then picks a 0–1 B/s
  // axis whose rounded labels repeat ("1 B/s, 1 B/s, 1 B/s, 0 B/s"). Byte-rate axes get
  // a 1 KB/s floor instead; anything busier keeps the automatic scale.
  const ioAxisMax = (...series: number[][]): number | undefined =>
    series.reduce((peak, s) => s.reduce((m, v) => (v > m ? v : m), peak), 0) < 1024 ? 1024 : undefined;

  if (!isRunning) {
    return <MetricsNotice title="VM is not running" detail="Start the VM to view per-VM metrics." />;
  }

  if (isError || (!current && !liveHistory.length)) {
    return <MetricsNotice title="Metrics unavailable" detail="Waiting for first sample…" />;
  }

  return (
    <div className="space-y-7">

      <section className="space-y-3.5">
        {/* Range selector */}
        <SectionHeading label="History">
          <div className="segmented" role="group" aria-label="Time range">
            {(['live', '1h', '24h', '7d', '30d'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                aria-pressed={range === r}
              >
                {r === 'live' ? 'Live' : r}
              </button>
            ))}
          </div>
        </SectionHeading>

        {/* Charts */}
        {points.length > 1 ? (
          <div className="flex flex-col gap-4">
            <ChartCard
              formatTime={formatTime}
              title="CPU usage"
              data={cpuData}
              timestamps={timestamps}
              color={CHART.cpu}
              max={100}
              formatY={(v) => `${Math.round(v)}%`}
              formatX={formatX}
            />
            <ChartCard
              formatTime={formatTime}
              title="Memory usage"
              data={memData}
              timestamps={timestamps}
              color={CHART.memory}
              max={100}
              formatY={(v) => `${Math.round(v)}%`}
              formatX={formatX}
            />
            <ChartCard
              formatTime={formatTime}
              title="Disk I/O"
              data={diskRdData}
              data2={diskWrData}
              timestamps={timestamps}
              color={CHART.inbound}
              color2={CHART.outbound}
              legend={['Read', 'Write']}
              formatY={fmtBps}
              formatX={formatX}
              max={ioAxisMax(diskRdData, diskWrData)}
            />
            <ChartCard
              formatTime={formatTime}
              title="Network I/O"
              data={netRxData}
              data2={netTxData}
              timestamps={timestamps}
              color={CHART.inbound}
              color2={CHART.outbound}
              legend={['RX', 'TX']}
              formatY={fmtBps}
              formatX={formatX}
              max={ioAxisMax(netRxData, netTxData)}
            />
          </div>
        ) : (
          <Panel className="flex flex-col items-center justify-center px-6 py-12 text-center">
            <p className="text-[13.5px] font-medium text-foreground">No samples yet</p>
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              {range === 'live'
                ? 'Waiting for live samples…'
                : 'Metrics are sampled every 30 seconds. History will appear shortly.'}
            </p>
          </Panel>
        )}
      </section>
    </div>
  );
}

// A whole-tab notice: centred in a panel, a plain muted icon at most.
function MetricsNotice({ title, detail }: { title: string; detail: string }) {
  return (
    <Panel className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <Activity className="h-5 w-5 text-muted-foreground" aria-hidden />
      <p className="mt-3 text-[13.5px] font-medium text-foreground">{title}</p>
      <p className="mt-1 text-[12.5px] text-muted-foreground">{detail}</p>
    </Panel>
  );
}

// A legend entry drawn the way the series is drawn: solid, or dashed for the outbound one.
function LegendLine({ color, label, value, dashed }: { color: string; label: string; value?: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-[12px] text-muted-foreground">
      <svg width="16" height="8" aria-hidden className="shrink-0">
        <line
          x1="1" y1="4" x2="15" y2="4"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={dashed ? '4 3' : undefined}
        />
      </svg>
      {label}
      {value && <span className="font-medium tabular-nums text-foreground">{value}</span>}
    </span>
  );
}

function ChartCard({
  title, data, data2, timestamps, color, color2, legend, formatY, formatX, formatTime, max,
}: {
  title: string;
  data: number[];
  data2?: number[];
  timestamps: number[];
  color: string;
  color2?: string;
  legend?: string[];
  formatY: (v: number) => string;
  formatX: (ts: number) => string;
  formatTime?: (ts: number) => string;
  max?: number;
}) {
  const last = data[data.length - 1];
  const last2 = data2?.[data2.length - 1];

  // Same title bar as the dashboard's host charts: the name on the left, the latest
  // reading on the right — one big number, or each series beside its legend line.
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title={title}
        actions={
          legend && color2 && last2 != null ? (
            <span className="flex items-center gap-4">
              <LegendLine color={color} label={legend[0]} value={formatY(last)} />
              <LegendLine color={color2} label={legend[1]} value={formatY(last2)} dashed />
            </span>
          ) : !legend && last != null ? (
            <span className="whitespace-nowrap text-[18px] font-semibold tracking-[-0.015em] tabular-nums text-foreground">
              {formatY(last)}
            </span>
          ) : undefined
        }
      />
      <div className="px-4 pb-3 pt-4">
        <MetricChart
          data={data}
          data2={data2}
          timestamps={timestamps}
          color={color}
          color2={color2}
          formatY={formatY}
          formatX={formatX}
          formatTime={formatTime}
          labels={legend ? [legend[0], legend[1]] : undefined}
          max={max}
        />
      </div>
    </Panel>
  );
}
