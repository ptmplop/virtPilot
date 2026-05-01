import { useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  HardDrive,
  Network,
  RefreshCw,
  Server,
  Shield,
  Terminal,
  Trash2,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { useLogs, useClearLogs } from '@/hooks/useLogs';
import type { LogEntry } from '@/types';

// ─── Display metadata ─────────────────────────────────────────────────────────

const LOG_TYPE_LABELS: Record<string, string> = {
  'vm.create': 'Create VM',
  'vm.delete': 'Delete VM',
  'vm.start': 'Start VM',
  'vm.stop': 'Stop VM',
  'vm.stop.force': 'Force Stop VM',
  'vm.reboot': 'Reboot VM',
  'vm.disk.attach': 'Attach Disk',
  'vm.disk.detach': 'Detach Disk',
  'vm.cdrom.attach': 'Attach ISO',
  'vm.cdrom.detach': 'Eject ISO',
  'vm.nic.attach': 'Attach NIC',
  'vm.nic.detach': 'Detach NIC',
  'vm.snapshot.create': 'Create Snapshot',
  'vm.snapshot.delete': 'Delete Snapshot',
  'vm.snapshot.revert': 'Revert Snapshot',
  'vm.snapshot.export': 'Export Snapshot',
  'vm.firewall.apply': 'Apply Firewall',
  'vm.boot-order.set': 'Set Boot Order',
  'vm.boot-once': 'Boot Once',
  'network.create': 'Create Network',
  'network.delete': 'Delete Network',
  'network.port-forward.create': 'Create Port Forward',
  'network.port-forward.delete': 'Delete Port Forward',
  'system.apt.upgrade': 'APT Upgrade',
};

function typeLabel(type: string): string {
  return LOG_TYPE_LABELS[type] ?? type;
}

function TypeIcon({ type, className }: { type: string; className?: string }) {
  const cls = cn('h-3.5 w-3.5 shrink-0', className);
  if (type.startsWith('vm.snapshot')) return <HardDrive className={cls} />;
  if (type.startsWith('vm.disk') || type.startsWith('vm.cdrom')) return <HardDrive className={cls} />;
  if (type.startsWith('vm.nic')) return <Network className={cls} />;
  if (type.startsWith('vm.firewall')) return <Shield className={cls} />;
  if (type.startsWith('vm.')) return <Server className={cls} />;
  if (type.startsWith('network.')) return <Network className={cls} />;
  if (type.startsWith('system.apt')) return <Terminal className={cls} />;
  return <Terminal className={cls} />;
}

// ─── Filter categories shown in the pill bar ──────────────────────────────────

const TYPE_GROUPS = [
  { label: 'VMs', prefix: 'vm.' },
  { label: 'Networks', prefix: 'network.' },
  { label: 'System', prefix: 'system.' },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(ms?: number): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

// ─── Row component ────────────────────────────────────────────────────────────

function LogRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasOutput = !!entry.output;

  return (
    <div className="border-b border-border last:border-0">
      <button
        type="button"
        onClick={() => hasOutput && setExpanded((v) => !v)}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors',
          hasOutput ? 'cursor-pointer hover:bg-muted/30' : 'cursor-default'
        )}
      >
        {/* Expand chevron */}
        <span className="w-3.5 shrink-0 text-muted-foreground/40">
          {hasOutput ? (
            expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />
          ) : null}
        </span>

        {/* Status icon */}
        {entry.status === 'success' ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
        ) : (
          <XCircle className="h-4 w-4 shrink-0 text-destructive" />
        )}

        {/* Type + icon */}
        <span className="flex w-44 shrink-0 items-center gap-1.5 text-xs font-medium text-foreground">
          <TypeIcon type={entry.type} className="text-muted-foreground" />
          {typeLabel(entry.type)}
        </span>

        {/* Subject */}
        <span className="w-40 shrink-0 truncate font-mono text-xs text-muted-foreground">
          {entry.subject}
        </span>

        {/* Output preview */}
        <span className="flex-1 truncate text-xs text-muted-foreground/70">
          {entry.output ? entry.output.split('\n')[0] : ''}
        </span>

        {/* Duration */}
        {entry.durationMs != null && (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground/50">
            <Clock className="h-3 w-3" />
            {formatDuration(entry.durationMs)}
          </span>
        )}

        {/* Timestamp */}
        <span className="w-36 shrink-0 text-right text-[11px] text-muted-foreground/50">
          {formatTimestamp(entry.timestamp)}
        </span>
      </button>

      {expanded && entry.output && (
        <div className="border-t border-border/50 bg-muted/20 px-4 py-3">
          <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
            {entry.output}
          </pre>
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function LogsPage() {
  const { data: logs, isLoading, refetch, isFetching } = useLogs();
  const clearLogs = useClearLogs();

  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'error'>('all');

  const filtered = (logs ?? []).filter((e) => {
    if (groupFilter && !e.type.startsWith(groupFilter)) return false;
    if (statusFilter !== 'all' && e.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        e.subject.toLowerCase().includes(q) ||
        e.type.toLowerCase().includes(q) ||
        (e.output?.toLowerCase().includes(q) ?? false) ||
        typeLabel(e.type).toLowerCase().includes(q)
      );
    }
    return true;
  });

  async function handleClear() {
    if (!confirm('Clear all logs? This cannot be undone.')) return;
    clearLogs.mutate(undefined, {
      onSuccess: () => toast.success('Logs cleared'),
      onError: () => toast.error('Failed to clear logs'),
    });
  }

  const actions = (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void refetch()}
        disabled={isFetching}
        className="gap-1.5"
      >
        <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
        Refresh
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={handleClear}
        disabled={clearLogs.isPending || !logs?.length}
        className="gap-1.5"
      >
        <Trash2 className="h-3.5 w-3.5" />
        Clear Logs
      </Button>
    </div>
  );

  return (
    <Layout
      title="Logs"
      subtitle="Transaction history for all platform actions."
      actions={actions}
    >
      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search by type, subject, or output…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 w-64 text-sm"
        />

        <div className="flex items-center gap-1">
          <PillButton active={groupFilter === null} onClick={() => setGroupFilter(null)}>
            All
          </PillButton>
          {TYPE_GROUPS.map((g) => (
            <PillButton
              key={g.prefix}
              active={groupFilter === g.prefix}
              onClick={() => setGroupFilter(groupFilter === g.prefix ? null : g.prefix)}
            >
              {g.label}
            </PillButton>
          ))}
        </div>

        <div className="flex items-center gap-1">
          {(['all', 'success', 'error'] as const).map((s) => (
            <PillButton
              key={s}
              active={statusFilter === s}
              onClick={() => setStatusFilter(s)}
              variant={s === 'error' ? 'danger' : s === 'success' ? 'success' : undefined}
            >
              {s === 'all' ? 'Any status' : s.charAt(0).toUpperCase() + s.slice(1)}
            </PillButton>
          ))}
        </div>

        {logs && (
          <span className="ml-auto text-xs text-muted-foreground">
            {filtered.length} / {logs.length} entries
          </span>
        )}
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border bg-muted/40 px-4 py-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          <span className="w-3.5 shrink-0" />
          <span className="w-4 shrink-0" />
          <span className="w-44 shrink-0">Action</span>
          <span className="w-40 shrink-0">Subject</span>
          <span className="flex-1">Output</span>
          <span className="w-16 shrink-0 text-right">Duration</span>
          <span className="w-36 shrink-0 text-right">Timestamp</span>
        </div>

        {isLoading ? (
          <div className="space-y-px p-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10 rounded-lg" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
              <Terminal className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-semibold text-foreground">
              {logs?.length === 0 ? 'No logs yet' : 'No entries match the filters'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {logs?.length === 0 ? 'Actions will appear here as they run.' : 'Try adjusting or clearing the current filters.'}
            </p>
          </div>
        ) : (
          <div>
            {filtered.map((entry) => (
              <LogRow key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}

// ─── PillButton ───────────────────────────────────────────────────────────────

function PillButton({
  children,
  active,
  onClick,
  variant,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  variant?: 'danger' | 'success';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-all',
        active && !variant && 'border-primary/30 bg-primary/10 text-primary',
        active && variant === 'danger' && 'border-destructive/30 bg-destructive/10 text-destructive',
        active && variant === 'success' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500',
        !active && 'border-border text-muted-foreground hover:border-border/80 hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}
