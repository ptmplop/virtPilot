import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowLeft, ArrowUp, Camera, Check, ChevronDown, ChevronUp,
  Copy, Cpu, Disc, Download, Eye, EyeOff, Gauge, HardDrive, MemoryStick, Network, Pencil, Plus,
  Power, PowerOff, RotateCcw, Server, Shield, Terminal, Trash2, Usb, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { StatusDot } from '@/components/ui/Badge';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  useVm, useVmMeta, useVmCredentials, useVmAction, useAddDisk, useDetachDisk,
  useAttachCdrom, useDetachCdrom, useAddNic, useDetachNic, useSetNicBandwidth,
  useSetBootOrder, useBootOnce,
  useSnapshots, useCreateSnapshot, useDeleteSnapshot, useRevertSnapshot, useSnapshotToTemplate,
  useVmIfAddrs, useVmReservations,
  useVmFirewall, useSaveFirewall, useApplyFirewall,
  useSetAutostart, useResizeDisk, useUpdateVmResources, useVmStats, useVmMetricsHistory,
  useRenameVm,
} from '@/hooks/useVms';
import type { VmMetricsRange } from '@/types';
import { useHostDevices, useAttachDevice, useDetachDevice } from '@/hooks/useDevices';
import { useDownloadVmDisk } from '@/hooks/useVmDisks';
import { useVmPortForwards, useCreatePortForward, useDeletePortForward, useReserveIp } from '@/hooks/usePortForwards';
import { useIsos } from '@/hooks/useIsos';
import { useNetworks, useNetwork } from '@/hooks/useNetworks';
import { formatMemory, formatDisk, formatBytes } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { DhcpReservation, FirewallConfig, FirewallRule, HostDevice, Network as NetworkConfig, PortForward, VmDisk, VmMeta, VmNic, VmSnapshot, VmStatus } from '@/types';
import { useLogoStore } from '@/store/logoStore';
import { useVmOpsStore } from '@/store/vmOpsStore';

type Tab = 'overview' | 'disks' | 'network' | 'snapshots' | 'firewall' | 'devices' | 'metrics';

const isSeedIso = (d: VmDisk): boolean => !!d.source?.endsWith('-seed.iso');

const statusLabels: Record<VmStatus, string> = {
  running: 'Active',
  stopped: 'Off',
  paused: 'Paused',
  crashed: 'Crashed',
  unknown: 'Unknown',
};

const statusTextColour: Record<VmStatus, string> = {
  running: 'text-emerald-500 dark:text-emerald-400',
  stopped: 'text-slate-500 dark:text-slate-400',
  paused: 'text-amber-500 dark:text-amber-400',
  crashed: 'text-red-500 dark:text-red-400',
  unknown: 'text-muted-foreground',
};

export function VmDetailPage() {
  const { uuid } = useParams<{ uuid: string }>();
  const [tab, setTab] = useState<Tab>('overview');
  const { data: vm, isLoading } = useVm(uuid!);
  const { data: metaData } = useVmMeta(uuid!);
  const vmMeta = metaData?.meta ?? null;
  const action = useVmAction(uuid!);

  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const rename = useRenameVm(uuid!);

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
    } catch {
      toast.error(`Failed to ${a}`);
    }
  };

  return (
    <Layout>
      {/* Breadcrumb */}
      <div className="mb-6">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Virtual Machines
        </Link>
      </div>

      {isLoading ? (
        <div className="space-y-5">
          <Skeleton className="h-14 w-72 rounded-xl" />
          <Skeleton className="h-10 w-full max-w-xs rounded-lg" />
          <Skeleton className="h-10 rounded-lg" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : !vm ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
            <Server className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="text-sm font-semibold text-foreground">VM not found</p>
          <p className="mt-1 text-xs text-muted-foreground">
            "{uuid}" does not exist or has been deleted.
          </p>
          <Link to="/" className="mt-5">
            <Button size="sm" variant="secondary">
              <ArrowLeft size={13} /> Back to list
            </Button>
          </Link>
        </div>
      ) : (
        <>
          {/* Hero */}
          <div className="mb-8 flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <div
                className={cn(
                  'flex h-12 w-12 shrink-0 items-center justify-center rounded-xl',
                  vm.status === 'running' ? 'bg-emerald-500/10' : 'bg-muted'
                )}
              >
                <Server
                  className={cn(
                    'h-5 w-5',
                    vm.status === 'running'
                      ? 'text-emerald-500 dark:text-emerald-400'
                      : 'text-muted-foreground'
                  )}
                />
              </div>
              <div>
                {renaming ? (
                  <div className="flex items-center gap-2">
                    <Input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRenameSubmit();
                        if (e.key === 'Escape') handleRenameCancel();
                      }}
                      className="h-8 w-52 text-sm font-bold"
                    />
                    <Button size="sm" onClick={handleRenameSubmit} disabled={rename.isPending}>
                      {rename.isPending ? <Spinner className="h-3 w-3" /> : 'Save'}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={handleRenameCancel} disabled={rename.isPending}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <h1 className="text-2xl font-bold tracking-tight text-foreground">{vm.name}</h1>
                    {vm.status === 'stopped' && (
                      <Tooltip label="Rename VM">
                        <button
                          type="button"
                          onClick={handleRenameStart}
                          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <Pencil size={13} />
                        </button>
                      </Tooltip>
                    )}
                  </div>
                )}
                <div className="mt-1 flex items-center gap-2">
                  <StatusDot status={vm.status} />
                  <span className={cn('text-sm font-medium', statusTextColour[vm.status])}>
                    {statusLabels[vm.status]}
                  </span>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-sm text-muted-foreground">
                    {vm.cpus} {vm.cpus === 1 ? 'vCPU' : 'vCPUs'} · {formatMemory(vm.memoryMb)} · KVM
                  </span>
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {vm.status === 'stopped' && (
                <Button size="sm" onClick={() => handleAction('start')} disabled={action.isPending}>
                  <Power size={13} /> Power On
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
                      <RotateCcw size={13} /> Reboot
                    </Button>
                  </Tooltip>
                  <Tooltip label="Hard reset (immediate)">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => handleAction('reboot', true)}
                      disabled={action.isPending}
                    >
                      <Zap size={13} /> Hard Reset
                    </Button>
                  </Tooltip>
                  <Tooltip label="Shutdown (ACPI)">
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => handleAction('stop')}
                      disabled={action.isPending}
                    >
                      <Power size={13} /> Power Off
                    </Button>
                  </Tooltip>
                  <Tooltip label="Force off (kill immediately)">
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => handleAction('stop', true)}
                      disabled={action.isPending}
                    >
                      <PowerOff size={13} /> Force Off
                    </Button>
                  </Tooltip>
                </>
              )}
              <Link to={`/vms/${uuid}/console`}>
                <Button size="sm" variant="secondary">
                  <Terminal size={13} /> Console
                </Button>
              </Link>
            </div>
          </div>

          {/* Tab bar */}
          <div className="mb-7 flex items-center gap-1 border-b border-border">
            {(['overview', 'disks', 'network', 'snapshots', 'firewall', 'devices', 'metrics'] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  '-mb-px border-b-2 px-4 py-2.5 text-sm font-medium capitalize transition-colors',
                  tab === t
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
                )}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Always mount tab panels so in-flight operations (e.g. snapshot progress) survive tab switches */}
          <div className={tab !== 'overview' ? 'hidden' : undefined}><OverviewTab vm={vm} vmUuid={uuid!} /></div>
          <div className={tab !== 'disks' ? 'hidden' : undefined}><DisksTab vmUuid={uuid!} disks={vm.disks} vmStatus={vm.status} /></div>
          <div className={tab !== 'network' ? 'hidden' : undefined}><NetworkTab vmUuid={uuid!} nics={vm.nics} meta={vmMeta} /></div>
          <div className={tab !== 'snapshots' ? 'hidden' : undefined}><SnapshotsTab vmUuid={uuid!} vmStatus={vm.status} /></div>
          <div className={tab !== 'firewall' ? 'hidden' : undefined}><FirewallTab vmUuid={uuid!} vmStatus={vm.status} /></div>
          <div className={tab !== 'devices' ? 'hidden' : undefined}><DevicesTab vmUuid={uuid!} /></div>
          <div className={tab !== 'metrics' ? 'hidden' : undefined}><MetricsTab vmUuid={uuid!} vmStatus={vm.status} /></div>
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
  const updateResources = useUpdateVmResources(vmUuid);
  const setAutostart = useSetAutostart(vmUuid);

  const handleSaveResources = async () => {
    const cpus = parseInt(editCpus, 10);
    const memoryMb = parseInt(editMemMb, 10);
    if (!cpus || cpus < 1 || !memoryMb || memoryMb < 128) {
      toast.error('Invalid values — vCPUs must be ≥ 1 and memory ≥ 128 MB');
      return;
    }
    try {
      await updateResources.mutateAsync({ cpus, memoryMb });
      toast.success('Resources updated — changes take effect on next boot');
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
    <div className="space-y-7">
      {/* Resource summary */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <SectionHeading>Resources</SectionHeading>
          {vm.status !== 'stopped' ? (
            <Tooltip label="Stop the VM to resize CPU or memory" side="left">
              <Button size="sm" variant="secondary" disabled>
                <Pencil size={13} /> Edit
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
              <Pencil size={13} /> Edit
            </Button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <ResourceCard label="vCPUs" value={String(vm.cpus)} icon={Cpu} iconBg="bg-blue-500/10" iconColor="text-blue-600 dark:text-blue-400" />
          <ResourceCard label="Memory" value={formatMemory(vm.memoryMb)} icon={MemoryStick} iconBg="bg-violet-500/10" iconColor="text-violet-600 dark:text-violet-400" />
          <ResourceCard label="Disks" value={String(vm.disks.filter((d) => !isSeedIso(d)).length)} icon={HardDrive} iconBg="bg-amber-500/10" iconColor="text-amber-600 dark:text-amber-400" />
          <ResourceCard label="NICs" value={String(vm.nics.length)} icon={Network} iconBg="bg-teal-500/10" iconColor="text-teal-600 dark:text-teal-400" />
        </div>
        {vm.status !== 'stopped' && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <AlertTriangle size={12} className="shrink-0" />
            Shut down the VM to edit CPU and memory allocation.
          </p>
        )}
      </div>

      {/* Edit Resources dialog */}
      <Dialog
        open={editResourcesOpen}
        onClose={() => setEditResourcesOpen(false)}
        title="Edit Resources"
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
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">vCPUs</label>
            <Input
              type="number"
              min={1}
              max={64}
              value={editCpus}
              onChange={(e) => setEditCpus(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">Memory (MB)</label>
            <Input
              type="number"
              min={128}
              step={256}
              value={editMemMb}
              onChange={(e) => setEditMemMb(e.target.value)}
            />
          </div>
        </div>
      </Dialog>

      {/* Access credentials */}
      {meta && (
        <section>
          <SectionHeading>Access</SectionHeading>
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
            <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <InfoField label="IP Address">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-foreground">
                    {ip ?? <span className="text-xs text-muted-foreground">Start VM to resolve</span>}
                  </span>
                  {ip && <CopyButton text={ip} />}
                </div>
              </InfoField>
              <InfoField label="Username">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-foreground">{meta.username}</span>
                  <CopyButton text={meta.username} />
                </div>
              </InfoField>
              <InfoField label="Password">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-foreground">
                    {showPassword && revealedPassword !== null ? revealedPassword : '••••••••'}
                  </span>
                  <button
                    type="button"
                    onClick={handleTogglePassword}
                    disabled={credentials.isPending}
                    className="shrink-0 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                    aria-label={showPassword ? 'Hide password' : 'Reveal password'}
                  >
                    {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyPassword}
                    disabled={credentials.isPending}
                    className="shrink-0 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                    aria-label="Copy password"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              </InfoField>
            </div>
            {ip && (
              <div className="flex items-center justify-between gap-3 border-t border-border bg-[hsl(var(--surface))] px-5 py-3">
                <p className="select-all font-mono text-xs text-muted-foreground">
                  ssh {meta.username}@{ip}
                </p>
                <CopyButton text={`ssh ${meta.username}@${ip}`} />
              </div>
            )}
          </div>
        </section>
      )}

      {/* Configuration */}
      <section>
        <SectionHeading>Configuration</SectionHeading>
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
          <div className="divide-y divide-border">
            <ConfigRow label="UUID" value={vm.id} mono copy />
            {/* Autostart toggle */}
            <div className="flex items-center justify-between gap-4 px-5 py-3.5">
              <div>
                <span className="text-sm text-muted-foreground">Autostart on host boot</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={vm.autostart ?? false}
                disabled={setAutostart.isPending}
                onClick={handleAutostartToggle}
                className={cn(
                  'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                  vm.autostart ? 'bg-primary' : 'bg-muted-foreground/30'
                )}
              >
                <span
                  className={cn(
                    'pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm ring-0 transition-transform',
                    vm.autostart ? 'translate-x-4' : 'translate-x-0'
                  )}
                />
              </button>
            </div>
            {vm.status === 'running' && vm.guestAgent !== undefined && (
              <div className="flex items-center justify-between gap-4 px-5 py-3.5">
                <span className="text-sm text-muted-foreground">Guest Agent</span>
                <span className={cn(
                  'rounded-full px-2 py-0.5 text-xs font-medium',
                  vm.guestAgent
                    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : 'bg-muted text-muted-foreground/60',
                )}>
                  {vm.guestAgent ? 'Connected' : 'Not available'}
                </span>
              </div>
            )}
            {vm.vncPort != null && <ConfigRow label="VNC Port" value={String(vm.vncPort)} mono />}
            {vm.vncDisplay && <ConfigRow label="VNC Display" value={vm.vncDisplay} mono />}
          </div>
        </div>
      </section>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
      aria-label="Copy to clipboard"
    >
      {copied
        ? <Check className="h-3.5 w-3.5 text-emerald-500" />
        : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function ResourceCard({
  label,
  value,
  icon: Icon,
  iconBg = 'bg-muted',
  iconColor = 'text-muted-foreground',
}: {
  label: string;
  value: string;
  icon: typeof Cpu;
  iconBg?: string;
  iconColor?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4 shadow-card">
      <div className="mb-3 flex items-center gap-2.5">
        <div className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', iconBg)}>
          <Icon className={cn('h-3.5 w-3.5', iconColor)} />
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </span>
      </div>
      <p className="font-mono text-2xl font-bold tracking-tight text-foreground">{value}</p>
    </div>
  );
}

function InfoField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-5 py-4">
      <dt className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

function ConfigRow({ label, value, mono, copy }: { label: string; value: string; mono?: boolean; copy?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn('truncate text-sm text-foreground', mono && 'font-mono text-xs')}>{value}</span>
        {copy && <CopyButton text={value} />}
      </div>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</h2>;
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
  const [cdromOpen, setCdromOpen] = useState(false);
  const [sizeGb, setSizeGb] = useState('20');
  const [isoFilename, setIsoFilename] = useState('');
  const [resizingDisk, setResizingDisk] = useState<VmDisk | null>(null);
  const [resizeAddGb, setResizeAddGb] = useState('10');
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
  const bootableDisks = disks.filter((d) => !isSeedIso(d) && !(d.type === 'cdrom' && !d.source));
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
      toast.success('Boot order saved — stop and start the VM to apply (reboot is not sufficient)');
      setOrderDirty(false);
    } catch {
      toast.error('Failed to save boot order');
    }
  };

  const handleAddDisk = async () => {
    try {
      await addDisk.mutateAsync({ sizeGb: parseInt(sizeGb, 10) });
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
      <div>
        <div className="mb-4 flex items-center justify-between">
          <SectionHeading>Disks &amp; Storage</SectionHeading>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setCdromOpen(true)}>
              <Disc size={13} /> Attach ISO
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus size={13} /> Add Disk
            </Button>
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
          {disks.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-muted-foreground">
              No disks attached.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  {['Device', 'Type', 'Bus', 'Size', 'Source', ''].map((h) => (
                    <th
                      key={h}
                      className={cn(
                        'px-5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground',
                        h === '' ? 'text-right' : 'text-left'
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {disks.filter((d) => !isSeedIso(d) && !(d.type === 'cdrom' && !d.source)).map((d) => (
                  <tr key={d.target} className="transition-colors hover:bg-muted/30">
                    <td className="px-5 py-3.5 font-mono text-xs text-foreground">{d.target}</td>
                    <td className="px-5 py-3.5 text-muted-foreground">
                      <Tooltip label={d.type === 'cdrom' ? 'CD-ROM' : 'Disk'}>
                        {d.type === 'cdrom'
                          ? <Disc size={14} className="text-muted-foreground" />
                          : <HardDrive size={14} className="text-muted-foreground" />}
                      </Tooltip>
                    </td>
                    <td className="px-5 py-3.5 text-xs text-muted-foreground">{d.bus}</td>
                    <td className="px-5 py-3.5 text-xs text-muted-foreground">
                      {d.sizeGb != null && d.sizeGb > 0 ? formatDisk(d.sizeGb) : '—'}
                    </td>
                    <td
                      className="max-w-xs truncate px-5 py-3.5 font-mono text-xs text-muted-foreground"
                      title={d.source}
                    >
                      {d.source || '—'}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <div className="inline-flex items-center gap-1">
                        {d.type === 'disk' && d.source && /\.qcow2$/i.test(d.source) && (
                          <Tooltip label={vmStatus === 'stopped' ? 'Download disk image' : 'Stop the VM before downloading its disk'}>
                            <button
                              type="button"
                              disabled={vmStatus !== 'stopped' || downloadDisk.isPending}
                              onClick={async () => {
                                const filename = d.source!.split('/').pop()!;
                                try {
                                  await downloadDisk.mutateAsync({ vmUuid, filename });
                                } catch (err: unknown) {
                                  toast.error(err instanceof Error ? err.message : 'Failed to start download');
                                }
                              }}
                              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                            >
                              <Download size={13} />
                            </button>
                          </Tooltip>
                        )}
                        {d.type === 'disk' && d.source && (
                          <Tooltip label="Grow disk">
                            <button
                              type="button"
                              onClick={() => { setResizeAddGb('10'); setResizingDisk(d); }}
                              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                            >
                              <ArrowUp size={13} />
                            </button>
                          </Tooltip>
                        )}
                        {d.target !== 'vda' && d.target !== 'sda' && (
                          <Tooltip label="Detach">
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  if (d.type === 'cdrom') await detachCdrom.mutateAsync(d.target);
                                  else await detachDisk.mutateAsync(d.target);
                                  toast.success('Detached');
                                } catch {
                                  toast.error('Failed to detach');
                                }
                              }}
                              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                            >
                              <Trash2 size={13} />
                            </button>
                          </Tooltip>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Resize disk dialog */}
      <Dialog
        open={!!resizingDisk}
        onClose={() => setResizingDisk(null)}
        title="Grow Disk"
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
          <div className="rounded-lg border border-border bg-muted/40 px-4 py-3">
            <p className="font-mono text-xs text-muted-foreground">
              {resizingDisk?.target} — {resizingDisk?.source?.split('/').pop() ?? ''}
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">
              Gigabytes to add
            </label>
            <Input
              type="number"
              min={1}
              max={10240}
              value={resizeAddGb}
              onChange={(e) => setResizeAddGb(e.target.value)}
              placeholder="e.g. 10"
            />
          </div>
        </div>
      </Dialog>

      {/* Boot Order */}
      {bootableDisks.length > 0 && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <SectionHeading>Boot Order</SectionHeading>
            {orderDirty && (
              <Button
                size="sm"
                onClick={handleSaveBootOrder}
                disabled={setBootOrder.isPending}
              >
                {setBootOrder.isPending ? 'Saving…' : 'Save Boot Order'}
              </Button>
            )}
          </div>
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
            <ul className="divide-y divide-border">
              {localOrder.map((target, idx) => {
                const disk = disks.find((d) => d.target === target);
                if (!disk) return null;
                return (
                  <li key={target} className="flex items-center gap-3 px-4 py-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">
                      {idx + 1}
                    </span>
                    <span className="flex-1 font-mono text-xs text-foreground">
                      {target}
                      {disk.source && (
                        <span className="ml-2 truncate text-muted-foreground">
                          {disk.source.split('/').pop()}
                        </span>
                      )}
                    </span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {disk.type}
                    </span>
                    <div className="flex gap-0.5">
                      <button
                        type="button"
                        onClick={() => moveUp(target)}
                        disabled={idx === 0}
                        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                      >
                        <ChevronUp size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveDown(target)}
                        disabled={idx === localOrder.length - 1}
                        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                      >
                        <ChevronDown size={13} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Changes take effect after stopping and starting the VM. Rebooting is not sufficient.
          </p>
        </div>
      )}

      {/* Boot Once from ISO */}
      {isoSlot && (
        <div className="rounded-xl border border-border bg-card px-5 py-4 shadow-card">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-foreground">One-shot Boot from ISO</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Start the VM once from the attached ISO without changing the persistent boot order.
                {vmStatus === 'running' && (
                  <span className="ml-1 text-amber-500 dark:text-amber-400">
                    Power off the VM first to use this option.
                  </span>
                )}
              </p>
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                {isoSlot.source.split('/').pop()}
              </p>
            </div>
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
                <Zap size={13} />
                {bootOnce.isPending ? 'Starting…' : 'Boot Once from ISO'}
              </Button>
            </Tooltip>
          </div>
        </div>
      )}

      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Disk"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleAddDisk} disabled={addDisk.isPending}>
              {addDisk.isPending ? 'Adding…' : 'Add Disk'}
            </Button>
          </>
        }
      >
        <Input
          label="Size (GB)"
          type="number"
          min="1"
          value={sizeGb}
          onChange={(e) => setSizeGb(e.target.value)}
        />
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
          <option value="">— Select an ISO —</option>
          {isos.map((iso) => (
            <option key={iso.filename} value={iso.filename}>
              {iso.name}
            </option>
          ))}
        </Select>
        {isos.length === 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
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
        toast.warning('Snapshot is taking longer than expected — check the list in a moment');
      } else {
        toast.error('Failed to create snapshot');
      }
    } finally {
      setPendingSnapshot(null);
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await deleteSnapshot.mutateAsync(name);
      toast.success('Snapshot deleted');
    } catch {
      toast.error('Failed to delete snapshot');
    }
  };

  const handleRevert = async () => {
    if (!revertTarget) return;
    const target = revertTarget;
    setRevertTarget(null);
    setPendingRevert(target);
    try {
      await revertSnapshot.mutateAsync(target);
      toast.success('Snapshot restored — VM is starting');
    } catch {
      toast.error('Failed to restore snapshot');
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
      toast.success('Template created — available on the Templates page');
    } catch {
      toast.error('Failed to convert snapshot to template');
    } finally {
      setPendingConvert(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="mb-4 flex items-center justify-between">
        <SectionHeading>Snapshots</SectionHeading>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Camera size={13} /> Take Snapshot
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
        {isLoading ? (
          <div className="px-6 py-10 text-center text-sm text-muted-foreground">Loading…</div>
        ) : snapshots.length === 0 && !pendingSnapshot ? (
          <div className="px-6 py-10 text-center text-sm text-muted-foreground">
            No snapshots yet. Take a snapshot to save the current VM state.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {['Name', 'Created', 'VM State', 'Size', ''].map((h) => (
                  <th
                    key={h}
                    className={cn(
                      'px-5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground',
                      h === '' ? 'text-right' : 'text-left'
                    )}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {pendingSnapshot && (
                <tr key="__pending" className="bg-muted/20">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2 mb-1.5">
                      <Spinner className="h-3 w-3 shrink-0" />
                      <span className="font-mono text-xs text-foreground">{pendingSnapshot}</span>
                    </div>
                    <div className="h-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full w-2/5 animate-pulse rounded-full bg-primary" />
                    </div>
                  </td>
                  <td className="px-5 py-3 text-xs text-muted-foreground/50">Taking snapshot…</td>
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
                  <tr key={snap.name} className={cn('transition-colors', isBusy ? 'bg-muted/20' : 'hover:bg-muted/30')}>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2 mb-1.5">
                        {isBusy && <Spinner className="h-3 w-3 shrink-0" />}
                        <span className="font-mono text-xs text-foreground">{snap.name}</span>
                      </div>
                      {isBusy && (
                        <div className="h-1 overflow-hidden rounded-full bg-muted">
                          <div className="h-full w-2/5 animate-pulse rounded-full bg-primary" />
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">
                      {statusLabel ?? new Date(snap.createdAt).toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">
                      {isBusy ? '' : snapshotStateLabel(snap.vmState)}
                    </td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">
                      {isBusy ? '' : (snap.sizeBytes !== undefined ? formatBytes(snap.sizeBytes) : '—')}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {!isBusy && (
                        <div className="flex items-center justify-end gap-1">
                          <Tooltip label="Convert to template">
                            <button
                              type="button"
                              onClick={() => { setToTemplateTarget(snap.name); setTemplateName(snap.name); }}
                              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-amber-500/10 hover:text-amber-500"
                            >
                              <HardDrive size={13} />
                            </button>
                          </Tooltip>
                          <Tooltip label="Restore this snapshot">
                            <button
                              type="button"
                              onClick={() => setRevertTarget(snap.name)}
                              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                            >
                              <RotateCcw size={13} />
                            </button>
                          </Tooltip>
                          <Tooltip label="Delete snapshot">
                            <button
                              type="button"
                              onClick={() => handleDelete(snap.name)}
                              disabled={deleteSnapshot.isPending}
                              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                            >
                              <Trash2 size={13} />
                            </button>
                          </Tooltip>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Create snapshot dialog */}
      <Dialog
        open={createOpen}
        onClose={() => { setCreateOpen(false); setSnapshotName(''); }}
        title="Take Snapshot"
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
              Take Snapshot
            </Button>
          </>
        }
      >
        <Input
          label="Snapshot Name"
          placeholder="e.g. pre-update"
          value={snapshotName}
          onChange={(e) => setSnapshotName(e.target.value)}
        />
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Letters, numbers, hyphens, and underscores only.
        </p>
        {vmStatus === 'running' && (
          <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2.5 text-xs text-amber-500 dark:text-amber-400">
            The VM is running — the snapshot will include both disk and memory state.
          </p>
        )}
      </Dialog>

      {/* Revert confirmation dialog */}
      <Dialog
        open={revertTarget !== null}
        onClose={() => setRevertTarget(null)}
        title="Restore Snapshot"
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
        <p className="text-sm text-muted-foreground">
          Restore{' '}
          <span className="font-mono font-semibold text-foreground">{revertTarget}</span>?{' '}
          All changes made since this snapshot was taken will be lost. The VM will be powered off
          and restarted after the restore completes.
        </p>
      </Dialog>

      {/* Convert to template dialog */}
      <Dialog
        open={toTemplateTarget !== null}
        onClose={() => { setToTemplateTarget(null); setTemplateName(''); }}
        title="Convert Snapshot to Template"
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
        <p className="mb-3 text-sm text-muted-foreground">
          Snapshot{' '}
          <span className="font-mono font-semibold text-foreground">{toTemplateTarget}</span>{' '}
          will be exported as a standalone template image. This may take a few minutes for large disks.
        </p>
        <Input
          label="Template Name"
          placeholder="e.g. my-base-image"
          value={templateName}
          onChange={(e) => setTemplateName(e.target.value)}
        />
      </Dialog>
    </div>
  );
}

// ─── Network ──────────────────────────────────────────────────────────────────

function networkTypeLabel(type: string, ipMode?: string): string {
  if (type === 'nat') return 'NAT';
  const prefix = type === 'existing-bridge' ? 'OS Bridge' : 'Bridge';
  return ipMode === 'dhcp' ? `${prefix} DHCP` : `${prefix} Static`;
}

function networkTypeClass(type: string, ipMode?: string): string {
  if (type === 'nat') return 'text-blue-500 dark:text-blue-400';
  if (ipMode === 'dhcp') return 'text-violet-500 dark:text-violet-400';
  return 'text-emerald-500 dark:text-emerald-400';
}

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
  mac,
}: {
  vmUuid: string;
  networkId: string;
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
      toast.success('Port forward created — DHCP reservation added');
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
    <div className="mt-3 rounded-xl border border-border bg-card shadow-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
          Port Forwards
        </span>
        <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
          <Plus size={12} /> Add Rule
        </Button>
      </div>

      {forwards.length === 0 ? (
        <div className="px-5 py-4 text-xs text-muted-foreground">
          No port forwards. Add a rule to expose a service to the internet.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              {['Protocol', 'Host Port', 'VM Port', 'VM IP', 'Description', ''].map((h) => (
                <th
                  key={h}
                  className={cn(
                    'px-4 py-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground',
                    h === '' ? 'text-right' : 'text-left'
                  )}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {forwards.map((fwd: PortForward) => (
              <tr key={fwd.id} className="transition-colors hover:bg-muted/30">
                <td className="px-4 py-2.5">
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-foreground">
                    {fwd.protocol}
                  </span>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-foreground">{fwd.hostPort}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{fwd.vmPort}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{fwd.vmIp}</td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">{fwd.description ?? '—'}</td>
                <td className="px-4 py-2.5 text-right">
                  <Tooltip label="Delete rule">
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await deleteForward.mutateAsync(fwd.id);
                          toast.success('Port forward removed');
                        } catch {
                          toast.error('Failed to remove port forward');
                        }
                      }}
                      className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 size={12} />
                    </button>
                  </Tooltip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Dialog
        open={addOpen}
        onClose={() => { setAddOpen(false); setForm(defaultPfForm); }}
        title="Add Port Forward"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => { setAddOpen(false); setForm(defaultPfForm); }}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleAdd} disabled={addDisabled}>
              {createForward.isPending ? 'Creating…' : 'Add Rule'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Select label="Protocol" value={form.protocol} onChange={set('protocol')}>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
          </Select>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Host Port"
              type="number"
              min="1"
              max="65535"
              placeholder="e.g. 8080"
              value={form.hostPort}
              onChange={set('hostPort')}
              required
            />
            <Input
              label="VM Port"
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
            placeholder="e.g. nginx"
            value={form.description}
            onChange={set('description')}
          />
          <p className="rounded-lg bg-blue-500/10 px-3 py-2.5 text-xs text-blue-500 dark:text-blue-400">
            A static DHCP reservation will be created for this NIC so its IP stays fixed.
            The VM must be rebooted once for the reservation to take effect if it is already running.
          </p>
        </div>
      </Dialog>
    </div>
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
      toast.success('IP reserved — this address will persist across reboots');
    } catch (err: unknown) {
      toast.error((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to reserve IP');
    }
  };

  if (!displayIp) {
    return (
      <span className="text-xs text-muted-foreground/40">
        {networkType === 'nat' || networkType === 'bridge' || networkType === 'existing-bridge' ? 'DHCP · unresolved' : '—'}
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-xs text-foreground">{displayIp}</span>
      {isReserved && (
        <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-500">
          reserved
        </span>
      )}
      {canReserve && (
        <Tooltip label="Lock this IP via DHCP reservation so it persists across reboots">
          <button
            type="button"
            onClick={handleReserve}
            disabled={reserveIp.isPending}
            className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary disabled:opacity-50"
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

  const attachedBridges = new Set(nics.map((n) => n.source));
  const availableNetworks = (networks ?? []).filter((n) => !attachedBridges.has(n.bridge));
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
      <div>
        <div className="mb-4 flex items-center justify-between">
          <SectionHeading>Network Interfaces</SectionHeading>
          <Button size="sm" onClick={handleOpen} disabled={availableNetworks.length === 0 && (networks ?? []).length > 0}>
            <Plus size={13} /> Add NIC
          </Button>
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
          {nics.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-muted-foreground">
              No network interfaces attached.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  {['MAC Address', 'Network', 'IP Address', 'Model', 'Rate Limit', ''].map((h) => (
                    <th
                      key={h}
                      className={cn(
                        'px-5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground',
                        h === '' ? 'text-right' : 'text-left'
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {nics.map((nic) => {
                  const network = networks?.find((n) => n.bridge === nic.source);
                  const isPrimary = primaryMacs.has(nic.mac);
                  return (
                    <tr key={nic.mac} className="transition-colors hover:bg-muted/30">
                      <td className="px-5 py-3.5 font-mono text-xs text-foreground">
                        <div className="flex items-center gap-2">
                          {nic.mac}
                          {isPrimary && (
                            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                              primary
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-xs text-muted-foreground">
                        {network ? (
                          <span className={cn('font-medium', networkTypeClass(network.type, network.ipMode))}>
                            {network.name}
                            <span className="ml-1.5 font-normal text-muted-foreground/50">
                              {networkTypeLabel(network.type, network.ipMode)}
                            </span>
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-5 py-3.5">
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
                      <td className="px-5 py-3.5 text-xs text-muted-foreground">{nic.model}</td>
                      <td className="px-5 py-3.5 text-xs text-muted-foreground">
                        {nic.inboundKbps || nic.outboundKbps ? (
                          <span className="font-mono">
                            ↓ {nic.inboundKbps ? `${mbpsFromKbps(nic.inboundKbps)} MB/s` : 'unlimited'}
                            {' · '}
                            ↑ {nic.outboundKbps ? `${mbpsFromKbps(nic.outboundKbps)} MB/s` : 'unlimited'}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/60">unlimited</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Tooltip label="Edit rate limit">
                            <button
                              type="button"
                              onClick={() => openBandwidth(nic)}
                              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                              <Gauge size={13} />
                            </button>
                          </Tooltip>
                          <Tooltip label="Remove NIC">
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await detachNic.mutateAsync(nic.mac);
                                  toast.success('NIC removed');
                                } catch {
                                  toast.error('Failed to remove NIC');
                                }
                              }}
                              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                            >
                              <Trash2 size={13} />
                            </button>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Port forward sections — one per NAT NIC */}
        {nics.map((nic) => {
          const network = networks?.find((n) => n.bridge === nic.source);
          if (!network || network.type !== 'nat') return null;
          return (
            <div key={nic.mac} className="mt-4">
              <p className="mb-1 text-xs text-muted-foreground">
                Port forwards for{' '}
                <span className="font-mono font-medium text-foreground">{nic.mac}</span>
                {' '}on{' '}
                <span className="font-medium text-foreground">{network.name}</span>
              </p>
              <PortForwardsSection vmUuid={vmUuid} networkId={network.id} mac={nic.mac} />
            </div>
          );
        })}
      </div>

      <Dialog
        open={addOpen}
        onClose={handleClose}
        title={addedNic ? 'NIC Attached' : 'Add Network Interface'}
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
            <p className="text-sm text-foreground">
              <span className="font-semibold">{addedNic.network.name}</span> attached with MAC{' '}
              <span className="font-mono text-xs">{addedNic.mac}</span>.
            </p>
            <p className="text-xs text-muted-foreground">
              Cloud-init will not run again for this NIC — configure it inside the VM using your OS's
              network tools. The example below is for <span className="font-medium text-foreground">Ubuntu / Debian</span> (netplan);
              adapt as needed for other distributions or Windows.
            </p>
            <div className="relative">
              <pre className="overflow-x-auto rounded-lg bg-muted px-4 py-3 font-mono text-[11px] leading-relaxed text-foreground">
                {buildNetplanSnippet(addedNic.mac, addedNic.network, addedNic.staticIp)}
              </pre>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(buildNetplanSnippet(addedNic.mac, addedNic.network, addedNic.staticIp));
                  toast.success('Copied to clipboard');
                }}
                className="absolute right-2 top-2 rounded border border-border bg-card px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                Copy
              </button>
            </div>
          </div>
        ) : availableNetworks.length === 0 ? (
          <p className="text-sm text-muted-foreground">All configured networks are already attached to this VM.</p>
        ) : (
          // ── Idle: network + IP picker ──────────────────────────────────────
          <div className="space-y-3">
            <div className="space-y-2">
              {availableNetworks.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => handleNetworkSelect(n.id)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg border p-3.5 text-left transition-colors',
                    selectedNetworkId === n.id
                      ? 'border-primary bg-primary/[0.07]'
                      : 'border-border hover:bg-muted/30'
                  )}
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Network size={14} className="text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">{n.name}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {n.cidr} · br: {n.bridge}
                    </p>
                  </div>
                  <span className={cn('shrink-0 text-xs font-medium', networkTypeClass(n.type, n.ipMode))}>
                    {networkTypeLabel(n.type, n.ipMode)}
                  </span>
                </button>
              ))}
            </div>
            {isStaticNetwork && (
              <Select
                label="IP address"
                value={selectedStaticIp}
                onChange={(e) => setSelectedStaticIp(e.target.value)}
              >
                <option value="">— select an IP —</option>
                {availableIps.map((ip) => (
                  <option key={ip.ip} value={ip.ip}>{ip.ip}</option>
                ))}
              </Select>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Inbound limit (MB/s)"
                placeholder="unlimited"
                inputMode="decimal"
                value={addInbound}
                onChange={(e) => setAddInbound(e.target.value)}
              />
              <Input
                label="Outbound limit (MB/s)"
                placeholder="unlimited"
                inputMode="decimal"
                value={addOutbound}
                onChange={(e) => setAddOutbound(e.target.value)}
              />
            </div>
            <p className="rounded-lg bg-amber-500/10 px-3 py-2.5 text-xs text-amber-500 dark:text-amber-400">
              Cloud-init will not configure this NIC automatically. Configuration steps will be shown after adding.
            </p>
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!bandwidthNic}
        onClose={closeBandwidth}
        title="Rate Limit"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={closeBandwidth}>Cancel</Button>
            <Button size="sm" onClick={submitBandwidth} disabled={setBandwidth.isPending}>
              {setBandwidth.isPending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Cap traffic on{' '}
            <span className="font-mono text-foreground">{bandwidthNic?.mac}</span>. Leave a field blank for
            unlimited. Inbound and outbound are from the guest's perspective. Limits apply live and persist
            across reboots.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Inbound (MB/s)"
              placeholder="unlimited"
              inputMode="decimal"
              value={bwInbound}
              onChange={(e) => setBwInbound(e.target.value)}
            />
            <Input
              label="Outbound (MB/s)"
              placeholder="unlimited"
              inputMode="decimal"
              value={bwOutbound}
              onChange={(e) => setBwOutbound(e.target.value)}
            />
          </div>
          <p className="text-[11px] text-muted-foreground/80">
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
    return (
      <div className="rounded-xl border border-border bg-card px-6 py-8 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            {['#', 'Protocol', 'Port / Type', 'Source / Dest', 'Action', 'Description', ''].map((h) => (
              <th
                key={h}
                className={cn(
                  'px-4 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground',
                  h === '' ? 'text-right' : 'text-left'
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rules.map((rule, idx) => (
            <tr key={rule.id} className="transition-colors hover:bg-muted/30">
              <td className="px-4 py-3 text-xs text-muted-foreground/50">{idx + 1}</td>
              <td className="px-4 py-3 font-mono text-xs text-foreground uppercase">{rule.protocol}</td>
              <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                {rule.protocol === 'icmp' ? (rule.icmpType ?? 'any') : (rule.portRange ?? 'any')}
              </td>
              <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{rule.source ?? rule.destination ?? '—'}</td>
              <td className="px-4 py-3">
                <span className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                  rule.action === 'allow'
                    ? 'bg-emerald-500/10 text-emerald-500 dark:text-emerald-400'
                    : 'bg-red-500/10 text-red-500 dark:text-red-400'
                )}>
                  {rule.action}
                </span>
              </td>
              <td className="px-4 py-3 text-xs text-muted-foreground">{rule.description ?? '—'}</td>
              <td className="px-4 py-3 text-right">
                <div className="inline-flex items-center justify-end gap-1">
                  <Tooltip label="Move up">
                    <button
                      type="button"
                      onClick={() => onMoveUp(rule.id)}
                      disabled={isPending || idx === 0}
                      className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-25"
                    >
                      <ChevronUp size={12} />
                    </button>
                  </Tooltip>
                  <Tooltip label="Move down">
                    <button
                      type="button"
                      onClick={() => onMoveDown(rule.id)}
                      disabled={isPending || idx === rules.length - 1}
                      className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-25"
                    >
                      <ChevronDown size={12} />
                    </button>
                  </Tooltip>
                  <Tooltip label="Edit rule">
                    <button
                      type="button"
                      onClick={() => onEdit(rule)}
                      disabled={isPending}
                      className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                    >
                      <Pencil size={12} />
                    </button>
                  </Tooltip>
                  <Tooltip label="Remove rule">
                    <button
                      type="button"
                      onClick={() => onDelete(rule.id)}
                      disabled={isPending}
                      className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                    >
                      <Trash2 size={12} />
                    </button>
                  </Tooltip>
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
      <div className="flex items-center justify-between">
        <SectionHeading>Firewall</SectionHeading>
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
            <Shield size={13} />
            {applyFirewall.isPending ? 'Applying…' : 'Apply Rules'}
          </Button>
        </Tooltip>
      </div>

      {/* Default Policies */}
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          Default Policies
        </p>
        <p className="mb-4 text-xs text-muted-foreground">
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
            <Skeleton className="h-8" />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-4">
              <Select
                label="Inbound default"
                value={current.defaultInbound}
                onChange={(e) => handleSetDefault('inbound', e.target.value as 'allow' | 'drop')}
                disabled={saveFirewall.isPending}
              >
                <option value="allow">Allow all</option>
                <option value="drop">Drop all</option>
              </Select>
              <Select
                label="Outbound default"
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
                  <label
                    key={dir}
                    className={`flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground transition-opacity ${isDisabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-muted/40'}`}
                  >
                    <input
                      type="checkbox"
                      checked={dir === 'inbound' ? (current.allowEstablishedInbound ?? false) : (current.allowEstablishedOutbound ?? false)}
                      onChange={(e) => handleSetEstablished(dir, e.target.checked)}
                      disabled={isDisabled}
                      className="h-3.5 w-3.5 accent-primary"
                    />
                    Allow established & related ({dir})
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Inbound Rules */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">Inbound Rules</span>
            <span className="rounded bg-blue-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-blue-500 dark:text-blue-400">
              {inboundRules.length}
            </span>
          </div>
          <Button size="sm" onClick={() => { setForm(defaultRuleForm); setEditingRuleId(null); setAddDirection('inbound'); }}>
            <Plus size={13} /> Add Rule
          </Button>
        </div>
        {isLoading ? (
          <Skeleton className="h-20 rounded-xl" />
        ) : (
          <FirewallRulesTable
            rules={inboundRules}
            onEdit={handleEditOpen}
            onDelete={handleDelete}
            onMoveUp={(id) => handleMoveRule(id, 'up')}
            onMoveDown={(id) => handleMoveRule(id, 'down')}
            isPending={saveFirewall.isPending}
            emptyLabel="No inbound rules — traffic follows the default inbound policy."
          />
        )}
      </div>

      {/* Outbound Rules */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">Outbound Rules</span>
            <span className="rounded bg-violet-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-violet-500 dark:text-violet-400">
              {outboundRules.length}
            </span>
          </div>
          <Button size="sm" onClick={() => { setForm(defaultRuleForm); setEditingRuleId(null); setAddDirection('outbound'); }}>
            <Plus size={13} /> Add Rule
          </Button>
        </div>
        {isLoading ? (
          <Skeleton className="h-20 rounded-xl" />
        ) : (
          <FirewallRulesTable
            rules={outboundRules}
            onEdit={handleEditOpen}
            onDelete={handleDelete}
            onMoveUp={(id) => handleMoveRule(id, 'up')}
            onMoveDown={(id) => handleMoveRule(id, 'down')}
            isPending={saveFirewall.isPending}
            emptyLabel="No outbound rules — traffic follows the default outbound policy."
          />
        )}
      </div>

      {/* Add / Edit Rule Dialog */}
      <Dialog
        open={addDirection !== null}
        onClose={closeDialog}
        title={`${editingRuleId ? 'Edit' : 'Add'} ${addDirection === 'inbound' ? 'Inbound' : 'Outbound'} Rule`}
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
              {saveFirewall.isPending ? 'Saving…' : editingRuleId ? 'Save Changes' : 'Add Rule'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Select label="Action" value={form.action} onChange={setField('action')}>
              {FW_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a.charAt(0).toUpperCase() + a.slice(1)}
                </option>
              ))}
            </Select>
            <Select label="Protocol" value={form.protocol} onChange={setField('protocol')}>
              {FW_PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {p.toUpperCase()}
                </option>
              ))}
            </Select>
          </div>
          {form.protocol === 'icmp' ? (
            <Select label="ICMP type" value={form.icmpType} onChange={setField('icmpType')}>
              {FW_ICMP_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </Select>
          ) : (
            <Input
              label="Port / Range (leave blank for any)"
              placeholder="e.g. 22, 80,443, or 8000-9000"
              value={form.portRange}
              onChange={setField('portRange')}
              disabled={form.protocol === 'all'}
            />
          )}
          {addDirection !== null && (
            <Input
              label={addDirection === 'inbound' ? 'Source address (optional)' : 'Destination address (optional)'}
              placeholder="e.g. 192.168.1.0/24"
              value={addDirection === 'inbound' ? form.source : form.destination}
              onChange={setField(addDirection === 'inbound' ? 'source' : 'destination')}
            />
          )}
          <Input
            label="Description (optional)"
            placeholder="e.g. Allow SSH"
            value={form.description}
            onChange={setField('description')}
          />
          {!portRangeValid && (
            <p className="text-xs text-destructive">Port must be a number or range, e.g. 22, 80,443, or 8000-9000.</p>
          )}
        </div>
      </Dialog>
    </div>
  );
}

// ─── Devices ──────────────────────────────────────────────────────────────────

function pciAddrStr(a: NonNullable<HostDevice['pciAddress']>): string {
  return `${a.domain.toString(16).padStart(4, '0')}:${a.bus.toString(16).padStart(2, '0')}:${a.slot.toString(16).padStart(2, '0')}.${a.function.toString(16)}`;
}

const PCI_CLASS_NAMES: Record<string, string> = {
  '01': 'Storage', '02': 'Network', '03': 'Display', '04': 'Multimedia',
  '05': 'Memory', '06': 'Bridge', '07': 'Comms', '08': 'System',
  '09': 'Input', '0a': 'Docking', '0b': 'Processor', '0c': 'Serial Bus',
  '0d': 'Wireless', '10': 'Encryption', '11': 'Signal Proc',
};

function DeviceRow({
  device,
  action,
  dimmed = false,
  warn = false,
}: {
  device: HostDevice;
  action?: React.ReactNode;
  dimmed?: boolean;
  warn?: boolean;
}) {
  return (
    <tr className={cn('transition-colors hover:bg-muted/30', dimmed && 'opacity-55')}>
      <td className="px-5 py-3.5">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase',
            device.type === 'pci'
              ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
              : 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
          )}
        >
          {device.type === 'pci' ? <Cpu size={10} /> : <Usb size={10} />}
          {device.type.toUpperCase()}
        </span>
      </td>
      <td className="px-5 py-3.5">
        <div className="text-xs font-medium text-foreground">{device.product}</div>
        <div className="text-xs text-muted-foreground">{device.vendor}</div>
      </td>
      <td className="px-5 py-3.5 text-xs text-muted-foreground">
        {device.type === 'pci' && device.pciAddress ? (
          <div className="space-y-0.5">
            <div className="font-mono">{pciAddrStr(device.pciAddress)}</div>
            <div className="flex flex-wrap items-center gap-x-2">
              {device.pciClass && (
                <span>
                  {PCI_CLASS_NAMES[device.pciClass.slice(0, 2).toLowerCase()] ?? device.pciClass}
                </span>
              )}
              {device.iommuGroup !== undefined && (
                <span className="text-amber-600 dark:text-amber-400">
                  IOMMU {device.iommuGroup}
                </span>
              )}
              {device.driver && (
                warn ? (
                  <Tooltip label="Host is currently using this device — attaching it will unbind it from the host and may disrupt host functionality">
                    <span className="inline-flex cursor-help items-center gap-1 font-mono text-amber-600 dark:text-amber-400">
                      <AlertTriangle size={11} />
                      {device.driver}
                    </span>
                  </Tooltip>
                ) : (
                  <span className="font-mono">{device.driver}</span>
                )
              )}
            </div>
          </div>
        ) : device.type === 'usb' && device.usbAddress ? (
          <span className="font-mono">
            Bus {String(device.usbAddress.bus).padStart(3, '0')} Dev{' '}
            {String(device.usbAddress.device).padStart(3, '0')}
          </span>
        ) : null}
      </td>
      <td className="px-5 py-3.5 text-right">{action}</td>
    </tr>
  );
}

function DevicesTab({ vmUuid }: { vmUuid: string }) {
  const { data: allDevices = [], isLoading } = useHostDevices();
  const attach = useAttachDevice(vmUuid);
  const detach = useDetachDevice(vmUuid);
  const [typeFilter, setTypeFilter] = useState<'all' | 'pci' | 'usb'>('all');

  const filterFn = (d: HostDevice) => typeFilter === 'all' || d.type === typeFilter;

  const attached = allDevices.filter((d) => d.assignedTo === vmUuid && filterFn(d));
  const available = allDevices.filter((d) => !d.assignedTo && filterFn(d));
  const inUse = allDevices.filter((d) => d.assignedTo && d.assignedTo !== vmUuid && filterFn(d));

  const handleAttach = async (deviceId: string) => {
    try {
      await attach.mutateAsync(deviceId);
      toast.success('Device attached');
    } catch {
      toast.error('Failed to attach device');
    }
  };

  const handleDetach = async (deviceId: string) => {
    try {
      await detach.mutateAsync(deviceId);
      toast.success('Device detached');
    } catch {
      toast.error('Failed to detach device');
    }
  };

  const tableHeaders = (
    <tr className="border-b border-border bg-muted/40">
      {['Type', 'Device', 'Details', ''].map((h) => (
        <th
          key={h}
          className={cn(
            'px-5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground',
            h === '' ? 'text-right' : 'text-left',
          )}
        >
          {h}
        </th>
      ))}
    </tr>
  );

  return (
    <div className="space-y-7">
      {/* Filter pills */}
      <div className="flex items-center gap-1.5">
        {(['all', 'pci', 'usb'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setTypeFilter(f)}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors',
              typeFilter === f
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground',
            )}
          >
            {f === 'all' ? 'All' : f.toUpperCase()}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
        </div>
      ) : (
        <>
          {/* Attached */}
          <div>
            <SectionHeading>Attached to this VM</SectionHeading>
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
              {attached.length === 0 ? (
                <div className="px-6 py-10 text-center text-sm text-muted-foreground">
                  No devices attached to this VM.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>{tableHeaders}</thead>
                  <tbody className="divide-y divide-border">
                    {attached.map((d) => (
                      <DeviceRow
                        key={d.id}
                        device={d}
                        action={
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => handleDetach(d.id)}
                            disabled={detach.isPending}
                          >
                            Detach
                          </Button>
                        }
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Available */}
          <div>
            <SectionHeading>Available Devices</SectionHeading>
            <p className="mb-3 text-xs text-muted-foreground">
              PCI passthrough requires IOMMU support (intel_iommu=on / amd_iommu=on) and the{' '}
              <span className="font-mono">vfio-pci</span> kernel module. Devices sharing an IOMMU
              group must all be passed through together or left entirely on the host.
            </p>
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
              {available.length === 0 ? (
                <div className="px-6 py-10 text-center text-sm text-muted-foreground">
                  No devices available — all host devices are either in use or filtered out.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>{tableHeaders}</thead>
                  <tbody className="divide-y divide-border">
                    {available.map((d) => (
                      <DeviceRow
                        key={d.id}
                        device={d}
                        warn={d.type === 'pci' && !!d.driver && d.driver !== 'vfio-pci'}
                        action={
                          <Button
                            size="sm"
                            onClick={() => handleAttach(d.id)}
                            disabled={attach.isPending}
                          >
                            Attach
                          </Button>
                        }
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* In use by other VMs */}
          {inUse.length > 0 && (
            <div>
              <SectionHeading>In Use by Other VMs</SectionHeading>
              <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      {['Type', 'Device', 'Details', 'Assigned To'].map((h) => (
                        <th
                          key={h}
                          className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {inUse.map((d) => (
                      <DeviceRow
                        key={d.id}
                        device={d}
                        dimmed
                        action={
                          <span className="text-xs text-muted-foreground">{d.assignedTo}</span>
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

import { MetricChart } from '@/components/ui/MetricChart';

function fmtBps(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
}

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

function formatChartTime(ts: number, range: ChartRange): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  if (range === 'live') {
    const ss = d.getSeconds().toString().padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  if (range === '24h') {
    // Show day boundary so a midnight crossover is obvious.
    const dd = d.getDate().toString().padStart(2, '0');
    const mo = (d.getMonth() + 1).toString().padStart(2, '0');
    return `${dd}/${mo} ${hh}:${mm}`;
  }
  return `${hh}:${mm}`;
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

  if (!isRunning) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
          <Activity className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium text-foreground">VM is not running</p>
        <p className="mt-1 text-xs text-muted-foreground">Start the VM to view per-VM metrics.</p>
      </div>
    );
  }

  if (isError || (!current && !liveHistory.length)) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
          <Activity className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium text-foreground">Metrics unavailable</p>
        <p className="mt-1 text-xs text-muted-foreground">Waiting for first sample…</p>
      </div>
    );
  }

  const memPct = current && current.memTotalMb > 0
    ? Math.round((current.memUsedMb / current.memTotalMb) * 100)
    : 0;

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <MetricCard
          label="CPU"
          value={current ? `${Math.round(current.cpuPercent)}%` : '—'}
          sub={current ? `${current.vcpuCount} vCPU${current.vcpuCount !== 1 ? 's' : ''}` : ''}
          accent={current && current.cpuPercent > 80 ? 'warn' : 'neutral'}
        />
        <MetricCard
          label="Memory"
          value={current ? `${memPct}%` : '—'}
          sub={current ? `${formatMemory(current.memUsedMb)} / ${formatMemory(current.memTotalMb)}` : ''}
          accent={memPct > 90 ? 'warn' : 'neutral'}
        />
        <MetricCard
          label="Disk I/O"
          value={current ? fmtBps(current.diskReadBps + current.diskWriteBps) : '—'}
          sub={current ? `↑ ${fmtBps(current.diskWriteBps)}  ↓ ${fmtBps(current.diskReadBps)}` : ''}
        />
        <MetricCard
          label="Network"
          value={current ? fmtBps(current.netRxBps + current.netTxBps) : '—'}
          sub={current ? `↑ ${fmtBps(current.netTxBps)}  ↓ ${fmtBps(current.netRxBps)}` : ''}
        />
      </div>

      {/* Range selector */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">History</span>
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5 shadow-card">
          {(['live', '1h', '24h'] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={cn(
                'px-3 py-1 text-[11px] font-semibold uppercase tracking-widest rounded-md transition',
                range === r
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {r === 'live' ? 'Live' : r}
            </button>
          ))}
        </div>
      </div>

      {/* Charts */}
      {points.length > 1 ? (
        <div className="flex flex-col gap-5">
          <ChartCard
            title="CPU Usage"
            data={cpuData}
            timestamps={timestamps}
            color="hsl(214 100% 52%)"
            max={100}
            formatY={(v) => `${Math.round(v)}%`}
            formatX={formatX}
          />
          <ChartCard
            title="Memory Usage"
            data={memData}
            timestamps={timestamps}
            color="hsl(158 60% 34%)"
            max={100}
            formatY={(v) => `${Math.round(v)}%`}
            formatX={formatX}
          />
          <ChartCard
            title="Disk I/O"
            data={diskRdData}
            data2={diskWrData}
            timestamps={timestamps}
            color="hsl(214 100% 52%)"
            color2="hsl(0 72% 51%)"
            legend={['Read', 'Write']}
            formatY={fmtBps}
            formatX={formatX}
          />
          <ChartCard
            title="Network I/O"
            data={netRxData}
            data2={netTxData}
            timestamps={timestamps}
            color="hsl(214 100% 52%)"
            color2="hsl(280 65% 55%)"
            legend={['RX', 'TX']}
            formatY={fmtBps}
            formatX={formatX}
          />
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-12 text-center">
          <p className="text-sm font-medium text-foreground">No samples yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {range === 'live'
              ? 'Waiting for live samples…'
              : 'Metrics are sampled every 30 seconds. History will appear shortly.'}
          </p>
        </div>
      )}
    </div>
  );
}

function MetricCard({
  label, value, sub, accent = 'neutral',
}: {
  label: string;
  value: string;
  sub: string;
  accent?: 'warn' | 'neutral';
}) {
  return (
    <div className={cn(
      'rounded-xl border border-border bg-card px-5 py-4 shadow-card',
      accent === 'warn' && 'border-amber-500/25 bg-amber-500/5',
    )}>
      <div className="mb-2 flex items-center gap-2">
        <div className={cn(
          'flex h-7 w-7 items-center justify-center rounded-lg',
          accent === 'warn' ? 'bg-amber-500/15' : 'bg-muted',
        )}>
          <Activity className={cn('h-3.5 w-3.5', accent === 'warn' ? 'text-amber-500' : 'text-muted-foreground')} />
        </div>
        <span className={cn(
          'text-[10px] font-semibold uppercase tracking-widest',
          accent === 'warn' ? 'text-amber-500 dark:text-amber-400' : 'text-muted-foreground',
        )}>
          {label}
        </span>
      </div>
      <p className="nums text-xl font-bold text-foreground">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function ChartCard({
  title, data, data2, timestamps, color, color2, legend, formatY, formatX, max,
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
  max?: number;
}) {
  const last = data[data.length - 1];
  const last2 = data2?.[data2.length - 1];

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <span className="text-xs font-semibold text-foreground">{title}</span>
        <div className="flex items-center gap-3">
          {legend && color2 && last2 != null && (
            <>
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="h-1.5 w-3 rounded-full" style={{ background: color }} />
                {legend[0]} {formatY(last)}
              </span>
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="h-px w-3 rounded-full" style={{ background: color2, borderBottom: `1px dashed ${color2}` }} />
                {legend[1]} {formatY(last2)}
              </span>
            </>
          )}
          {!legend && last != null && (
            <span className="nums text-xs font-semibold text-foreground">{formatY(last)}</span>
          )}
        </div>
      </div>
      <div className="px-3 pb-2 pt-3">
        <MetricChart
          id={`vm-${title.replace(/\s/g, '-')}`}
          data={data}
          data2={data2}
          timestamps={timestamps}
          color={color}
          color2={color2}
          formatY={formatY}
          formatX={formatX}
          max={max}
        />
      </div>
    </div>
  );
}
