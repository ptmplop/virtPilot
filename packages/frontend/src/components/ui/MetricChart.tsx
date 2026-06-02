import { useMemo } from 'react';

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
  /** Plot area height in px. Total component height is this + 18 for X labels. */
  height?: number;
}

const Y_TICK_COUNT = 5;
const X_LABEL_COUNT = 5;
const Y_LABEL_WIDTH = 56;

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
  id, data, color, data2, color2, timestamps, formatY, formatX, max, height = 200,
}: MetricChartProps) {
  const W = 800;
  const H = 200;

  const yMax = useMemo(() => {
    if (max != null) return max;
    const peak = Math.max(...data, ...(data2 ?? []), 0);
    return niceMax(peak);
  }, [data, data2, max]);

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
            className="nums absolute right-2 text-[10px] text-muted-foreground"
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
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          aria-hidden
        >
          <defs>
            <linearGradient id={`mg-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.3" />
              <stop offset="100%" stopColor={color} stopOpacity="0.02" />
            </linearGradient>
            {color2 && (
              <linearGradient id={`mg2-${id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color2} stopOpacity="0.22" />
                <stop offset="100%" stopColor={color2} stopOpacity="0.02" />
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
                strokeOpacity={isBaseline ? 0.6 : 0.3}
                strokeWidth="1"
                strokeDasharray={isBaseline ? undefined : '3 3'}
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
              style={{ filter: `drop-shadow(0 1px 3px ${color}55)` }}
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
              style={{ filter: `drop-shadow(0 1px 3px ${color2}55)` }}
            />
          )}
        </svg>

        {/* Glowing "live" endpoint marker(s), pinned to the right edge */}
        {endpoints.map((e, i) => (
          <span
            key={i}
            className="pointer-events-none absolute"
            style={{ left: '100%', top: `${e.top}%`, transform: 'translate(-100%, -50%)' }}
          >
            <span
              className="absolute left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full animate-glow-pulse"
              style={{ background: e.color, opacity: 0.35, filter: 'blur(2px)' }}
            />
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
              className="nums absolute top-1 text-[10px] text-muted-foreground"
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
