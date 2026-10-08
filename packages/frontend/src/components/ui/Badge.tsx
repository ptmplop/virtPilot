import { cn } from '@/lib/cn';
import type { VmStatus } from '@/types';

// Status is a coloured mark plus a word — no pill, no tint box. The word carries the
// meaning; colour only confirms it, so the badge still reads in greyscale.
const statusStyles: Record<VmStatus, string> = {
  running: 'text-emerald-700 dark:text-emerald-300',
  stopped: 'text-muted-foreground',
  paused: 'text-amber-700 dark:text-amber-300',
  crashed: 'text-red-600 dark:text-red-300',
  unknown: 'text-muted-foreground',
};

const markStyles: Record<VmStatus, string> = {
  running: 'bg-emerald-500',
  stopped: 'bg-slate-400 dark:bg-slate-500',
  paused: 'bg-amber-500',
  crashed: 'bg-red-500',
  unknown: 'bg-muted-foreground/50',
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
    <span className={cn('inline-flex items-center gap-1.5 text-[12px] font-medium', statusStyles[status])}>
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', markStyles[status])} />
      {statusLabels[status]}
    </span>
  );
}

export function StatusDot({ status }: { status: VmStatus }) {
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', markStyles[status])} />;
}
