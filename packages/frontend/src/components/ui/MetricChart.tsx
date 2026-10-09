import { useEffect, useMemo, useRef, useState } from 'react';

interface MetricChartProps {
  id: string;
  data: number[];
  color: string;
  data2?: number[];
  color2?: string;
  timestamps: number[];
  formatY: (v: number) => string;
  formatX: (ts: number) => string;
  /** Fixed Y-axis maximum. When omitted, derived from data via niceMax(). */
  max?: number;
  /** Lowest auto-scaled maximum. An idle byte-rate series otherwise gets a 0–1 axis whose
   *  rounded labels repeat ("1 B/s, 1 B/s, 0 B/s"); 1024 gives 0 / 256 B/s … 1.0 KB/s. */
  minMax?: number;
  /** Plot area height in px. Total component height is this + 18 for X labels. */
  height?: number;
  /** Series names for the hover readout (e.g. ['Read', 'Write']); a lone series needs none. */
  labels?: [string, string?];
  /** How the readout states the moment; defaults to the axis format. */
  formatTime?: (ts: number) => string;
}

const Y_TICK_COUNT = 5;
const X_LABEL_COUNT = 5;
const Y_LABEL_WIDTH = 68;

function buildPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return '';
  let d = `M ${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const curr = pts[i];
    const dx = (curr.x - prev.x) / 2.5;
    d += ` C ${prev.x + dx},${prev.y} ${curr.x - dx},${curr.y} ${curr.x},${curr.y}`;
  }
  return d;
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  const norm = value / exp;
  let mult = 1;
  if (norm > 5) mult = 10;
  else if (norm > 2) mult = 5;
  else if (norm > 1) mult = 2;
  return mult * exp;
}

export function MetricChart({
  id, data, color, data2, color2, timestamps, formatY, formatX, max, minMax, height = 200, labels, formatTime,
}: MetricChartProps) {
  // Hover (or tap) readout: a hairline at the nearest sample, a dot on each line and a
  // small panel with the moment and the exact values. The plot SVG is stretched
  // (preserveAspectRatio="none"), so everything here is HTML positioned in percent.
  const plotRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false);
  const n = data.length;
  const indexAt = (clientX: number): number | null => {
    const r = plotRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || n < 2) return null;
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.round(ratio * (n - 1));
  };
  // A tap pins the readout on touch screens; the next tap anywhere else clears it.
  useEffect(() => {
    if (!pinned) return;
    const off = (e: PointerEvent) => {
      if (!plotRef.current?.contains(e.target as Node)) { setHover(null); setPinned(false); }
    };
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [pinned]);
  // New data can shorten the series under the pointer.
  const at = hover != null && hover < n ? hover : null;

  const W = 800;
  const H = 200;

  const yMax = useMemo(() => {
    if (max != null) return max;
    const peak = Math.max(...data, ...(data2 ?? []), 0);
    return Math.max(niceMax(peak), minMax ?? 0);
  }, [data, data2, max, minMax]);

  const { line1, fill1, line2, fill2 } = useMemo(() => {
    const safeMax = yMax > 0 ? yMax : 1;
    const toPoints = (arr: number[]) =>
      arr.map((v, i) => ({
        x: (i / Math.max(arr.length - 1, 1)) * W,
        y: H - (Math.min(v, safeMax) / safeMax) * H,
      }));
    const pts1 = toPoints(data);
    const pts2 = data2 ? toPoints(data2) : [];
    const l1 = buildPath(pts1);
    const f1 = l1 ? `${l1} L ${W},${H} L 0,${H} Z` : '';
    const l2 = buildPath(pts2);
    const f2 = l2 ? `${l2} L ${W},${H} L 0,${H} Z` : '';
    return { line1: l1, fill1: f1, line2: l2, fill2: f2 };
  }, [data, data2, yMax]);

  // Latest sample of each series, as a top-offset % within the plot area — used
  // to render a glowing "live" marker pinned to the right edge of the chart.
  const endpoints = useMemo(() => {
    const safeMax = yMax > 0 ? yMax : 1;
    const last = (arr: number[] | undefined, col: string | undefined) => {
      if (!arr || arr.length === 0 || !col) return null;
      const v = arr[arr.length - 1];
      return { top: (1 - Math.min(v, safeMax) / safeMax) * 100, color: col };
    };
    return [last(data, color), last(data2, color2)].filter(
      (e): e is { top: number; color: string } => e !== null,
    );
  }, [data, data2, color, color2, yMax]);

  // Y ticks rendered top→bottom: index 0 is the max value at top, last is 0 at bottom.
  const yTicks = Array.from(
    { length: Y_TICK_COUNT },
    (_, i) => (yMax * (Y_TICK_COUNT - 1 - i)) / (Y_TICK_COUNT - 1),
  );

  const xCount = Math.min(X_LABEL_COUNT, timestamps.length);
  const xIndices = xCount < 2
    ? [Math.max(timestamps.length - 1, 0)]
    : Array.from(
        { length: xCount },
        (_, i) => Math.round((i * (timestamps.length - 1)) / (xCount - 1)),
      );

  return (
    <div
      className="grid w-full text-border"
      style={{
        gridTemplateColumns: `${Y_LABEL_WIDTH}px 1fr`,
        gridTemplateRows: `${height}px 18px`,
      }}
    >
      {/* Y axis labels */}
      <div className="relative">
        {yTicks.map((v, i) => (
          <span
            key={i}
            className="nums absolute right-2.5 whitespace-nowrap text-[11px] text-muted-foreground"
            style={{
              top: `${(i / (Y_TICK_COUNT - 1)) * 100}%`,
              transform: 'translateY(-50%)',
            }}
          >
            {formatY(v)}
          </span>
        ))}
      </div>

      {/* Plot area */}
      <div
        ref={plotRef}
        className="relative touch-pan-y"
        onPointerMove={(e) => { if (e.pointerType === 'mouse' || e.buttons) setHover(indexAt(e.clientX)); }}
        onPointerDown={(e) => { if (e.pointerType !== 'mouse') { setHover(indexAt(e.clientX)); setPinned(true); } }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover(null); }}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          aria-hidden
        >
          <defs>
            <linearGradient id={`mg-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.14" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
            {color2 && (
              <linearGradient id={`mg2-${id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color2} stopOpacity="0.1" />
                <stop offset="100%" stopColor={color2} stopOpacity="0" />
              </linearGradient>
            )}
          </defs>

          {yTicks.map((_, i) => {
            const y = (i / (Y_TICK_COUNT - 1)) * H;
            const isBaseline = i === Y_TICK_COUNT - 1;
            return (
              <line
                key={i}
                x1="0"
                x2={W}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeOpacity={isBaseline ? 1 : 0.7}
                strokeWidth="1"
                strokeDasharray={isBaseline ? undefined : '2 4'}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {fill1 && <path d={fill1} fill={`url(#mg-${id})`} />}
          {line1 && (
            <path
              d={line1}
              fill="none"
              stroke={color}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {fill2 && color2 && <path d={fill2} fill={`url(#mg2-${id})`} />}
          {line2 && color2 && (
            <path
              d={line2}
              fill="none"
              stroke={color2}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              strokeDasharray="4 2"
            />
          )}
        </svg>

        {at != null && (() => {
          const safeMax = yMax > 0 ? yMax : 1;
          const x = (at / Math.max(n - 1, 1)) * 100;
          const y = (v: number) => (1 - Math.min(Math.max(v, 0), safeMax) / safeMax) * 100;
          const v1 = data[at];
          const v2 = data2?.[at];
          const ts = timestamps[at];
          return (
            <>
              <span className="pointer-events-none absolute inset-y-0 w-px bg-foreground/25" style={{ left: `${x}%` }} />
              <span
                className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card"
                style={{ left: `${x}%`, top: `${y(v1)}%`, background: color }}
              />
              {v2 != null && color2 && (
                <span
                  className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card"
                  style={{ left: `${x}%`, top: `${y(v2)}%`, background: color2 }}
                />
              )}
              <div
                className="pointer-events-none absolute top-1 z-10 min-w-[7.5rem] rounded-md border border-border bg-card px-2.5 py-1.5 shadow-pop"
                style={x > 58 ? { right: `calc(${100 - x}% + 10px)` } : { left: `calc(${x}% + 10px)` }}
              >
                {ts != null && (
                  <p className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">{(formatTime ?? formatX)(ts)}</p>
                )}
                <ReadoutRow color={color} label={labels?.[0]} value={formatY(v1)} />
                {v2 != null && color2 && <ReadoutRow color={color2} label={labels?.[1]} value={formatY(v2)} dashed />}
              </div>
            </>
          );
        })()}

        {/* "Live" endpoint marker(s), pinned to the right edge */}
        {endpoints.map((e, i) => (
          <span
            key={i}
            className="pointer-events-none absolute"
            style={{ left: '100%', top: `${e.top}%`, transform: 'translate(-100%, -50%)' }}
          >
            <span
              className="relative block h-[7px] w-[7px] rounded-full ring-2 ring-card"
              style={{ background: e.color }}
            />
          </span>
        ))}
      </div>

      {/* Empty cell beneath Y labels */}
      <div />

      {/* X axis labels */}
      <div className="relative">
        {xIndices.map((idx, i) => {
          const ts = timestamps[idx];
          if (ts == null) return null;
          const left = (idx / Math.max(timestamps.length - 1, 1)) * 100;
          const isFirst = i === 0;
          const isLast = i === xIndices.length - 1;
          const transform = isFirst
            ? undefined
            : isLast
              ? 'translateX(-100%)'
              : 'translateX(-50%)';
          return (
            <span
              key={idx}
              className="nums absolute top-1 whitespace-nowrap text-[11px] text-muted-foreground"
              style={{ left: `${left}%`, transform }}
            >
              {formatX(ts)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// One line of the readout, keyed by the series' own stroke (dashed for the outbound one).
function ReadoutRow({ color, label, value, dashed }: { color: string; label?: string; value: string; dashed?: boolean }) {
  return (
    <p className="mt-1 flex items-center gap-2 whitespace-nowrap text-[12.5px]">
      <svg width="14" height="8" aria-hidden className="shrink-0">
        <line x1="1" y1="4" x2="13" y2="4" stroke={color} strokeWidth="2" strokeLinecap="round" strokeDasharray={dashed ? '3 2.5' : undefined} />
      </svg>
      {label && <span className="text-muted-foreground">{label}</span>}
      <span className="ml-auto pl-2 font-semibold tabular-nums text-foreground">{value}</span>
    </p>
  );
}
