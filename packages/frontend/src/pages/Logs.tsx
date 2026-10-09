import { useState } from 'react';
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
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
import { formatDuration } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { SearchInput } from '@/components/ui/SearchInput';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { useLogs, useClearLogs } from '@/hooks/useLogs';
import type { LogEntry } from '@/types';

// ─── Display metadata ─────────────────────────────────────────────────────────

// Every type the backend writes (grep appendLog in packages/backend). An unknown type
// still shows, as its raw key, so a new one is visible rather than silently dropped.
const LOG_TYPE_LABELS: Record<string, string> = {
  'vm.create': 'Create VM',
  'vm.clone': 'Clone VM',
  'vm.rename': 'Rename VM',
  'vm.delete': 'Delete VM',
  'vm.start': 'Start VM',
  'vm.stop': 'Stop VM',
  'vm.stop.force': 'Force off VM',
  'vm.reboot': 'Reboot VM',
  'vm.reboot.force': 'Hard reset VM',
  'vm.autostart.set': 'Set autostart',
  'vm.resources.update': 'Change resources',
  'vm.disk.attach': 'Attach disk',
  'vm.disk.detach': 'Detach disk',
  'vm.disk.resize': 'Resize disk',
  'vm.disk.move': 'Move disk',
  'vm.disk.download': 'Download disk',
  'vm.disk.orphan.delete': 'Delete orphaned disk',
  'vm.cdrom.attach': 'Attach ISO',
  'vm.cdrom.detach': 'Eject ISO',
  'vm.nic.attach': 'Attach NIC',
  'vm.nic.detach': 'Detach NIC',
  'vm.nic.bandwidth': 'Set NIC rate limit',
  'vm.device.attach': 'Attach device',
  'vm.device.detach': 'Detach device',
  'vm.snapshot.create': 'Create snapshot',
  'vm.snapshot.delete': 'Delete snapshot',
  'vm.snapshot.revert': 'Revert snapshot',
  'vm.snapshot.export': 'Export snapshot',
  'vm.firewall.apply': 'Apply firewall',
  'vm.boot-order.set': 'Set boot order',
  'vm.boot-once': 'Boot once',
  'backup.create': 'Back up VM',
  'backup.verify': 'Verify backup',
  'backup.restore': 'Restore backup',
  'backup.restore.new': 'Restore to new VM',
  'backup.sweep': 'Prune backups',
  'network.create': 'Create network',
  'network.delete': 'Delete network',
  'network.port-forward.create': 'Create port forward',
  'network.port-forward.delete': 'Delete port forward',
  'system.apt.upgrade': 'System upgrade (apt)',
  'system.virtpilot.upgrade': 'Upgrade VirtPilot',
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
  if (type.startsWith('backup.')) return <Archive className={cls} />;
  if (type.startsWith('network.')) return <Network className={cls} />;
  if (type.startsWith('system.apt')) return <Terminal className={cls} />;
  return <Terminal className={cls} />;
}

// ─── Filter categories shown in the type filter ──────────────────────────────────

const TYPE_GROUPS = [
  { label: 'VMs', prefix: 'vm.' },
  { label: 'Backups', prefix: 'backup.' },
  { label: 'Networks', prefix: 'network.' },
  { label: 'System', prefix: 'system.' },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  // Dense on purpose (no year, with seconds), but in the app's day-month order.
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
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
        aria-expanded={hasOutput ? expanded : undefined}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors',
          hasOutput ? 'cursor-pointer hover:bg-surface/70' : 'cursor-default'
        )}
      >
        {/* Expand chevron */}
        <span className="w-3.5 shrink-0 text-muted-foreground">
          {hasOutput ? (
            expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />
          ) : null}
        </span>

        {/* Status icon */}
        {entry.status === 'success' ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <XCircle className="h-4 w-4 shrink-0 text-destructive" />
        )}

        {/* Type + icon */}
        <span className="flex w-44 shrink-0 items-center gap-1.5 text-[13px] font-medium text-foreground">
          <TypeIcon type={entry.type} className="text-muted-foreground" />
          {typeLabel(entry.type)}
        </span>

        {/* Subject */}
        <span className="w-40 shrink-0 truncate font-mono text-[12px] text-muted-foreground">
          {entry.subject}
        </span>

        {/* Output preview */}
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
          {entry.output ? entry.output.split('\n')[0] : ''}
        </span>

        {/* Duration — a fixed column, so the output's edge doesn't move from row to row */}
        <span className="w-16 shrink-0 text-right text-[12px] tabular-nums text-muted-foreground">
          {entry.durationMs != null ? formatDuration(entry.durationMs) : '—'}
        </span>

        {/* Timestamp */}
        <span className="w-36 shrink-0 text-right text-[12px] tabular-nums text-muted-foreground">
          {formatTimestamp(entry.timestamp)}
        </span>
      </button>

      {expanded && entry.output && (
        <div className="border-t border-border bg-surface px-4 py-3">
          <pre className="whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-foreground">
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
        Clear logs
      </Button>
    </div>
  );

  return (
    <Layout
      title="Logs"
      subtitle="A record of every action taken in VirtPilot."
      actions={actions}
    >
      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <SearchInput
          className="max-w-[17rem]"
          value={search}
          onChange={setSearch}
          placeholder="Search by type, subject or output…"
          label="Search logs"
        />

        <div className="segmented" role="group" aria-label="Filter by type">
          <button type="button" aria-pressed={groupFilter === null} onClick={() => setGroupFilter(null)}>
            All
          </button>
          {TYPE_GROUPS.map((g) => (
            <button
              type="button"
              key={g.prefix}
              aria-pressed={groupFilter === g.prefix}
              onClick={() => setGroupFilter(groupFilter === g.prefix ? null : g.prefix)}
            >
              {g.label}
            </button>
          ))}
        </div>

        <div className="segmented" role="group" aria-label="Filter by outcome">
          {(['all', 'success', 'error'] as const).map((s) => (
            <button
              type="button"
              key={s}
              aria-pressed={statusFilter === s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                statusFilter === s && s === 'error' && '!text-red-700 dark:!text-red-300',
                statusFilter === s && s === 'success' && '!text-emerald-700 dark:!text-emerald-300',
              )}
            >
              {s === 'all' ? 'Any outcome' : s === 'success' ? 'Succeeded' : 'Failed'}
            </button>
          ))}
        </div>

        {logs && (
          <span className="ml-auto text-[12.5px] tabular-nums text-muted-foreground">
            {filtered.length} of {logs.length} entries
          </span>
        )}
      </div>

      {/* Table */}
      <div className="panel overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border bg-muted/40 px-4 py-2 text-[12px] font-medium text-muted-foreground">
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
            <Terminal className="mb-3 h-5 w-5 text-muted-foreground" />
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
