import { cn } from '@/lib/cn';
import type { VmStatus } from '@/types';

const statusStyles: Record<VmStatus, string> = {
  running: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
  stopped: 'bg-slate-500/15 text-slate-400 border-slate-500/20',
  paused: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
  crashed: 'bg-red-500/15 text-red-400 border-red-500/20',
  unknown: 'bg-muted text-muted-foreground border-border',
};

const statusLabels: Record<VmStatus, string> = {
  running: 'Running',
  stopped: 'Stopped',
  paused: 'Paused',
  crashed: 'Crashed',
  unknown: 'Unknown',
};

export function StatusBadge({ status }: { status: VmStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        statusStyles[status]
      )}
    >
      {statusLabels[status]}
    </span>
  );
}

export function StatusDot({ status }: { status: VmStatus }) {
  const dotColours: Record<VmStatus, string> = {
    running: 'bg-emerald-500',
    stopped: 'bg-slate-400',
    paused: 'bg-amber-400',
    crashed: 'bg-red-500',
    unknown: 'bg-muted-foreground',
  };
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', dotColours[status])} />;
}
