import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, Camera, ChevronDown, ChevronUp, Cpu, Disc, Eye, EyeOff,
  HardDrive, MemoryStick, Network, Plus, Power, PowerOff, RotateCcw,
  Server, Shield, Terminal, Trash2, Zap,
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
  useVm, useVmMeta, useVmAction, useAddDisk, useDetachDisk,
  useAttachCdrom, useDetachCdrom, useAddNic, useDetachNic,
  useSetBootOrder, useBootOnce,
  useSnapshots, useCreateSnapshot, useDeleteSnapshot, useRevertSnapshot, useSnapshotToTemplate,
  useVmIfAddrs, useVmReservations,
  useVmFirewall, useSaveFirewall, useApplyFirewall,
} from '@/hooks/useVms';
import { useVmPortForwards, useCreatePortForward, useDeletePortForward, useReserveIp } from '@/hooks/usePortForwards';
import { useIsos } from '@/hooks/useIsos';
import { useNetworks } from '@/hooks/useNetworks';
import { formatMemory } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { DhcpReservation, FirewallConfig, FirewallRule, PortForward, VmDisk, VmMeta, VmNic, VmSnapshot, VmStatus } from '@/types';
import { useLogoStore } from '@/store/logoStore';
import { useVmOpsStore } from '@/store/vmOpsStore';

type Tab = 'overview' | 'disks' | 'network' | 'snapshots' | 'firewall';

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
  const { name } = useParams<{ name: string }>();
  const [tab, setTab] = useState<Tab>('overview');
  const { data: vm, isLoading } = useVm(name!);
  const { data: metaData } = useVmMeta(name!);
  const vmMeta = metaData?.meta ?? null;
  const action = useVmAction(name!);

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
            "{name}" does not exist or has been deleted.
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
                <h1 className="text-2xl font-bold tracking-tight text-foreground">{name}</h1>
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
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => handleAction('reboot')}
                    disabled={action.isPending}
                  >
                    <RotateCcw size={13} /> Reboot
                  </Button>
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
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => handleAction('stop')}
                    disabled={action.isPending}
                  >
                    <Power size={13} /> Power Off
                  </Button>
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
              <Link to={`/vms/${name}/console`}>
                <Button size="sm" variant="secondary">
                  <Terminal size={13} /> Console
                </Button>
              </Link>
            </div>
          </div>

          {/* Tab bar */}
          <div className="mb-7 flex items-center gap-1 border-b border-border">
            {(['overview', 'disks', 'network', 'snapshots', 'firewall'] as Tab[]).map((t) => (
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
          <div className={tab !== 'overview' ? 'hidden' : undefined}><OverviewTab vm={vm} vmName={name!} /></div>
          <div className={tab !== 'disks' ? 'hidden' : undefined}><DisksTab vmName={name!} disks={vm.disks} vmStatus={vm.status} /></div>
          <div className={tab !== 'network' ? 'hidden' : undefined}><NetworkTab vmName={name!} nics={vm.nics} meta={vmMeta} /></div>
          <div className={tab !== 'snapshots' ? 'hidden' : undefined}><SnapshotsTab vmName={name!} vmStatus={vm.status} /></div>
          <div className={tab !== 'firewall' ? 'hidden' : undefined}><FirewallTab vmName={name!} vmStatus={vm.status} /></div>
        </>
      )}
    </Layout>
  );
}

// ─── Overview ─────────────────────────────────────────────────────────────────

function OverviewTab({
  vm,
  vmName,
}: {
  vm: NonNullable<ReturnType<typeof useVm>['data']>;
  vmName: string;
}) {
  const { data: metaData } = useVmMeta(vmName);
  const meta = metaData?.meta ?? null;
  const ip = metaData?.ip ?? null;
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="space-y-7">
      {/* Resource summary */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <ResourceCard label="vCPUs" value={String(vm.cpus)} icon={Cpu} />
        <ResourceCard label="Memory" value={formatMemory(vm.memoryMb)} icon={MemoryStick} />
        <ResourceCard label="Disks" value={String(vm.disks.filter((d) => !isSeedIso(d)).length)} icon={HardDrive} />
        <ResourceCard label="NICs" value={String(vm.nics.length)} icon={Network} />
      </div>

      {/* Access credentials */}
      {meta && (
        <section>
          <SectionHeading>Access</SectionHeading>
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
            <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <InfoField label="IP Address">
                <span className="font-mono text-sm text-foreground">
                  {ip ?? <span className="text-xs text-muted-foreground">Start VM to resolve</span>}
                </span>
              </InfoField>
              <InfoField label="Username">
                <span className="font-mono text-sm text-foreground">{meta.username}</span>
              </InfoField>
              <InfoField label="Password">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-foreground">
                    {showPassword ? meta.password : '••••••••'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </InfoField>
            </div>
            {ip && (
              <div className="border-t border-border bg-[hsl(var(--surface))] px-5 py-3">
                <p className="select-all font-mono text-xs text-muted-foreground">
                  ssh {meta.username}@{ip}
                </p>
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
            <ConfigRow label="UUID" value={vm.id} mono />
            {vm.vncPort != null && <ConfigRow label="VNC Port" value={String(vm.vncPort)} mono />}
            {vm.vncDisplay && <ConfigRow label="VNC Display" value={vm.vncDisplay} mono />}
          </div>
        </div>
      </section>
    </div>
  );
}

function ResourceCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof Cpu;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4 shadow-card">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </span>
      </div>
      <p className="font-mono text-xl font-bold text-foreground">{value}</p>
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

function ConfigRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={cn('text-sm text-foreground', mono && 'font-mono text-xs')}>{value}</span>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-sm font-semibold text-foreground">{children}</h2>;
}

// ─── Disks ────────────────────────────────────────────────────────────────────

function DisksTab({
  vmName,
  disks,
  vmStatus,
}: {
  vmName: string;
  disks: VmDisk[];
  vmStatus: import('@/types').VmStatus;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [cdromOpen, setCdromOpen] = useState(false);
  const [sizeGb, setSizeGb] = useState('20');
  const [isoFilename, setIsoFilename] = useState('');
  const addDisk = useAddDisk(vmName);
  const detachDisk = useDetachDisk(vmName);
  const attachCdrom = useAttachCdrom(vmName);
  const detachCdrom = useDetachCdrom(vmName);
  const setBootOrder = useSetBootOrder(vmName);
  const bootOnce = useBootOnce(vmName);
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
                  {['Device', 'Type', 'Bus', 'Source', ''].map((h) => (
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
                    <td className="px-5 py-3.5 text-xs capitalize text-muted-foreground">{d.type}</td>
                    <td className="px-5 py-3.5 text-xs text-muted-foreground">{d.bus}</td>
                    <td
                      className="max-w-xs truncate px-5 py-3.5 font-mono text-xs text-muted-foreground"
                      title={d.source}
                    >
                      {d.source || '—'}
                    </td>
                    <td className="px-5 py-3.5 text-right">
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

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

function SnapshotsTab({ vmName, vmStatus }: { vmName: string; vmStatus: VmStatus }) {
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
  const pendingSnapshot = allPendingSnapshots[vmName] ?? null;
  const pendingRevert = allPendingReverts[vmName] ?? null;
  const pendingConvert = allPendingConverts[vmName] ?? null;
  const setPendingSnapshot = (name: string | null) => storePendingSnapshot(vmName, name);
  const setPendingRevert = (name: string | null) => storePendingRevert(vmName, name);
  const setPendingConvert = (name: string | null) => storePendingConvert(vmName, name);

  const { data: snapshots = [], isLoading } = useSnapshots(vmName);
  const { templates: templateLogos, setTemplateLogo } = useLogoStore();
  const createSnapshot = useCreateSnapshot(vmName);
  const deleteSnapshot = useDeleteSnapshot(vmName);
  const revertSnapshot = useRevertSnapshot(vmName);
  const snapshotToTemplate = useSnapshotToTemplate(vmName);

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
                {['Name', 'Created', 'VM State', ''].map((h) => (
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
                    <td className="px-5 py-3 text-xs capitalize text-muted-foreground">
                      {isBusy ? '' : snap.vmState}
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
  return ipMode === 'dhcp' ? 'Bridge DHCP' : 'Bridge Static';
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
  vmName,
  networkId,
  mac,
}: {
  vmName: string;
  networkId: string;
  mac: string;
}) {
  const { data: allForwards = [] } = useVmPortForwards(vmName);
  const forwards = allForwards.filter((f) => f.networkId === networkId && f.mac === mac);
  const createForward = useCreatePortForward(networkId);
  const deleteForward = useDeletePortForward(networkId, vmName);

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState<AddPortForwardForm>(defaultPfForm);

  const set = (key: keyof AddPortForwardForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleAdd = async () => {
    try {
      await createForward.mutateAsync({
        vmName,
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
  vmName,
}: {
  nic: VmNic;
  ifAddrs: Record<string, string>;
  reservations: DhcpReservation[];
  meta: VmMeta | null;
  networkType?: string;
  networkId?: string;
  vmName: string;
}) {
  const reservation = reservations.find((r) => r.mac === nic.mac);
  const liveIp = ifAddrs[nic.mac];

  // For bridge/static — use meta IP (always known)
  const staticMetaIp = meta?.networks?.find((n) => n.mac === nic.mac && n.ip)?.ip;

  const displayIp = staticMetaIp ?? liveIp ?? reservation?.ip;
  const isReserved = !!reservation;
  const canReserve = networkType === 'nat' && !!networkId && !!liveIp && !isReserved;

  const reserveIp = useReserveIp(networkId ?? '', vmName);

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
        {networkType === 'nat' || networkType === 'bridge' ? 'DHCP · unresolved' : '—'}
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

function NetworkTab({ vmName, nics, meta }: { vmName: string; nics: VmNic[]; meta: VmMeta | null }) {
  const [addOpen, setAddOpen] = useState(false);
  const [selectedNetworkId, setSelectedNetworkId] = useState('');
  const { data: networks } = useNetworks();
  const { data: ifAddrs = {} } = useVmIfAddrs(vmName);
  const { data: reservations = [] } = useVmReservations(vmName);
  const addNic = useAddNic(vmName);
  const detachNic = useDetachNic(vmName);

  const attachedBridges = new Set(nics.map((n) => n.source));
  const availableNetworks = (networks ?? []).filter((n) => !attachedBridges.has(n.bridge));
  const selectedNetwork = availableNetworks.find((n) => n.id === selectedNetworkId);

  const primaryMacs = new Set((meta?.networks ?? []).filter((n) => n.isPrimary).map((n) => n.mac));

  const handleOpen = () => {
    setSelectedNetworkId(availableNetworks[0]?.id ?? '');
    setAddOpen(true);
  };

  const handleClose = () => {
    setAddOpen(false);
    setSelectedNetworkId('');
  };

  const handleAddNic = async () => {
    if (!selectedNetwork) return;
    try {
      await addNic.mutateAsync({ bridge: selectedNetwork.bridge });
      toast.success('NIC attached — configure networking inside the VM to activate it');
      handleClose();
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
                  {['MAC Address', 'Network', 'IP Address', 'Model', ''].map((h) => (
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
                          vmName={vmName}
                        />
                      </td>
                      <td className="px-5 py-3.5 text-xs text-muted-foreground">{nic.model}</td>
                      <td className="px-5 py-3.5 text-right">
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
              <PortForwardsSection vmName={vmName} networkId={network.id} mac={nic.mac} />
            </div>
          );
        })}
      </div>

      <Dialog
        open={addOpen}
        onClose={handleClose}
        title="Add Network Interface"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={handleClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleAddNic} disabled={!selectedNetworkId || addNic.isPending}>
              {addNic.isPending ? 'Adding…' : 'Add NIC'}
            </Button>
          </>
        }
      >
        {availableNetworks.length === 0 ? (
          <p className="text-sm text-muted-foreground">All configured networks are already attached to this VM.</p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-2">
              {availableNetworks.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => setSelectedNetworkId(n.id)}
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
            <p className="rounded-lg bg-amber-500/10 px-3 py-2.5 text-xs text-amber-500 dark:text-amber-400">
              This NIC will be attached immediately but cloud-init will not configure it. You will need to
              configure the network interface manually inside the VM.
            </p>
          </div>
        )}
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

interface RuleForm {
  protocol: 'tcp' | 'udp' | 'icmp' | 'all';
  portRange: string;
  action: 'allow' | 'drop';
  description: string;
}

const defaultRuleForm: RuleForm = {
  protocol: 'tcp',
  portRange: '',
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
  onDelete,
  isPending,
  emptyLabel,
}: {
  rules: FirewallRule[];
  onDelete: (id: string) => void;
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
            {['#', 'Protocol', 'Port / Range', 'Action', 'Description', ''].map((h) => (
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
              <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{rule.portRange ?? '—'}</td>
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
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FirewallTab({ vmName, vmStatus }: { vmName: string; vmStatus: VmStatus }) {
  const [addDirection, setAddDirection] = useState<'inbound' | 'outbound' | null>(null);
  const [form, setForm] = useState<RuleForm>(defaultRuleForm);
  const { data: cfg, isLoading } = useVmFirewall(vmName);
  const saveFirewall = useSaveFirewall(vmName);
  const applyFirewall = useApplyFirewall(vmName);

  const current = cfg ?? emptyFirewallConfig;
  const portlessProtocol = form.protocol === 'icmp' || form.protocol === 'all';
  const portRangeValid =
    portlessProtocol || !form.portRange.trim() || /^\d+(-\d+)?$/.test(form.portRange.trim());

  const setField = (key: keyof RuleForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value = e.target.value;
      setForm((f) => {
        const next = { ...f, [key]: value };
        if (key === 'protocol' && (value === 'icmp' || value === 'all')) next.portRange = '';
        return next;
      });
    };

  const handleSetDefault = async (
    direction: 'inbound' | 'outbound',
    value: 'allow' | 'drop'
  ) => {
    const updated: FirewallConfig = {
      ...current,
      ...(direction === 'inbound' ? { defaultInbound: value } : { defaultOutbound: value }),
    };
    try {
      await saveFirewall.mutateAsync(updated);
      toast.success(`${direction === 'inbound' ? 'Inbound' : 'Outbound'} default policy updated`);
    } catch {
      toast.error('Failed to update default policy');
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
      action: form.action,
      description: form.description.trim() || undefined,
    };
    try {
      await saveFirewall.mutateAsync({ ...current, rules: [...current.rules, newRule] });
      toast.success(`${addDirection === 'inbound' ? 'Inbound' : 'Outbound'} rule added`);
      setAddDirection(null);
      setForm(defaultRuleForm);
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
          <div className="grid grid-cols-2 gap-4">
            <Skeleton className="h-[60px]" />
            <Skeleton className="h-[60px]" />
          </div>
        ) : (
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
          <Button size="sm" onClick={() => { setForm(defaultRuleForm); setAddDirection('inbound'); }}>
            <Plus size={13} /> Add Rule
          </Button>
        </div>
        {isLoading ? (
          <Skeleton className="h-20 rounded-xl" />
        ) : (
          <FirewallRulesTable
            rules={inboundRules}
            onDelete={handleDelete}
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
          <Button size="sm" onClick={() => { setForm(defaultRuleForm); setAddDirection('outbound'); }}>
            <Plus size={13} /> Add Rule
          </Button>
        </div>
        {isLoading ? (
          <Skeleton className="h-20 rounded-xl" />
        ) : (
          <FirewallRulesTable
            rules={outboundRules}
            onDelete={handleDelete}
            isPending={saveFirewall.isPending}
            emptyLabel="No outbound rules — traffic follows the default outbound policy."
          />
        )}
      </div>

      {/* Add Rule Dialog */}
      <Dialog
        open={addDirection !== null}
        onClose={() => { setAddDirection(null); setForm(defaultRuleForm); }}
        title={`Add ${addDirection === 'inbound' ? 'Inbound' : 'Outbound'} Rule`}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => { setAddDirection(null); setForm(defaultRuleForm); }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleAddRule}
              disabled={saveFirewall.isPending || !portRangeValid}
            >
              {saveFirewall.isPending ? 'Saving…' : 'Add Rule'}
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
          <Input
            label="Port / Range"
            placeholder="e.g. 22 or 8000-9000"
            value={form.portRange}
            onChange={setField('portRange')}
            disabled={portlessProtocol}
          />
          <Input
            label="Description (optional)"
            placeholder="e.g. Allow SSH"
            value={form.description}
            onChange={setField('description')}
          />
          {!portRangeValid && (
            <p className="text-xs text-destructive">Port must be a number or range (e.g. 80 or 8000-9000).</p>
          )}
        </div>
      </Dialog>
    </div>
  );
}
