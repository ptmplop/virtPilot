// One way to write a quantity: at most one decimal, no trailing ".0", a space before
// the unit ("512 MB", "1 GB", "1.5 GB", "200 KB", "237 ms").
const fixed1 = (n: number) => String(Number(n.toFixed(1)));

export function formatMemory(mb: number): string {
  if (mb >= 1024) return `${fixed1(mb / 1024)} GB`;
  return `${Math.round(mb)} MB`;
}

export function formatDisk(gb: number): string {
  if (gb < 1) return `${Math.round(gb * 1024)} MB`;
  return `${fixed1(gb)} GB`;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i += 1; }
  return `${i === 0 ? Math.round(v) : fixed1(v)} ${UNITS[i]}`;
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(ms?: number): string {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${fixed1(ms / 1000)} s`;
}

// One date language for the whole app: unambiguous day-month order in every browser
// locale ("8 Oct 2026", "8 Oct 2026, 16:33"), never 10/8/2026.
export function formatDate(iso: string | number | Date): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso: string | number | Date): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// Chart time, by range. The axis says only what tells its ticks apart (time of day for
// short windows, the day for long ones); the hover readout always pins the moment.
const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const dayMonth = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export function formatChartTime(ts: number, range: string): string {
  const d = new Date(ts);
  if (range === 'live') return `${hm(d)}:${String(d.getSeconds()).padStart(2, '0')}`;
  if (range === '24h') return `${dayMonth(d)} ${hm(d)}`;
  if (range === '7d' || range === '30d') return dayMonth(d);
  return hm(d);
}

export function formatChartMoment(ts: number, range: string): string {
  const d = new Date(ts);
  if (range === 'live') return `${hm(d)}:${String(d.getSeconds()).padStart(2, '0')}`;
  if (range === '1h') return hm(d);
  return `${dayMonth(d)}, ${hm(d)}`;
}

// How long the host has been up, to the precision that matters at that age.
export function formatUptime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d} day${d === 1 ? '' : 's'}${h % 24 ? ` ${h % 24} h` : ''}`;
  if (h >= 1) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${Math.max(m, 1)} min`;
}

// A network's type in words, the same on every page: "NAT", "Bridge · DHCP",
// "OS bridge · static". A type is a plain word, never a status colour.
export function networkTypeLabel(type: string, ipMode?: string): string {
  if (type === 'nat') return 'NAT';
  const kind = type === 'existing-bridge' ? 'OS bridge' : 'Bridge';
  return `${kind} · ${ipMode === 'dhcp' ? 'DHCP' : 'static'}`;
}
