import type { ReactNode } from 'react';
import { useCountUp } from '@/hooks/useCountUp';
import { cn } from '@/lib/cn';

// The logo's instrument ring, used as a gauge. Same geometry as the mark: a ring with
// a 40° gap centred on 45° (up and to the right, where the needle leaves the dial).
// The track runs clockwise from the gap's lower edge round to its upper edge, 320° in
// all, and the reading fills it in that direction — so an empty gauge is the logo's
// ring and a full one closes on the gap. Butt caps keep the gap's edges radial, as
// they are in the mark.

const GAP_CENTRE = 45;
const GAP = 40;
const START = GAP_CENTRE - GAP / 2; // 25°, the gap's lower edge (maths angle, y up)
const SWEEP = 360 - GAP; // 320°

function point(c: number, r: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  return { x: c + r * Math.cos(a), y: c - r * Math.sin(a) };
}

/** Clockwise arc from START through `sweep` degrees. */
function arc(c: number, r: number, sweep: number): string {
  if (sweep <= 0.01) return '';
  const s = point(c, r, START);
  const e = point(c, r, START - sweep);
  const large = sweep > 180 ? 1 : 0;
  return `M ${s.x.toFixed(3)} ${s.y.toFixed(3)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(3)} ${e.y.toFixed(3)}`;
}

export type GaugeTone = 'steel' | 'ok' | 'warn' | 'danger' | 'muted';

// Stroke colours: graphics need 3:1 against the panel in each theme.
const TONE: Record<GaugeTone, string> = {
  steel: 'stroke-[#4F7CAC] dark:stroke-[#86AEDA]',
  ok: 'stroke-emerald-600 dark:stroke-emerald-400',
  warn: 'stroke-amber-500 dark:stroke-amber-400',
  danger: 'stroke-red-600 dark:stroke-red-400',
  muted: 'stroke-muted-foreground/50',
};

interface RingGaugeProps {
  /** 0–1 */
  value: number;
  size?: number;
  stroke?: number;
  tone?: GaugeTone;
  /** Centre content — usually the reading. */
  children?: ReactNode;
  className?: string;
  label?: string;
}

export function RingGauge({
  value, size = 88, stroke = 7, tone = 'steel', children, className, label,
}: RingGaugeProps) {
  // Glide between polls rather than snapping; counts up from empty on mount.
  const shown = useCountUp(Math.max(0, Math.min(1, value)) * 1000, 900) / 1000;
  const c = size / 2;
  const r = (size - stroke) / 2;
  return (
    <div
      className={cn('relative shrink-0', className)}
      style={{ width: size, height: size }}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="block">
        <path d={arc(c, r, SWEEP)} fill="none" strokeWidth={stroke} className="stroke-gauge-track" />
        {shown > 0.002 && (
          <path
            d={arc(c, r, SWEEP * shown)}
            fill="none"
            strokeWidth={stroke}
            className={cn('gauge-arc transition-[stroke] duration-300', TONE[tone])}
          />
        )}
      </svg>
      {children && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
      )}
    </div>
  );
}
