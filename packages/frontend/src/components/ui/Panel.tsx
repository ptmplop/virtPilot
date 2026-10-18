import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

// A panel is one instrument on the sheet. Its title bar names it on the left and
// carries readouts or actions on the right; the body is whatever it measures.
// Panels never float (no lift, no glow) — a hairline is the whole frame.

export function Panel({
  children, className, as: Tag = 'div', ...rest
}: { children: ReactNode; className?: string; as?: 'div' | 'section' } & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag className={cn('panel', className)} {...rest}>
      {children}
    </Tag>
  );
}

export function PanelHeader({
  title, meta, icon, actions, className,
}: {
  title: ReactNode;
  /** Quiet text after the title: a count, a state, a hint. */
  meta?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('panel-head', className)}>
      {icon && <span className="flex shrink-0 text-muted-foreground">{icon}</span>}
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h3 className="panel-title shrink-0">{title}</h3>
        {meta && <span className="panel-meta min-w-0 truncate">{meta}</span>}
      </div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

// A row of readouts in one ruled strip — label over value, cells split by hairlines.
// Replaces the grid of identical stat cards: one instrument, several dials.
export function StatStrip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'panel grid grid-cols-2 divide-border sm:auto-cols-fr sm:grid-flow-col sm:grid-cols-none sm:divide-x',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Stat({
  label, value, sub, tone, className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  /** Colours the value only when it carries meaning (running, failing…). */
  tone?: 'ok' | 'warn' | 'danger' | 'muted';
  className?: string;
}) {
  const toneClass =
    tone === 'ok' ? 'text-emerald-700 dark:text-emerald-300'
    : tone === 'warn' ? 'text-amber-700 dark:text-amber-300'
    : tone === 'danger' ? 'text-red-700 dark:text-red-300'
    : tone === 'muted' ? 'text-muted-foreground'
    : 'text-foreground';
  return (
    <div className={cn('min-w-0 px-5 py-4 [&:nth-child(n+3)]:border-t sm:[&:nth-child(n+3)]:border-t-0', className)}>
      <p className="readout-label truncate">{label}</p>
      <p className={cn('readout-value mt-1.5 truncate', toneClass)}>{value}</p>
      {/* A phone's half-width cell would cut the sub-line's qualifier off; there it wraps. */}
      {sub && <p className="mt-0.5 text-[12px] text-muted-foreground sm:truncate">{sub}</p>}
    </div>
  );
}
