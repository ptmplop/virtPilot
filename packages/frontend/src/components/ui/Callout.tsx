import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { WarnGlyph } from '@/components/ui/Badge';

// A note between fields or above a table — one recipe everywhere (DESIGN.md): attention is
// amber with the warning glyph, information is the quiet surface well. Both at 12.5px.
export const CALLOUT_INFO =
  'rounded-md border border-border bg-surface px-3.5 py-2.5 text-[12.5px] leading-relaxed text-muted-foreground';
export const CALLOUT_ATTENTION =
  'rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-amber-800 dark:text-amber-200';

export function Callout({
  tone = 'info', lead, children, className,
}: {
  tone?: 'info' | 'warn';
  /** A first sentence in the text's own colour, set apart from the explanation after it. */
  lead?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start gap-2', tone === 'warn' ? CALLOUT_ATTENTION : CALLOUT_INFO, className)}>
      {tone === 'warn' && <WarnGlyph className="mt-[5px]" />}
      <p className="min-w-0">
        {lead && <span className={cn('font-medium', tone === 'warn' ? '' : 'text-foreground')}>{lead} </span>}
        {children}
      </p>
    </div>
  );
}
