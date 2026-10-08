import { cn } from '@/lib/cn';
import type { VmStatus } from '@/types';

// Status is a glyph plus a word. The glyph's *shape* carries the state as well as its
// colour — a solid disc is running, an open ring is off, two bars are paused, a
// diamond has crashed — so it still reads in greyscale and for colour-blind eyes.
const statusText: Record<VmStatus, string> = {
  running: 'text-emerald-700 dark:text-emerald-300',
  stopped: 'text-muted-foreground',
  paused: 'text-amber-700 dark:text-amber-300',
  crashed: 'text-red-700 dark:text-red-300',
  unknown: 'text-muted-foreground',
};

const statusLabels: Record<VmStatus, string> = {
  running: 'Running',
  stopped: 'Stopped',
  paused: 'Paused',
  crashed: 'Crashed',
  unknown: 'Unknown',
};

const glyphColour: Record<VmStatus, string> = {
  running: 'text-emerald-600 dark:text-emerald-400',
  stopped: 'text-slate-400 dark:text-slate-500',
  paused: 'text-amber-500 dark:text-amber-400',
  crashed: 'text-red-600 dark:text-red-400',
  unknown: 'text-muted-foreground/70',
};

export function StatusGlyph({ status, size = 8, className }: { status: VmStatus; size?: number; className?: string }) {
  const s = size;
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 8 8"
      aria-hidden
      className={cn('inline-block shrink-0', glyphColour[status] ?? glyphColour.unknown, className)}
    >
      {status === 'running' && <circle cx="4" cy="4" r="4" fill="currentColor" />}
      {status === 'stopped' && <circle cx="4" cy="4" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.6" />}
      {status === 'paused' && (
        <>
          <rect x="0.75" y="0.5" width="2.4" height="7" rx="0.6" fill="currentColor" />
          <rect x="4.85" y="0.5" width="2.4" height="7" rx="0.6" fill="currentColor" />
        </>
      )}
      {status === 'crashed' && <path d="M4 0 L8 4 L4 8 L0 4 Z" fill="currentColor" />}
      {status === 'unknown' && (
        <circle cx="4" cy="4" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="1.6 1.4" />
      )}
    </svg>
  );
}

export function StatusBadge({ status, label }: { status: VmStatus; label?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[12.5px] font-medium', statusText[status] ?? statusText.unknown)}>
      <StatusGlyph status={status} />
      {label ?? statusLabels[status]}
    </span>
  );
}

export function StatusDot({ status, size }: { status: VmStatus; size?: number }) {
  return <StatusGlyph status={status} size={size} />;
}

// Attention: a small solid triangle — for warnings that are not a VM state (TCG mode,
// a failing check). Same size and weight as the status glyphs it sits beside.
export function WarnGlyph({ size = 9, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden className={cn('inline-block shrink-0 text-amber-500 dark:text-amber-400', className)}>
      <path d="M5 0.6 L9.6 9.2 H0.4 Z" fill="currentColor" strokeLinejoin="round" />
    </svg>
  );
}
