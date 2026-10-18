import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  CopyPlus,
  Plus,
  Power,
  PowerOff,
  RotateCcw,
  Server,
  Terminal,
  Trash2,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { SearchInput } from '@/components/ui/SearchInput';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tooltip } from '@/components/ui/Tooltip';
import { CloneVmDialog } from '@/components/CloneVmDialog';
import { useVms, useDeleteVm, useVmAction } from '@/hooks/useVms';
import { formatMemory } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { VmSummary } from '@/types';
import { Panel, Stat, StatStrip } from '@/components/ui/Panel';
import { StatusBadge } from '@/components/ui/Badge';
import { VmLogo } from '@/components/ui/OsLogoPicker';
import { Menu } from '@/components/ui/Menu';
import { DeleteVmDialog } from '@/components/DeleteVmDialog';
import { useLogoStore } from '@/store/logoStore';
import { osSlugFromImage } from '@/data/templateSets';
import { useUserPrefsStore } from '@/store/userPrefsStore';
import { openVmConsole } from '@/lib/consoleOpener';

// The actions column fits a running VM's seven buttons and two dividers (256px); the
// fixed columns are kept tight so the name still has room at 1024px.
// Columns step down with the room there is: every column from 1024px; name, status
// and actions from 640px (a tablet beside the sidebar); name and status on a phone,
// where the row itself opens the VM and every action is on its page.
const COLS = 'grid-cols-[minmax(0,1fr)_96px] sm:grid-cols-[minmax(0,1fr)_104px_168px] lg:grid-cols-[minmax(0,1fr)_104px_72px_80px_168px]';
const WIDE_ONLY = 'hidden lg:block';

// ─── Page ─────────────────────────────────────────────────────────────────────

export function VmsPage() {
  const [search, setSearch] = useState('');
  const { data: vms, isLoading, error } = useVms();

  const total      = vms?.length ?? 0;
  const running    = vms?.filter((v) => v.status === 'running').length ?? 0;
  const stopped    = vms?.filter((v) => v.status === 'stopped').length ?? 0;
  const totalCpus  = vms?.reduce((s, v) => s + v.cpus, 0) ?? 0;

  const filtered = (vms ?? []).filter((v) =>
    v.name.toLowerCase().includes(search.toLowerCase().trim())
  );

  const subtitle = 'Every virtual machine defined on this host.';

  return (
    <Layout
      title="Virtual machines"
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
      {/* Stats */}
      <StatStrip className="mb-6">
        <Stat label="Virtual machines" value={isLoading ? '—' : total} />
        <Stat label="Running" value={isLoading ? '—' : running} tone={running > 0 ? 'ok' : undefined} />
        <Stat label="Stopped" value={isLoading ? '—' : stopped} />
        <Stat label="vCPUs allocated" value={isLoading ? '—' : totalCpus} />
      </StatStrip>

      {/* Search + console-popup pref */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SearchInput
          className="max-w-sm"
          value={search}
          onChange={setSearch}
          placeholder="Search virtual machines…"
          label="Search virtual machines"
        />
        {!isLoading && total > 0 && <ConsolePopupToggle />}
      </div>

      {/* Table */}
      <Panel className="overflow-hidden">
        {/* Header */}
        <div className={cn('table-head grid items-center gap-3 px-5 py-2.5', COLS)}>
          <span>Name</span>
          <span>Status</span>
          <span className={cn(WIDE_ONLY, 'text-right')}>CPU</span>
          <span className={cn(WIDE_ONLY, 'text-right')}>Memory</span>
          <span className="hidden text-right sm:block">Actions</span>
        </div>

        {/* Loading */}
        {isLoading && (
          <div className="space-y-2 p-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-[52px] rounded-md" />)}
          </div>
        )}

        {/* Error */}
        {!isLoading && error && (
          <div className="px-6 py-14 text-center">
            <Server className="mx-auto mb-3 h-5 w-5 text-destructive" />
            <p className="text-[13.5px] font-semibold text-foreground">Backend unavailable</p>
            <p className="mt-1 text-[13px] text-muted-foreground">Failed to load VMs. Is the backend running?</p>
          </div>
        )}

        {/* Empty — no VMs */}
        {!isLoading && !error && total === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Server className="mb-3 h-5 w-5 text-muted-foreground" />
            <p className="text-[13.5px] font-semibold text-foreground">No virtual machines yet</p>
            <p className="mt-1 text-[13px] text-muted-foreground">Create your first VM to get started.</p>
            <Link to="/vms/new" className="mt-5">
              <Button size="sm"><Plus size={13} /> Create VM</Button>
            </Link>
          </div>
        )}

        {/* Empty — search */}
        {!isLoading && !error && total > 0 && filtered.length === 0 && (
          <div className="px-6 py-14 text-center">
            <p className="text-[13px] text-muted-foreground">
              No VMs matching <span className="font-semibold text-foreground">“{search}”</span>
            </p>
          </div>
        )}

        {/* Rows */}
        {!isLoading && !error && filtered.length > 0 && (
          <div className="divide-y divide-border">
            {filtered.map((vm) => (
              <VmRow key={vm.id} vm={vm} />
            ))}
          </div>
        )}
      </Panel>
    </Layout>
  );
}

// ─── Console popup toggle ─────────────────────────────────────────────────────

function ConsolePopupToggle() {
  const openConsoleInPopup = useUserPrefsStore((s) => s.openConsoleInPopup);
  const setOpenConsoleInPopup = useUserPrefsStore((s) => s.setOpenConsoleInPopup);
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-[13px] text-muted-foreground">
      <Terminal size={14} className="shrink-0" />
      <span>Open consoles in a popup</span>
      <button
        type="button"
        role="switch"
        aria-checked={openConsoleInPopup}
        aria-label="Open VM consoles in a popup window"
        onClick={() => setOpenConsoleInPopup(!openConsoleInPopup)}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          openConsoleInPopup ? 'bg-primary' : 'bg-input hover:bg-muted-foreground/40',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-[left] duration-200',
            openConsoleInPopup ? 'left-[18px]' : 'left-0.5',
          )}
        />
      </button>
    </label>
  );
}

// ─── VM row ───────────────────────────────────────────────────────────────────

function VmRow({ vm }: { vm: VmSummary }) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [flash, setFlash] = useState<'success' | 'error' | null>(null);
  const deleteVm = useDeleteVm();
  const action = useVmAction(vm.id);
  // The logo chosen for this VM, else the one its template implies (as on the dashboard).
  const logoSlug = useLogoStore((s) => s.vms[vm.name]) ?? osSlugFromImage(vm.sourceTemplateFilename);
  const openConsoleInPopup = useUserPrefsStore((s) => s.openConsoleInPopup);
  const navigate = useNavigate();

  const triggerFlash = (type: 'success' | 'error') => {
    setFlash(type);
    setTimeout(() => setFlash(null), 700);
  };

  const handleAction = async (a: 'start' | 'stop' | 'reboot', force?: boolean) => {
    const label =
      a === 'stop'   ? (force ? 'Force off'   : 'Power off') :
      a === 'reboot' ? (force ? 'Hard reset'  : 'Reboot')    :
      'Power on';
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
      await deleteVm.mutateAsync({ uuid: vm.id, deleteStorage });
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
        // The whole row opens the VM: the name's link is stretched over it (one tab stop
        // per row), and the actions sit above that layer.
        className={cn(
          'group relative grid items-center gap-3 px-5 py-3 transition-colors duration-100 hover:bg-surface/70 has-[a:focus-visible]:bg-surface/70',
          COLS,
          flash === 'success' && 'bg-emerald-500/10',
          flash === 'error'   && 'bg-destructive/10',
        )}
      >
        {/* Name */}
        <div className="flex min-w-0 items-center gap-3">
          <VmLogo slug={logoSlug} size={24} />
          <div className="min-w-0">
            <Link
              to={`/vms/${vm.id}`}
              className="block truncate text-[13.5px] font-semibold text-foreground transition-colors after:absolute after:inset-0 after:content-[''] group-hover:text-primary"
            >
              {vm.name}
            </Link>
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
              {vm.id}
            </p>
          </div>
        </div>

        {/* Status */}
        <div>
          <StatusBadge status={vm.status} />
        </div>

        {/* CPU — quantities in Inter's tabular figures, right-aligned; mono is for identifiers */}
        <div className={cn(WIDE_ONLY, 'text-right text-[13px] tabular-nums')}>
          <span className="font-semibold text-foreground">{vm.cpus}</span>
          <span className="ml-1 text-muted-foreground">vCPU</span>
        </div>

        {/* Memory */}
        <div className={cn(WIDE_ONLY, 'text-right text-[13px] font-semibold tabular-nums text-foreground')}>
          {formatMemory(vm.memoryMb)}
        </div>

        {/* Actions */}
        <div className="relative z-10 hidden items-center justify-end gap-0.5 sm:flex">
          {vm.status === 'stopped' && (
            <Tooltip label="Power on">
              <ActionBtn
                label="Power on"
                onClick={() => handleAction('start')}
                disabled={isPending}
                className="hover:bg-emerald-500/10 hover:text-emerald-700 dark:hover:text-emerald-300"
              >
                <Power className="h-3.5 w-3.5" />
              </ActionBtn>
            </Tooltip>
          )}
          {/* One power control per row: Power on when stopped; when running, the four
              power commands sit behind one button, graceful above forceful, so a row
              never needs seven icons and the name keeps its width. */}
          {(isRunning || vm.status === 'paused' || vm.status === 'crashed') && (
            <Menu
              label={`Power: ${vm.name}`}
              tooltip="Power"
              icon={<Power className="h-3.5 w-3.5" />}
              disabled={isPending}
              items={isRunning ? [
                { label: 'Reboot', hint: 'ACPI', icon: <RotateCcw className="h-3.5 w-3.5" />, onSelect: () => handleAction('reboot') },
                { label: 'Power off', hint: 'ACPI', icon: <Power className="h-3.5 w-3.5" />, onSelect: () => handleAction('stop') },
                { label: 'Hard reset', hint: 'immediate', icon: <Zap className="h-3.5 w-3.5" />, onSelect: () => handleAction('reboot', true), separated: true },
                { label: 'Force off', hint: 'immediate', icon: <PowerOff className="h-3.5 w-3.5" />, onSelect: () => handleAction('stop', true), danger: true },
              ] : [
                // Paused or crashed: nothing graceful can answer, but it can be forced off.
                { label: 'Force off', hint: 'immediate', icon: <PowerOff className="h-3.5 w-3.5" />, onSelect: () => handleAction('stop', true), danger: true },
              ]}
            />
          )}
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          <Tooltip label={openConsoleInPopup ? 'Open console (popup)' : 'Open console'}>
            <a
              href={`/vms/${vm.id}/console`}
              aria-label="Open console"
              // Keep <a href> so middle-click / cmd-click / ctrl-click still open
              // in a new tab. Plain left-click is intercepted and routed
              // through openVmConsole, which honours the popup pref.
              onClick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
                e.preventDefault();
                openVmConsole(vm.id, openConsoleInPopup, navigate);
              }}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Terminal className="h-3.5 w-3.5" />
            </a>
          </Tooltip>
          <Tooltip label="Clone VM">
            <ActionBtn
              label="Clone VM"
              onClick={() => setCloneOpen(true)}
              className="hover:bg-muted hover:text-foreground"
            >
              <CopyPlus className="h-3.5 w-3.5" />
            </ActionBtn>
          </Tooltip>
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          <Tooltip label="Delete VM">
            <ActionBtn
              label="Delete VM"
              onClick={() => setDeleteOpen(true)}
              className="hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </ActionBtn>
          </Tooltip>
        </div>
      </div>

      <DeleteVmDialog
        open={deleteOpen}
        vmName={vm.name}
        isPending={deleteVm.isPending}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
      />

      {cloneOpen && (
        <CloneVmDialog
          open
          vmUuid={vm.id}
          vmName={vm.name}
          vmStatus={vm.status}
          onClose={() => setCloneOpen(false)}
        />
      )}
    </>
  );
}

// ─── Action button ────────────────────────────────────────────────────────────

function ActionBtn({
  label, onClick, disabled, className, children,
}: {
  label: string;
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
      aria-label={label}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors disabled:opacity-40',
        className,
      )}
    >
      {children}
    </button>
  );
}
