import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Cpu,
  Globe,
  HardDrive,
  MemoryStick,
  Monitor,
  PackageOpen,
  RefreshCw,
  Terminal,
  X,
  Zap,
  ZapOff,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { AreaChart } from '@/components/ui/AreaChart';
import { Skeleton } from '@/components/ui/Skeleton';
import { useSystemStats, useSystemInfo, useAptPackages, useInvalidateApt, type StatsSample, type AptPackage } from '@/hooks/useSystemStats';
import { useSettings } from '@/hooks/useSettings';
import { useVms } from '@/hooks/useVms';
import { cn } from '@/lib/cn';

// ─── Formatters ────────────────────────────────────────────────────────────────

function fmtPct(n: number) { return `${Math.round(n)}%`; }

function fmtMb(mb: number): string {
  if (mb < 1024) return `${mb} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function fmtBps(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  if (bps < 1024 * 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
  return `${(bps / 1024 / 1024 / 1024).toFixed(2)} GB/s`;
}

function cleanCpuModel(raw: string): string {
  return raw
    .replace(/\(R\)/g, '').replace(/\(TM\)/g, '')
    .replace(/\s+CPU\b/i, '')
    .replace(/\s+@\s+[\d.]+\s*GHz/i, '')
    .replace(/\s+\d+-Core\s+Processor\b/i, '')
    .replace(/\s+/g, ' ').trim();
}

// ─── Section label ─────────────────────────────────────────────────────────────

function SectionLabel({ label }: { label: string }) {
  return (
    <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/30 select-none border-l-2 border-primary/30 pl-2">
      {label}
    </h2>
  );
}

// ─── Legend item ───────────────────────────────────────────────────────────────

function LegendItem({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <svg width="18" height="8" aria-hidden>
        <line
          x1="0" y1="4" x2="18" y2="4"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray={dashed ? '4 2' : undefined}
        />
      </svg>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}

// ─── Stat tile ─────────────────────────────────────────────────────────────────

type TileAccent = 'ok' | 'warn' | 'neutral' | 'blue' | 'violet';

const ACCENT_CFG: Record<TileAccent, {
  border:     string;
  cardBg:     string;
  hoverGlow:  string;
  iconBg:     string;
  iconColor:  string;
  labelColor: string;
  dotColor:   string;
  barColor:   string;
  showDot:    boolean;
}> = {
  neutral: {
    border: 'border-border', cardBg: 'bg-card', hoverGlow: '',
    iconBg: 'bg-muted', iconColor: 'text-muted-foreground',
    labelColor: 'text-muted-foreground', dotColor: '', barColor: 'bg-border/60', showDot: false,
  },
  ok: {
    border: 'border-border', cardBg: 'bg-card',
    hoverGlow: 'hover:shadow-[0_0_24px_-4px_rgb(52_211_153_/_0.15)]',
    iconBg: 'bg-emerald-500/10', iconColor: 'text-emerald-500',
    labelColor: 'text-muted-foreground',
    dotColor: 'bg-emerald-500 shadow-[0_0_6px_1px_rgb(52_211_153_/_0.5)]',
    barColor: 'bg-emerald-500/50', showDot: true,
  },
  warn: {
    border: 'border-amber-500/25', cardBg: 'bg-amber-500/5',
    hoverGlow: 'hover:shadow-[0_0_24px_-4px_rgb(245_158_11_/_0.15)]',
    iconBg: 'bg-amber-500/15', iconColor: 'text-amber-500',
    labelColor: 'text-amber-500 dark:text-amber-400',
    dotColor: 'bg-amber-500 shadow-[0_0_6px_1px_rgb(245_158_11_/_0.5)]',
    barColor: 'bg-amber-500/60', showDot: true,
  },
  blue: {
    border: 'border-blue-500/20', cardBg: 'bg-blue-500/[0.03]',
    hoverGlow: 'hover:shadow-[0_0_24px_-4px_rgb(59_130_246_/_0.15)]',
    iconBg: 'bg-blue-500/10', iconColor: 'text-blue-500',
    labelColor: 'text-muted-foreground',
    dotColor: 'bg-blue-500 shadow-[0_0_6px_1px_rgb(59_130_246_/_0.5)]',
    barColor: 'bg-blue-500/50', showDot: true,
  },
  violet: {
    border: 'border-violet-500/20', cardBg: 'bg-violet-500/[0.03]',
    hoverGlow: 'hover:shadow-[0_0_24px_-4px_rgb(139_92_246_/_0.15)]',
    iconBg: 'bg-violet-500/10', iconColor: 'text-violet-500',
    labelColor: 'text-muted-foreground',
    dotColor: 'bg-violet-500 shadow-[0_0_6px_1px_rgb(139_92_246_/_0.5)]',
    barColor: 'bg-violet-500/50', showDot: true,
  },
};

interface StatTileProps {
  icon: typeof Cpu;
  label: string;
  primary: React.ReactNode;
  secondary: string;
  accent?: TileAccent;
  bar?: number;
  extra?: React.ReactNode;
  href?: string;
  delay?: number;
}

function StatTile({ icon: Icon, label, primary, secondary, accent = 'neutral', bar, extra, href, delay = 0 }: StatTileProps) {
  const a = ACCENT_CFG[accent];

  const inner = (
    <div
      className={cn(
        'group flex h-full flex-col overflow-hidden rounded-xl border bg-gradient-to-b from-white/60 dark:from-white/[0.04] to-transparent shadow-airy animate-fade-up',
        'transition-all duration-200 ease-out',
        href && 'cursor-pointer hover:-translate-y-px',
        a.border, a.cardBg, a.hoverGlow,
      )}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex flex-1 flex-col justify-between px-5 py-4">
        <div className="flex items-center gap-2.5">
          <div className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg badge-radial-hover', a.iconBg)}>
            <Icon className={cn('h-3.5 w-3.5', a.iconColor)} />
          </div>
          <span className={cn('truncate text-[10px] font-semibold uppercase tracking-widest', a.labelColor)}>
            {label}
          </span>
          {a.showDot && (
            <span className={cn('ml-auto h-1.5 w-1.5 shrink-0 rounded-full animate-glow-pulse', a.dotColor)} />
          )}
        </div>

        <div className="mt-3.5 min-w-0">
          <div className="truncate text-2xl font-bold leading-tight text-foreground">
            {primary}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{secondary}</div>
          {extra && <div className="mt-2">{extra}</div>}
        </div>
      </div>

      {bar !== undefined && (
        <div className="h-1 w-full bg-border/40">
          <div
            className={cn('h-full transition-all duration-700', a.barColor)}
            style={{ width: `${Math.min(bar, 100)}%` }}
          />
        </div>
      )}
    </div>
  );

  return href ? <Link to={href} className="block h-full">{inner}</Link> : inner;
}

// ─── Host overview ─────────────────────────────────────────────────────────────

function ZoneSeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-px flex-1 bg-border/50" />
      <span className="text-[9px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/40">
        {label}
      </span>
    </div>
  );
}

function IconRow({ icon: Icon, value, mono, dim }: { icon: typeof Cpu; value: string; mono?: boolean; dim?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground/40" />
      <span className={cn(
        'truncate text-xs',
        dim ? 'text-muted-foreground' : 'text-foreground',
        mono && 'font-mono text-[11px]',
      )}>
        {value}
      </span>
    </div>
  );
}

function LoadRow({ load, cores }: { load?: [number, number, number]; cores?: number }) {
  const color = (v: number) => {
    const r = v / Math.max(cores ?? 1, 1);
    if (r > 1.0) return 'text-red-400';
    if (r > 0.7) return 'text-amber-400';
    return 'text-emerald-400';
  };
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Activity className="h-3 w-3 shrink-0 text-muted-foreground/40" />
      <span className="shrink-0 text-[10px] text-muted-foreground/50">load</span>
      {load ? (
        <div className="flex items-center gap-2">
          {load.map((v, i) => (
            <span key={i} className={cn('font-mono text-[11px] font-semibold tabular-nums', color(v))}>
              {v.toFixed(2)}
            </span>
          ))}
        </div>
      ) : (
        <span className="font-mono text-xs text-muted-foreground">—</span>
      )}
    </div>
  );
}

function NetRow({ rx, tx }: { rx: number; tx: number }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Globe className="h-3 w-3 shrink-0 text-muted-foreground/40" />
      <div className="flex items-center gap-2.5">
        <div className="flex items-center gap-1">
          <ArrowDown className="h-2.5 w-2.5 text-emerald-500/60" />
          <span className="font-mono text-[11px] tabular-nums text-foreground">{fmtBps(rx)}</span>
        </div>
        <div className="flex items-center gap-1">
          <ArrowUp className="h-2.5 w-2.5 text-cyan-500/60" />
          <span className="font-mono text-[11px] tabular-nums text-foreground">{fmtBps(tx)}</span>
        </div>
      </div>
    </div>
  );
}

function HostOverview() {
  const { data: settings } = useSettings();
  const { data: info } = useSystemInfo();
  const { data: vms } = useVms();
  const { data: packages } = useAptPackages();
  const { data: stats } = useSystemStats();
  const current = stats?.current;

  if (!settings) {
    return (
      <div className="grid grid-cols-[1fr_1.5fr] gap-4">
        <Skeleton className="h-[230px] rounded-xl" />
        <div className="grid grid-cols-2 gap-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[107px] rounded-xl" />)}
        </div>
      </div>
    );
  }

  const total   = vms?.length ?? 0;
  const running = vms?.filter((v) => v.status === 'running').length ?? 0;
  const stopped = vms?.filter((v) => v.status === 'stopped').length ?? 0;
  const updates = packages?.length ?? 0;

  const diskPct = current && current.diskTotalGb > 0
    ? Math.round((current.diskUsedGb / current.diskTotalGb) * 100) : 0;
  const ramPct = current
    ? Math.round((current.memUsedMb / Math.max(current.memTotalMb, 1)) * 100) : 0;

  const isKvm    = settings.kvmAvailable;
  const VirtIcon = isKvm ? Zap : ZapOff;

  return (
    <div className="grid grid-cols-[1fr_1.5fr] gap-4">
      {/* Host identity card */}
      <div className={cn(
        'animate-fade-up overflow-hidden rounded-xl border border-border bg-card shadow-airy transition-all duration-200 ease-out',
        isKvm
          ? 'hover:shadow-[0_4px_28px_-4px_rgb(52_211_153_/_0.14)]'
          : 'hover:shadow-[0_4px_28px_-4px_rgb(245_158_11_/_0.14)]',
      )}>
        <div className={cn(
          'h-[3px] w-full',
          isKvm
            ? 'bg-gradient-to-r from-emerald-500/80 via-emerald-500/30 to-transparent'
            : 'bg-gradient-to-r from-amber-500/80 via-amber-500/30 to-transparent',
        )} />
        <div className="flex flex-col gap-3 p-5">

          {/* KVM / TCG badge */}
          <div className="flex items-center gap-3">
            <div className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
              isKvm ? 'bg-emerald-500/10' : 'bg-amber-500/10',
            )}>
              <VirtIcon className={cn('h-4.5 w-4.5', isKvm ? 'text-emerald-500' : 'text-amber-500')} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-base font-bold text-foreground">{isKvm ? 'KVM' : 'TCG'}</span>
                <span className={cn(
                  'h-1.5 w-1.5 rounded-full animate-glow-pulse',
                  isKvm
                    ? 'bg-emerald-500 shadow-[0_0_6px_1px_rgb(52_211_153_/_0.5)]'
                    : 'bg-amber-500 shadow-[0_0_6px_1px_rgb(245_158_11_/_0.5)]',
                )} />
              </div>
              <p className="text-[11px] text-muted-foreground">
                {isKvm ? 'Hardware-accelerated virtualisation' : 'Software emulation — reduced performance'}
              </p>
            </div>
          </div>

          {/* Host zone */}
          <ZoneSeparator label="Host" />
          <div className="space-y-2">
            <IconRow icon={Monitor} value={info?.hostname ?? '—'} />
            <IconRow
              icon={Cpu}
              value={info ? `${cleanCpuModel(info.cpuModel)} · ${info.cpuCores} cores` : '—'}
            />
            <IconRow icon={Terminal} value={settings.libvirtUri} mono dim />
          </div>

          {/* Live zone */}
          <ZoneSeparator label="Live" />
          <div className="space-y-2">
            <LoadRow load={info?.load} cores={info?.cpuCores} />
            <NetRow rx={current?.netRxBps ?? 0} tx={current?.netTxBps ?? 0} />
          </div>

        </div>
      </div>

      {/* 2×2 stat tiles */}
      <div className="grid grid-cols-2 gap-4">
        <StatTile
          icon={Cpu}
          label="Virtual Machines"
          primary={String(total)}
          secondary={`${running} running · ${stopped} stopped`}
          accent="blue"
          href="/vms"
          delay={60}
          extra={total > 0 ? (
            <div className="flex flex-wrap gap-1 pt-1">
              {Array.from({ length: Math.min(running, 8) }).map((_, i) => (
                <span key={`r${i}`} className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_4px_1px_rgb(52_211_153_/_0.4)] animate-glow-pulse" />
              ))}
              {Array.from({ length: Math.min(stopped, 8 - Math.min(running, 8)) }).map((_, i) => (
                <span key={`s${i}`} className="h-1.5 w-1.5 rounded-full bg-muted-foreground/25" />
              ))}
              {total > 16 && <span className="text-[9px] text-muted-foreground/50">+{total - 16}</span>}
            </div>
          ) : undefined}
        />
        <StatTile
          icon={HardDrive}
          label="Disk Space"
          primary={current ? `${current.diskUsedGb.toFixed(1)} GB` : '—'}
          secondary={current ? `${diskPct}% of ${current.diskTotalGb.toFixed(0)} GB` : 'Loading…'}
          accent={diskPct >= 75 ? 'warn' : 'ok'}
          bar={diskPct}
          delay={120}
        />
        <StatTile
          icon={MemoryStick}
          label="Memory"
          primary={current ? fmtMb(current.memUsedMb) : '—'}
          secondary={current ? `${ramPct}% of ${fmtMb(current.memTotalMb)}` : 'Loading…'}
          accent={ramPct >= 90 ? 'warn' : 'ok'}
          bar={ramPct}
          delay={180}
        />
        <StatTile
          icon={PackageOpen}
          label="System Updates"
          primary={updates > 0 ? String(updates) : 'Up to date'}
          secondary={updates > 0 ? 'Packages ready to upgrade' : 'No updates available'}
          accent={updates > 0 ? 'warn' : 'ok'}
          delay={240}
        />
      </div>
    </div>
  );
}

// ─── Metric card ───────────────────────────────────────────────────────────────

interface MetricCardProps {
  id: string;
  icon: typeof Cpu;
  label: string;
  color: string;
  accentBg: string;
  primaryValue: string;
  secondaryValue?: string;
  detail?: React.ReactNode;
  legend?: React.ReactNode;
  chartData: number[];
  chartData2?: number[];
  chartColor2?: string;
  loading?: boolean;
  delay?: number;
  chartBgClass?: string;
  glowClass?: string;
}

function MetricCard({
  id, icon: Icon, label, color, accentBg,
  primaryValue, secondaryValue, detail, legend,
  chartData, chartData2, chartColor2, loading,
  delay = 0, chartBgClass, glowClass,
}: MetricCardProps) {
  return (
    <div
      className={cn(
        'relative flex h-[220px] overflow-hidden rounded-xl border border-border bg-card shadow-airy animate-fade-up transition-all duration-200 ease-out hover:-translate-y-px',
        glowClass,
      )}
      style={{ animationDelay: `${delay}ms` }}
    >
      {/* Coloured top accent stripe */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[3px]"
        style={{ background: `linear-gradient(90deg, ${color}99 0%, ${color}33 55%, transparent 100%)` }}
      />
      {/* Left panel */}
      <div className="flex w-56 shrink-0 flex-col px-5 py-5">
        <div className="flex items-center gap-2.5">
          <div className={cn('flex h-7 w-7 items-center justify-center rounded-lg', accentBg)}>
            <Icon className="h-3.5 w-3.5" style={{ color }} />
          </div>
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {label}
          </span>
        </div>

        <div className="mt-4 flex-1">
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-24 rounded-lg" />
              <Skeleton className="h-3.5 w-32 rounded" />
            </div>
          ) : (
            <>
              <div>
                <span className="block whitespace-nowrap text-3xl font-bold tracking-tight tabular-nums bg-gradient-to-b from-foreground to-foreground/60 bg-clip-text text-transparent">
                  {primaryValue}
                </span>
                {secondaryValue && (
                  <span className="block text-sm text-muted-foreground">{secondaryValue}</span>
                )}
              </div>
              {detail && <div className="mt-1.5">{detail}</div>}
            </>
          )}
        </div>

        {legend && !loading && (
          <div className="mt-auto border-t border-border/40 pt-3">
            {legend}
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="my-5 w-px shrink-0 bg-gradient-to-b from-transparent via-border to-transparent" />

      {/* Chart */}
      <div className={cn('min-w-0 flex-1', chartBgClass)}>
        {loading ? (
          <div className="h-full w-full bg-muted/20" />
        ) : (
          <AreaChart
            id={id}
            data={chartData}
            color={color}
            data2={chartData2}
            color2={chartColor2}
          />
        )}
      </div>
    </div>
  );
}

// ─── Two-value detail (for disk / net) ─────────────────────────────────────────

function BiValue({
  upLabel, upValue, downLabel, downValue, upColor, downColor,
}: {
  upLabel: string; upValue: string;
  downLabel: string; downValue: string;
  upColor: string; downColor: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <ArrowUp className="h-2.5 w-2.5 shrink-0" style={{ color: upColor }} />
        <span className="font-mono text-[10px] text-muted-foreground">{upLabel}</span>
        <span className="whitespace-nowrap font-mono text-[10px] font-semibold text-foreground tabular-nums">{upValue}</span>
      </div>
      <div className="flex items-center gap-1">
        <ArrowDown className="h-2.5 w-2.5 shrink-0" style={{ color: downColor }} />
        <span className="font-mono text-[10px] text-muted-foreground">{downLabel}</span>
        <span className="whitespace-nowrap font-mono text-[10px] font-semibold text-foreground tabular-nums">{downValue}</span>
      </div>
    </div>
  );
}

// ─── APT upgrade terminal ──────────────────────────────────────────────────────

function UpgradeModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [lines, setLines] = useState<{ type: 'out' | 'err' | 'meta'; text: string }[]>([
    { type: 'meta', text: 'Starting apt-get upgrade…\n' },
  ]);
  const [done, setDone] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const token = localStorage.getItem('virtpilotToken') ?? '';
    const es = new EventSource(`/api/system/apt/upgrade?token=${encodeURIComponent(token)}`);

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data) as { type: string; text: string };
      if (msg.type === 'done') {
        const code = parseInt(msg.text, 10);
        setExitCode(code);
        setDone(true);
        es.close();
        if (code === 0) onDone();
      } else {
        setLines((prev) => [...prev, { type: msg.type === 'err' ? 'err' : 'out', text: msg.text }]);
      }
    };

    es.onerror = () => {
      setLines((prev) => [...prev, { type: 'err', text: '\nConnection lost.\n' }]);
      setDone(true);
      es.close();
    };

    return () => es.close();
  }, []);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines]);

  const success = done && exitCode === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-xl overflow-hidden border border-border shadow-2xl"
           style={{ background: 'hsl(224 30% 5%)' }}>
        {/* Terminal title bar */}
        <div className="flex items-center gap-3 border-b border-white/8 px-4 py-3">
          <div className="flex gap-1.5">
            <div className="h-3 w-3 rounded-full bg-red-500/70" />
            <div className="h-3 w-3 rounded-full bg-amber-500/70" />
            <div className="h-3 w-3 rounded-full bg-emerald-500/70" />
          </div>
          <span className="flex-1 text-center font-mono text-xs text-white/35">
            apt-get upgrade
          </span>
          {done && (
            <button
              onClick={onClose}
              className="flex h-6 w-6 items-center justify-center rounded text-white/30 hover:text-white/60 transition-all duration-200 ease-out"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Output */}
        <div
          ref={outputRef}
          className="h-[340px] overflow-y-auto p-4 font-mono text-xs leading-relaxed"
        >
          {lines.map((l, i) => (
            <span
              key={i}
              className={cn(
                'whitespace-pre-wrap',
                l.type === 'meta' ? 'text-white/30' :
                'text-white/75'
              )}
            >
              {l.text}
            </span>
          ))}
          {!done && (
            <span className="inline-block h-3.5 w-1.5 animate-pulse bg-white/50 align-middle" />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-white/8 px-4 py-3">
          <div className="flex items-center gap-2">
            {done ? (
              success ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  <span className="text-xs text-emerald-400">Upgrade complete</span>
                </>
              ) : (
                <>
                  <X className="h-4 w-4 text-red-400" />
                  <span className="text-xs text-red-400">Upgrade failed (exit {exitCode})</span>
                </>
              )
            ) : (
              <>
                <RefreshCw className="h-4 w-4 animate-spin text-white/40" />
                <span className="text-xs text-white/40">Running…</span>
              </>
            )}
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={onClose}
            disabled={!done}
            className="text-xs"
          >
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── APT section ───────────────────────────────────────────────────────────────

function AptSection() {
  const { data: packages, isLoading } = useAptPackages();
  const invalidate = useInvalidateApt();
  const [upgrading, setUpgrading] = useState(false);

  const count = packages?.length ?? 0;
  const upToDate = !isLoading && count === 0;

  const handleUpgradeDone = () => {
    toast.success('System upgraded successfully');
    invalidate();
  };

  return (
    <>
      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        {/* Coloured top stripe */}
        <div className={cn(
          'h-[3px] w-full',
          upToDate
            ? 'bg-gradient-to-r from-emerald-500/70 via-emerald-500/25 to-transparent'
            : count > 0
            ? 'bg-gradient-to-r from-amber-500/70 via-amber-500/25 to-transparent'
            : 'bg-gradient-to-r from-border/40 to-transparent'
        )} />
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-5">
          <div className="flex items-center gap-3">
            <div className={cn(
              'flex h-7 w-7 items-center justify-center rounded-lg',
              upToDate ? 'bg-emerald-500/10' : count > 0 ? 'bg-amber-500/10' : 'bg-muted'
            )}>
              <PackageOpen className={cn(
                'h-3.5 w-3.5',
                upToDate ? 'text-emerald-500' : count > 0 ? 'text-amber-500' : 'text-muted-foreground'
              )} />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">System Updates</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {isLoading ? 'Checking for updates…' :
                 upToDate ? 'System is up to date' :
                 `${count} ${count === 1 ? 'package' : 'packages'} available`}
              </p>
            </div>
          </div>

          {count > 0 && (
            <Button
              size="sm"
              onClick={() => setUpgrading(true)}
              className="gap-1.5"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Upgrade all
            </Button>
          )}
        </div>

        {/* Package list */}
        {isLoading && (
          <div className="space-y-px p-4">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 rounded-lg" />)}
          </div>
        )}

        {upToDate && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            No updates available
          </div>
        )}

        {!isLoading && count > 0 && (
          <div className="max-h-[320px] overflow-y-auto divide-y divide-border/60">
            {(packages as AptPackage[]).map((pkg) => (
              <div key={pkg.name} className="flex items-center gap-3 px-6 py-3 hover:bg-muted/30 transition-colors">
                <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-foreground">
                  {pkg.name}
                </span>
                <div className="flex items-center gap-1.5 shrink-0 text-[11px] text-muted-foreground">
                  <span className="font-mono font-semibold text-foreground">{pkg.version}</span>
                  <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[9px] uppercase tracking-wider">
                    {pkg.arch}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {upgrading && (
        <UpgradeModal onClose={() => setUpgrading(false)} onDone={handleUpgradeDone} />
      )}
    </>
  );
}

// ─── Dashboard page ────────────────────────────────────────────────────────────

function extract(history: StatsSample[], key: keyof StatsSample): number[] {
  return history.map((s) => s[key] as number);
}

export function DashboardPage() {
  const { data, isLoading } = useSystemStats();
  const history = data?.history ?? [];
  const current = data?.current;

  const cpuHistory       = extract(history, 'cpuPercent');
  const ramHistory       = extract(history, 'memUsedMb');
  const diskReadHistory  = extract(history, 'diskReadBps');
  const diskWriteHistory = extract(history, 'diskWriteBps');
  const netRxHistory     = extract(history, 'netRxBps');
  const netTxHistory     = extract(history, 'netTxBps');

  const ramPct = current
    ? Math.round((current.memUsedMb / Math.max(current.memTotalMb, 1)) * 100)
    : 0;

  return (
    <Layout title="Dashboard" subtitle="Live server metrics and system status.">
      <div className="space-y-8">

        {/* ── Overview ── */}
        <section className="space-y-3">
          <SectionLabel label="Overview" />
          <HostOverview />
        </section>

        {/* ── Live Metrics ── */}
        <section className="space-y-3">
          <SectionLabel label="Live Metrics" />
          <div className="grid grid-cols-2 gap-4">
            <MetricCard
              id="cpu"
              icon={Cpu}
              label="CPU Usage"
              color="#3b82f6"
              accentBg="bg-blue-500/10"
              primaryValue={current ? fmtPct(current.cpuPercent) : '—'}
              detail={
                <div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-blue-500/70 transition-all duration-700"
                      style={{ width: `${current?.cpuPercent ?? 0}%` }}
                    />
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {current ? fmtPct(current.cpuPercent) : '—'} of capacity
                  </span>
                </div>
              }
              chartData={cpuHistory.length ? cpuHistory : [0]}
              loading={isLoading}
              delay={0}
              chartBgClass="bg-gradient-to-r from-blue-500/[0.06] dark:from-blue-500/[0.05] to-transparent"
              glowClass="hover:shadow-[0_6px_30px_-4px_rgb(59_130_246_/_0.14)]"
            />
            <MetricCard
              id="ram"
              icon={MemoryStick}
              label="Memory"
              color="#8b5cf6"
              accentBg="bg-violet-500/10"
              primaryValue={current ? fmtMb(current.memUsedMb) : '—'}
              secondaryValue={current ? `of ${fmtMb(current.memTotalMb)}` : undefined}
              detail={
                <div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-violet-500/70 transition-all duration-700"
                      style={{ width: `${ramPct}%` }}
                    />
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground">{ramPct}% used</span>
                </div>
              }
              chartData={ramHistory.length ? ramHistory : [0]}
              loading={isLoading}
              delay={60}
              chartBgClass="bg-gradient-to-r from-violet-500/[0.06] dark:from-violet-500/[0.05] to-transparent"
              glowClass="hover:shadow-[0_6px_30px_-4px_rgb(139_92_246_/_0.14)]"
            />
            <MetricCard
              id="disk"
              icon={HardDrive}
              label="Disk I/O"
              color="#f59e0b"
              accentBg="bg-amber-500/10"
              primaryValue={current ? fmtBps(current.diskReadBps + current.diskWriteBps) : '—'}
              secondaryValue="total"
              detail={
                current ? (
                  <BiValue
                    upLabel="R"
                    upValue={fmtBps(current.diskReadBps)}
                    downLabel="W"
                    downValue={fmtBps(current.diskWriteBps)}
                    upColor="#f59e0b"
                    downColor="#f97316"
                  />
                ) : null
              }
              legend={
                <div className="flex items-center gap-3">
                  <LegendItem color="#f59e0b" label="Read" />
                  <LegendItem color="#f97316" label="Write" dashed />
                </div>
              }
              chartData={diskReadHistory.length ? diskReadHistory : [0]}
              chartData2={diskWriteHistory.length ? diskWriteHistory : [0]}
              chartColor2="#f97316"
              loading={isLoading}
              delay={120}
              chartBgClass="bg-gradient-to-r from-amber-500/[0.06] dark:from-amber-500/[0.05] to-transparent"
              glowClass="hover:shadow-[0_6px_30px_-4px_rgb(245_158_11_/_0.14)]"
            />
            <MetricCard
              id="net"
              icon={Activity}
              label="Network"
              color="#10b981"
              accentBg="bg-emerald-500/10"
              primaryValue={current ? fmtBps(current.netRxBps + current.netTxBps) : '—'}
              secondaryValue="total"
              detail={
                current ? (
                  <BiValue
                    upLabel="↑"
                    upValue={fmtBps(current.netTxBps)}
                    downLabel="↓"
                    downValue={fmtBps(current.netRxBps)}
                    upColor="#06b6d4"
                    downColor="#10b981"
                  />
                ) : null
              }
              legend={
                <div className="space-y-1">
                  <div className="flex items-center gap-3">
                    <LegendItem color="#10b981" label="RX" />
                    <LegendItem color="#06b6d4" label="TX" dashed />
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground/50">
                    2 s · {history.length} samples
                  </span>
                </div>
              }
              chartData={netRxHistory.length ? netRxHistory : [0]}
              chartData2={netTxHistory.length ? netTxHistory : [0]}
              chartColor2="#06b6d4"
              loading={isLoading}
              delay={180}
              chartBgClass="bg-gradient-to-r from-emerald-500/[0.06] dark:from-emerald-500/[0.05] to-transparent"
              glowClass="hover:shadow-[0_6px_30px_-4px_rgb(16_185_129_/_0.14)]"
            />
          </div>
        </section>

        {/* ── System ── */}
        <section className="space-y-5">
          <SectionLabel label="System" />
          <AptSection />
        </section>

      </div>
    </Layout>
  );
}
