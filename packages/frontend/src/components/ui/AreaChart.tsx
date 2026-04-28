import { useMemo } from 'react';

interface AreaChartProps {
  id: string;
  data: number[];
  color: string;
  data2?: number[];
  color2?: string;
}

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

export function AreaChart({ id, data, color, data2, color2 }: AreaChartProps) {
  const W = 300;
  const H = 72;
  const PAD = 5;

  const { line1, fill1, line2, fill2 } = useMemo(() => {
    const combined = [...data, ...(data2 ?? [])];
    const max = Math.max(...combined, 1);
    const toPoints = (arr: number[]) =>
      arr.map((v, i) => ({
        x: (i / Math.max(arr.length - 1, 1)) * W,
        y: H - PAD - (v / max) * (H - PAD * 2),
      }));

    const pts1 = toPoints(data);
    const pts2 = data2 ? toPoints(data2) : [];

    const l1 = buildPath(pts1);
    const f1 = l1 ? `${l1} L ${W},${H} L 0,${H} Z` : '';
    const l2 = buildPath(pts2);
    const f2 = l2 ? `${l2} L ${W},${H} L 0,${H} Z` : '';

    return { line1: l1, fill1: f1, line2: l2, fill2: f2 };
  }, [data, data2]);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ display: 'block', width: '100%', height: '100%' }}
      aria-hidden
    >
      <defs>
        <linearGradient id={`ag-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
        {color2 && (
          <linearGradient id={`ag2-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color2} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color2} stopOpacity="0.02" />
          </linearGradient>
        )}
      </defs>

      {fill1 && <path d={fill1} fill={`url(#ag-${id})`} />}
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
      {fill2 && color2 && <path d={fill2} fill={`url(#ag2-${id})`} />}
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
  );
}
