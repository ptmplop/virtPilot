import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Cpu,
  MemoryStick,
  Plus,
  Power,
  PowerOff,
  RotateCcw,
  Search,
  Server,
  Terminal,
  Trash2,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tooltip } from '@/components/ui/Tooltip';
import { useVms, useDeleteVm, useVmAction } from '@/hooks/useVms';
import { formatMemory } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { VmStatus, VmSummary } from '@/types';
import { VmLogo } from '@/components/ui/OsLogoPicker';
import { useLogoStore } from '@/store/logoStore';

// ─── Status config ────────────────────────────────────────────────────────────

const statusConfig: Record<VmStatus, {
  label: string;
  dot: string;
  bg: string;
  text: string;
}> = {
  running: { label: 'Active',  dot: 'bg-emerald-500', bg: 'bg-emerald-500/10', text: 'text-emerald-600 dark:text-emerald-400' },
  stopped: { label: 'Off',     dot: 'bg-slate-400',   bg: 'bg-slate-500/8',    text: 'text-slate-500 dark:text-slate-400' },
  paused:  { label: 'Paused',  dot: 'bg-amber-500',   bg: 'bg-amber-500/10',   text: 'text-amber-600 dark:text-amber-400' },
  crashed: { label: 'Crashed', dot: 'bg-red-500',     bg: 'bg-red-500/10',     text: 'text-red-600 dark:text-red-400' },
  unknown: { label: 'Unknown', dot: 'bg-muted-foreground/40', bg: 'bg-muted',  text: 'text-muted-foreground' },
};

const COLS = 'minmax(0,1fr) 120px 88px 108px 184px';

// ─── Page ─────────────────────────────────────────────────────────────────────

export function VmsPage() {
  const [search, setSearch] = useState('');
  const { data: vms, isLoading, error } = useVms();

  const total   = vms?.length ?? 0;
  const running = vms?.filter((v) => v.status === 'running').length ?? 0;
  const stopped = vms?.filter((v) => v.status === 'stopped').length ?? 0;

  const filtered = (vms ?? []).filter((v) =>
    v.name.toLowerCase().includes(search.toLowerCase().trim())
  );

  const subtitle = vms
    ? `${total} ${total === 1 ? 'VM' : 'VMs'} · ${running} running · ${stopped} stopped`
    : 'Manage your KVM virtual machines';

  return (
    <Layout
      title="Virtual Machines"
      subtitle={subtitle}
      actions={
        <Link to="/vms/new">
          <Button>
            <Plus size={14} />
            Create VM
          </Button>
        </Link>
      }
    >
      {/* Search */}
      <div className="mb-5">
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <input
            type="text"
            placeholder="Search virtual machines…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-4 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {/* Header */}
        <div
          className="grid items-center gap-4 border-b border-border bg-muted/40 px-5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
          style={{ gridTemplateColumns: COLS }}
        >
          <span>Name</span>
          <span>Status</span>
          <span>CPU</span>
          <span>Memory</span>
          <span className="text-right">Actions</span>
        </div>

        {/* Loading */}
        {isLoading && (
          <div className="space-y-px p-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-[68px] rounded-xl" />)}
          </div>
        )}

        {/* Error */}
        {!isLoading && error && (
          <div className="px-6 py-14 text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
              <Server className="h-5 w-5 text-destructive" />
            </div>
            <p className="text-sm font-semibold text-foreground">Backend unavailable</p>
            <p className="mt-1 text-xs text-muted-foreground">Failed to load VMs. Is the backend running?</p>
          </div>
        )}

        {/* Empty — no VMs */}
        {!isLoading && !error && total === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
              <Server className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-semibold text-foreground">No virtual machines yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Create your first VM to get started.</p>
            <Link to="/vms/new" className="mt-5">
              <Button size="sm"><Plus size={12} /> Create VM</Button>
            </Link>
          </div>
        )}

        {/* Empty — search */}
        {!isLoading && !error && total > 0 && filtered.length === 0 && (
          <div className="px-6 py-14 text-center">
            <p className="text-sm text-muted-foreground">
              No VMs matching <span className="font-semibold text-foreground">"{search}"</span>
            </p>
          </div>
        )}

        {/* Rows */}
        {!isLoading && !error && filtered.length > 0 && (
          <div className="divide-y divide-border/60">
            {filtered.map((vm) => (
              <VmRow key={vm.id} vm={vm} />
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: VmStatus }) {
  const { label, dot, bg, text } = statusConfig[status];
  const isRunning = status === 'running';

  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
      bg, text,
    )}>
      {isRunning ? (
        <span className="relative flex h-1.5 w-1.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
      ) : (
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
      )}
      {label}
    </span>
  );
}

// ─── VM row ───────────────────────────────────────────────────────────────────

function VmRow({ vm }: { vm: VmSummary }) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [flash, setFlash] = useState<'success' | 'error' | null>(null);
  const deleteVm = useDeleteVm();
  const action = useVmAction(vm.name);
  const logoSlug = useLogoStore((s) => s.vms[vm.name]);

  const triggerFlash = (type: 'success' | 'error') => {
    setFlash(type);
    setTimeout(() => setFlash(null), 700);
  };

  const handleAction = async (a: 'start' | 'stop' | 'reboot', force?: boolean) => {
    const label =
      a === 'stop'   ? (force ? 'Force off'   : 'Shutdown') :
      a === 'reboot' ? (force ? 'Hard reset'  : 'Reboot')   :
      'Start';
    try {
      await action.mutateAsync({ action: a, params: force ? { force: 'true' } : undefined });
      toast.success(`${label} command sent`);
      triggerFlash('success');
    } catch {
      toast.error(`Failed: ${label.toLowerCase()}`);
      triggerFlash('error');
    }
  };

  const handleDelete = async (deleteStorage: boolean) => {
    try {
      await deleteVm.mutateAsync({ name: vm.name, deleteStorage });
      toast.success(`${vm.name} deleted`);
      setDeleteOpen(false);
    } catch {
      toast.error('Failed to delete VM');
      triggerFlash('error');
    }
  };

  const isRunning = vm.status === 'running';
  const isPending = action.isPending;

  return (
    <>
      <div
        className={cn(
          'group grid items-center gap-4 px-5 py-3.5 transition-colors duration-100 hover:bg-muted/40',
          flash === 'success' && 'bg-emerald-500/10',
          flash === 'error'   && 'bg-destructive/10',
        )}
        style={{ gridTemplateColumns: COLS }}
      >
        {/* Name */}
        <div className="flex min-w-0 items-center gap-2.5">
          <VmLogo slug={logoSlug} size={28} />
          <div className="min-w-0">
            <Link
              to={`/vms/${vm.name}`}
              className="block truncate font-mono text-sm font-semibold text-foreground transition-colors hover:text-primary"
            >
              {vm.name}
            </Link>
            <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/50">
              {vm.id}
            </p>
          </div>
        </div>

        {/* Status */}
        <div>
          <StatusBadge status={vm.status} />
        </div>

        {/* CPU */}
        <div className="flex items-center gap-2">
          <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
          <div>
            <span className="font-mono text-sm font-semibold text-foreground">{vm.cpus}</span>
            <span className="ml-1 font-mono text-[10px] text-muted-foreground/70">vCPU</span>
          </div>
        </div>

        {/* Memory */}
        <div className="flex items-center gap-2">
          <MemoryStick className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
          <span className="font-mono text-sm font-semibold text-foreground">{formatMemory(vm.memoryMb)}</span>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-0.5">
          {vm.status === 'stopped' && (
            <Tooltip label="Power on">
              <ActionBtn
                onClick={() => handleAction('start')}
                disabled={isPending}
                className="hover:bg-emerald-500/10 hover:text-emerald-500 dark:hover:text-emerald-400"
              >
                <Power className="h-3.5 w-3.5" />
              </ActionBtn>
            </Tooltip>
          )}
          {isRunning && (
            <>
              <Tooltip label="Reboot (ACPI)">
                <ActionBtn
                  onClick={() => handleAction('reboot')}
                  disabled={isPending}
                  className="hover:bg-muted hover:text-foreground"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </ActionBtn>
              </Tooltip>
              <Tooltip label="Hard reset (immediate)">
                <ActionBtn
                  onClick={() => handleAction('reboot', true)}
                  disabled={isPending}
                  className="hover:bg-amber-500/10 hover:text-amber-500 dark:hover:text-amber-400"
                >
                  <Zap className="h-3.5 w-3.5" />
                </ActionBtn>
              </Tooltip>
              <Tooltip label="Shutdown (ACPI)">
                <ActionBtn
                  onClick={() => handleAction('stop')}
                  disabled={isPending}
                  className="hover:bg-red-500/10 hover:text-red-500 dark:hover:text-red-400"
                >
                  <Power className="h-3.5 w-3.5" />
                </ActionBtn>
              </Tooltip>
              <Tooltip label="Force off (kill immediately)">
                <ActionBtn
                  onClick={() => handleAction('stop', true)}
                  disabled={isPending}
                  className="hover:bg-red-500/20 hover:text-red-600 dark:hover:text-red-400"
                >
                  <PowerOff className="h-3.5 w-3.5" />
                </ActionBtn>
              </Tooltip>
            </>
          )}
          <Tooltip label="Console">
            <Link
              to={`/vms/${vm.name}/console`}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Terminal className="h-3.5 w-3.5" />
            </Link>
          </Tooltip>
          <Tooltip label="Delete VM">
            <ActionBtn
              onClick={() => setDeleteOpen(true)}
              className="hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </ActionBtn>
          </Tooltip>
        </div>
      </div>

      <DeleteDialog
        open={deleteOpen}
        vmName={vm.name}
        isPending={deleteVm.isPending}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
      />
    </>
  );
}

// ─── Action button ────────────────────────────────────────────────────────────

function ActionBtn({
  onClick, disabled, className, children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors disabled:opacity-40',
        className,
      )}
    >
      {children}
    </button>
  );
}

// ─── Delete dialog ────────────────────────────────────────────────────────────

function DeleteDialog({
  open, vmName, isPending, onClose, onConfirm,
}: {
  open: boolean;
  vmName: string;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (deleteStorage: boolean) => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Delete ${vmName}?`}
      description="This will undefine the VM in libvirt. Storage deletion is optional."
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onConfirm(false)} disabled={isPending}>
            Delete (keep storage)
          </Button>
          <Button variant="danger" size="sm" onClick={() => onConfirm(true)} disabled={isPending}>
            {isPending ? 'Deleting…' : 'Delete + storage'}
          </Button>
        </>
      }
    >
      <p className="text-sm text-foreground">
        The VM will be stopped and removed. Choose whether to also delete its disk images.
      </p>
    </Dialog>
  );
}
