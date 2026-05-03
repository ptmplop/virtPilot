import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Boxes,
  CheckCircle2,
  ChevronDown,
  Cog,
  Cpu,
  ExternalLink,
  Globe,
  HardDrive,
  MemoryStick,
  Monitor,
  PackageOpen,
  RefreshCw,
  Sparkles,
  Terminal,
  X,
  Zap,
  ZapOff,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { MetricChart } from '@/components/ui/MetricChart';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  useSystemStats, useSystemInfo, useAptPackages, useInvalidateApt,
  useVirtPilotVersion, useCheckVersionNow,
  useSystemMetricsHistory,
  type AptPackage, type VirtPilotVersion,
  type SystemMetricsRange,
} from '@/hooks/useSystemStats';
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

// ─── Tile colour scheme ────────────────────────────────────────────────────────
//
// One source of truth for the visual language used by every tile on the
// dashboard (StatTile, MetricCard, Host identity card). Mirrors the layered
// look introduced by the VirtPilot update card: a subtle gradient wash, two
// blurred colour orbs, a coloured top stripe, a glowing icon badge with
// ring + gradient fill, and accent-coloured typography.

type TileAccent = 'neutral' | 'ok' | 'warn' | 'blue' | 'violet';

interface SchemeConfig {
  // Chart line colour (hex) — used by SVG components
  chartHex:       string;
  // Card chrome
  border:         string;
  hoverGlow:      string;
  // Layered background overlays
  gradientBg:     string;
  blurOrbA:       string;
  blurOrbB:       string;
  // Top accent stripe
  stripeBg:       string;
  // Glowing icon badge
  iconBadgeGlow:  string;
  iconBadgeBg:    string;
  iconBadgeRing:  string;
  iconColor:      string;
  // Typography
  labelColor:     string;
  valueColor:     string;
  // Status dot + progress bar
  dotColor:       string;
  barColor:       string;
  showDot:        boolean;
  // Chart background tint (right-hand panel of MetricCard)
  chartBgClass:   string;
}

const ACCENT_CFG: Record<TileAccent, SchemeConfig> = {
  neutral: {
    chartHex:      '#94a3b8',
    border:        'border-border',
    hoverGlow:     'hover:shadow-[0_4px_24px_-4px_rgb(0_0_0_/_0.12)]',
    gradientBg:    'bg-gradient-to-br from-foreground/[0.025] to-transparent',
    blurOrbA:      'bg-foreground/[0.04]',
    blurOrbB:      'bg-foreground/[0.025]',
    stripeBg:      'bg-gradient-to-r from-border via-border/50 to-transparent',
    iconBadgeGlow: 'bg-foreground/10',
    iconBadgeBg:   'bg-gradient-to-br from-muted via-muted/70 to-muted/40',
    iconBadgeRing: 'ring-border',
    iconColor:     'text-muted-foreground',
    labelColor:    'text-muted-foreground',
    valueColor:    'text-foreground',
    dotColor:      '',
    barColor:      'bg-border/60',
    showDot:       false,
    chartBgClass:  'bg-gradient-to-r from-foreground/[0.03] to-transparent',
  },
  ok: {
    chartHex:      '#10b981',
    border:        'border-emerald-500/25',
    hoverGlow:     'hover:shadow-[0_0_36px_-6px_rgb(52_211_153_/_0.30)]',
    gradientBg:    'bg-gradient-to-br from-emerald-500/[0.07] via-teal-500/[0.03] to-transparent',
    blurOrbA:      'bg-emerald-500/10',
    blurOrbB:      'bg-teal-500/[0.07]',
    stripeBg:      'bg-gradient-to-r from-emerald-500 via-teal-500/50 to-transparent',
    iconBadgeGlow: 'bg-emerald-500/30',
    iconBadgeBg:   'bg-gradient-to-br from-emerald-500/30 via-emerald-500/15 to-teal-500/20',
    iconBadgeRing: 'ring-emerald-400/30',
    iconColor:     'text-emerald-600 dark:text-emerald-300',
    labelColor:    'text-emerald-700 dark:text-emerald-300',
    valueColor:    'text-emerald-700 dark:text-emerald-200',
    dotColor:      'bg-emerald-500 shadow-[0_0_6px_1px_rgb(52_211_153_/_0.5)]',
    barColor:      'bg-emerald-500/60',
    showDot:       true,
    chartBgClass:  'bg-gradient-to-r from-emerald-500/[0.07] dark:from-emerald-500/[0.05] to-transparent',
  },
  warn: {
    chartHex:      '#f59e0b',
    border:        'border-amber-500/30',
    hoverGlow:     'hover:shadow-[0_0_36px_-6px_rgb(245_158_11_/_0.30)]',
    gradientBg:    'bg-gradient-to-br from-amber-500/[0.07] via-orange-500/[0.03] to-transparent',
    blurOrbA:      'bg-amber-500/12',
    blurOrbB:      'bg-orange-500/[0.07]',
    stripeBg:      'bg-gradient-to-r from-amber-500 via-orange-500/50 to-transparent',
    iconBadgeGlow: 'bg-amber-500/30',
    iconBadgeBg:   'bg-gradient-to-br from-amber-500/30 via-amber-500/15 to-orange-500/20',
    iconBadgeRing: 'ring-amber-400/30',
    iconColor:     'text-amber-600 dark:text-amber-300',
    labelColor:    'text-amber-700 dark:text-amber-300',
    valueColor:    'text-amber-700 dark:text-amber-200',
    dotColor:      'bg-amber-500 shadow-[0_0_6px_1px_rgb(245_158_11_/_0.5)]',
    barColor:      'bg-amber-500/60',
    showDot:       true,
    chartBgClass:  'bg-gradient-to-r from-amber-500/[0.07] dark:from-amber-500/[0.05] to-transparent',
  },
  blue: {
    chartHex:      '#3b82f6',
    border:        'border-blue-500/25',
    hoverGlow:     'hover:shadow-[0_0_36px_-6px_rgb(59_130_246_/_0.30)]',
    gradientBg:    'bg-gradient-to-br from-blue-500/[0.07] via-indigo-500/[0.03] to-transparent',
    blurOrbA:      'bg-blue-500/10',
    blurOrbB:      'bg-indigo-500/[0.07]',
    stripeBg:      'bg-gradient-to-r from-blue-500 via-indigo-500/50 to-transparent',
    iconBadgeGlow: 'bg-blue-500/30',
    iconBadgeBg:   'bg-gradient-to-br from-blue-500/30 via-blue-500/15 to-indigo-500/20',
    iconBadgeRing: 'ring-blue-400/30',
    iconColor:     'text-blue-600 dark:text-blue-300',
    labelColor:    'text-blue-700 dark:text-blue-300',
    valueColor:    'text-blue-700 dark:text-blue-200',
    dotColor:      'bg-blue-500 shadow-[0_0_6px_1px_rgb(59_130_246_/_0.5)]',
    barColor:      'bg-blue-500/60',
    showDot:       true,
    chartBgClass:  'bg-gradient-to-r from-blue-500/[0.07] dark:from-blue-500/[0.05] to-transparent',
  },
  violet: {
    chartHex:      '#8b5cf6',
    border:        'border-violet-500/25',
    hoverGlow:     'hover:shadow-[0_0_36px_-6px_rgb(139_92_246_/_0.30)]',
    gradientBg:    'bg-gradient-to-br from-violet-500/[0.07] via-purple-500/[0.03] to-transparent',
    blurOrbA:      'bg-violet-500/10',
    blurOrbB:      'bg-purple-500/[0.07]',
    stripeBg:      'bg-gradient-to-r from-violet-500 via-purple-500/50 to-transparent',
    iconBadgeGlow: 'bg-violet-500/30',
    iconBadgeBg:   'bg-gradient-to-br from-violet-500/30 via-violet-500/15 to-purple-500/20',
    iconBadgeRing: 'ring-violet-400/30',
    iconColor:     'text-violet-600 dark:text-violet-300',
    labelColor:    'text-violet-700 dark:text-violet-300',
    valueColor:    'text-violet-700 dark:text-violet-200',
    dotColor:      'bg-violet-500 shadow-[0_0_6px_1px_rgb(139_92_246_/_0.5)]',
    barColor:      'bg-violet-500/60',
    showDot:       true,
    chartBgClass:  'bg-gradient-to-r from-violet-500/[0.07] dark:from-violet-500/[0.05] to-transparent',
  },
};

// ─── Stat tile ─────────────────────────────────────────────────────────────────

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
  const interactive = !!href;

  const inner = (
    <div
      className={cn(
        'group relative flex h-full flex-col overflow-hidden rounded-2xl border bg-card shadow-airy animate-fade-up',
        'transition-all duration-300 ease-out',
        interactive && 'cursor-pointer hover:-translate-y-px',
        a.border, a.hoverGlow,
      )}
      style={{ animationDelay: `${delay}ms` }}
    >
      {/* Layered gradient background + blur orbs */}
      <div className={cn('pointer-events-none absolute inset-0', a.gradientBg)} />
      <div className={cn('pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full blur-3xl', a.blurOrbA)} />
      <div className={cn('pointer-events-none absolute -left-12 -bottom-16 h-36 w-36 rounded-full blur-3xl', a.blurOrbB)} />

      {/* Top accent stripe */}
      <div className={cn('pointer-events-none absolute inset-x-0 top-0 z-10 h-[2px]', a.stripeBg)} />

      <div className="relative flex flex-1 flex-col justify-between px-5 py-4">
        <div className="flex items-center gap-2.5">
          {/* Glowing icon badge */}
          <div className="relative shrink-0">
            <div className={cn('absolute inset-0 rounded-xl blur-md opacity-70', a.iconBadgeGlow)} />
            <div className={cn(
              'relative flex h-9 w-9 items-center justify-center rounded-xl ring-1',
              a.iconBadgeBg, a.iconBadgeRing,
            )}>
              <Icon className={cn('h-4 w-4', a.iconColor)} />
            </div>
          </div>

          <span className={cn('truncate text-[10px] font-bold uppercase tracking-[0.18em]', a.labelColor)}>
            {label}
          </span>

          {a.showDot && (
            <span className={cn('ml-auto h-1.5 w-1.5 shrink-0 rounded-full animate-glow-pulse', a.dotColor)} />
          )}
        </div>

        <div className="mt-3.5 min-w-0">
          <div className={cn('truncate text-2xl font-bold leading-tight tabular-nums', a.valueColor)}>
            {primary}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{secondary}</div>
          {extra && <div className="mt-2">{extra}</div>}
        </div>
      </div>

      {bar !== undefined && (
        <div className="relative h-1 w-full bg-border/40">
          <div
            className={cn('h-full transition-all duration-700', a.barColor)}
            style={{ width: `${Math.min(bar, 100)}%` }}
          />
        </div>
      )}
    </div>
  );

  return interactive ? <Link to={href!} className="block h-full">{inner}</Link> : inner;
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
        'group relative animate-fade-up overflow-hidden rounded-2xl border bg-card shadow-airy transition-all duration-300 ease-out',
        isKvm
          ? 'border-emerald-500/25 hover:shadow-[0_0_36px_-6px_rgb(52_211_153_/_0.30)]'
          : 'border-amber-500/30 hover:shadow-[0_0_36px_-6px_rgb(245_158_11_/_0.30)]',
      )}>
        {/* Layered gradient background + blur orbs */}
        <div className={cn(
          'pointer-events-none absolute inset-0 bg-gradient-to-br to-transparent',
          isKvm
            ? 'from-emerald-500/[0.07] via-teal-500/[0.03]'
            : 'from-amber-500/[0.07] via-orange-500/[0.03]',
        )} />
        <div className={cn(
          'pointer-events-none absolute -right-20 -top-20 h-52 w-52 rounded-full blur-3xl',
          isKvm ? 'bg-emerald-500/10' : 'bg-amber-500/12',
        )} />
        <div className={cn(
          'pointer-events-none absolute -left-16 -bottom-20 h-48 w-48 rounded-full blur-3xl',
          isKvm ? 'bg-teal-500/[0.07]' : 'bg-orange-500/[0.07]',
        )} />

        {/* Top accent stripe */}
        <div className={cn(
          'pointer-events-none absolute inset-x-0 top-0 z-10 h-[3px]',
          isKvm
            ? 'bg-gradient-to-r from-emerald-500 via-teal-500/50 to-transparent'
            : 'bg-gradient-to-r from-amber-500 via-orange-500/50 to-transparent',
        )} />

        <div className="relative flex flex-col gap-3 p-5">

          {/* KVM / TCG badge */}
          <div className="flex items-center gap-3">
            <div className="relative shrink-0">
              <div className={cn(
                'absolute inset-0 rounded-2xl blur-xl',
                isKvm ? 'bg-emerald-500/30' : 'bg-amber-500/30',
              )} />
              <div className={cn(
                'relative flex h-11 w-11 items-center justify-center rounded-2xl ring-1 shadow-[0_4px_20px_-2px_rgb(0_0_0_/_0.2)]',
                isKvm
                  ? 'bg-gradient-to-br from-emerald-500/30 via-emerald-500/15 to-teal-500/20 ring-emerald-400/30'
                  : 'bg-gradient-to-br from-amber-500/30 via-amber-500/15 to-orange-500/20 ring-amber-400/30',
              )}>
                <VirtIcon className={cn(
                  'h-5 w-5',
                  isKvm ? 'text-emerald-600 dark:text-emerald-300' : 'text-amber-600 dark:text-amber-300',
                )} />
              </div>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={cn(
                  'text-base font-bold tracking-wide',
                  isKvm ? 'text-emerald-700 dark:text-emerald-200' : 'text-amber-700 dark:text-amber-200',
                )}>
                  {isKvm ? 'KVM' : 'TCG'}
                </span>
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
            <IconRow icon={Boxes} value={info ? `QEMU ${info.qemuVersion}` : '—'} mono dim />
            <IconRow icon={Cog} value={info ? `Kernel ${info.kernelVersion}` : '—'} mono dim />
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

// ─── Host metric card ──────────────────────────────────────────────────────────
//
// One full-width row per metric (CPU / Memory / Disk / Network). Header bar
// keeps the dashboard's coloured chrome (top stripe, icon badge, accent label
// + big primary value); the chart below is a `MetricChart` matching the per-VM
// Metrics tab — Y/X axis labels, dashed grid lines, auto-scaled "nice" max.

interface HostMetricCardProps {
  id: string;
  icon: typeof Cpu;
  label: string;
  scheme: TileAccent;
  primaryValue: string;
  secondaryValue?: string;
  legend?: React.ReactNode;
  data: number[];
  data2?: number[];
  color: string;
  color2?: string;
  timestamps: number[];
  formatY: (v: number) => string;
  formatX: (ts: number) => string;
  /** Fixed Y-axis max (e.g. 100 for percentage charts). Auto-scales when omitted. */
  max?: number;
  loading?: boolean;
  delay?: number;
}

function HostMetricCard({
  id, icon: Icon, label, scheme,
  primaryValue, secondaryValue, legend,
  data, data2, color, color2,
  timestamps, formatY, formatX, max,
  loading, delay = 0,
}: HostMetricCardProps) {
  const a = ACCENT_CFG[scheme];

  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-2xl border bg-card shadow-airy animate-fade-up transition-all duration-300 ease-out hover:-translate-y-px',
        a.border, a.hoverGlow,
      )}
      style={{ animationDelay: `${delay}ms` }}
    >
      {/* Layered gradient background + blur orbs */}
      <div className={cn('pointer-events-none absolute inset-0', a.gradientBg)} />
      <div className={cn('pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full blur-3xl', a.blurOrbA)} />
      <div className={cn('pointer-events-none absolute -left-16 -bottom-20 h-56 w-56 rounded-full blur-3xl', a.blurOrbB)} />

      {/* Coloured top accent stripe */}
      <div className={cn('pointer-events-none absolute inset-x-0 top-0 z-10 h-[3px]', a.stripeBg)} />

      <div className="relative px-5 pb-3 pt-5">
        {/* Header row */}
        <div className="flex items-center gap-3">
          {/* Glowing icon badge */}
          <div className="relative shrink-0">
            <div className={cn('absolute inset-0 rounded-xl blur-md opacity-70', a.iconBadgeGlow)} />
            <div className={cn(
              'relative flex h-9 w-9 items-center justify-center rounded-xl ring-1',
              a.iconBadgeBg, a.iconBadgeRing,
            )}>
              <Icon className={cn('h-4 w-4', a.iconColor)} />
            </div>
          </div>
          <span className={cn('text-[10px] font-bold uppercase tracking-[0.2em]', a.labelColor)}>
            {label}
          </span>

          {legend && !loading && (
            <div className="ml-3 hidden sm:flex">
              {legend}
            </div>
          )}

          <div className="ml-auto text-right">
            {loading ? (
              <div className="space-y-1">
                <Skeleton className="ml-auto h-6 w-20 rounded" />
                <Skeleton className="ml-auto h-3 w-14 rounded" />
              </div>
            ) : (
              <>
                <span className={cn('block whitespace-nowrap text-2xl font-bold tracking-tight tabular-nums', a.valueColor)}>
                  {primaryValue}
                </span>
                {secondaryValue && (
                  <span className="block text-xs text-muted-foreground">{secondaryValue}</span>
                )}
              </>
            )}
          </div>
        </div>

        {/* Chart */}
        <div className="mt-4">
          {loading || data.length < 2 ? (
            <div className="flex h-[218px] items-center justify-center text-xs text-muted-foreground">
              {loading ? 'Loading…' : 'Waiting for samples…'}
            </div>
          ) : (
            <MetricChart
              id={id}
              data={data}
              data2={data2}
              color={color}
              color2={color2}
              timestamps={timestamps}
              formatY={formatY}
              formatX={formatX}
              max={max}
            />
          )}
        </div>
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

// ─── VirtPilot self-upgrade modal ──────────────────────────────────────────────

function VirtPilotUpgradeModal({
  targetVersion, onClose,
}: { targetVersion: string; onClose: () => void }) {
  const [lines, setLines] = useState<{ type: 'out' | 'err' | 'meta'; text: string }[]>([
    { type: 'meta', text: `Upgrading VirtPilot to ${targetVersion}…\n` },
  ]);
  const [phase, setPhase] = useState<'streaming' | 'restarting' | 'done-success' | 'done-fail'>('streaming');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const token = localStorage.getItem('virtpilotToken') ?? '';
    const es = new EventSource(`/api/system/upgrade?token=${encodeURIComponent(token)}`);

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data) as { type: string; text: string };
      if (msg.type === 'done') {
        const code = parseInt(msg.text, 10);
        setExitCode(code);
        setPhase(code === 0 ? 'restarting' : 'done-fail');
        es.close();
      } else {
        setLines((prev) => [...prev, { type: msg.type === 'err' ? 'err' : msg.type === 'meta' ? 'meta' : 'out', text: msg.text }]);
      }
    };

    es.onerror = () => {
      // Connection dropped — likely because the backend just restarted.
      // Switch to "restarting" phase and let the version-poll loop confirm.
      setLines((prev) => [...prev, { type: 'meta', text: '\nBackend restarted. Waiting for new version…\n' }]);
      setPhase('restarting');
      es.close();
    };

    return () => es.close();
  }, []);

  // Once we believe the upgrade has finished, poll /api/system/version until
  // the reported `current` matches `targetVersion` (or we give up after 90s).
  useEffect(() => {
    if (phase !== 'restarting') return;
    let cancelled = false;
    const deadline = Date.now() + 90_000;

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch('/api/system/version', {
          headers: { Authorization: `Bearer ${localStorage.getItem('virtpilotToken') ?? ''}` },
        });
        if (res.ok) {
          const data = (await res.json()) as VirtPilotVersion;
          if (data.current === targetVersion) {
            setPhase('done-success');
            setLines((prev) => [...prev, { type: 'meta', text: `\nNow running ${targetVersion}. Reloading…\n` }]);
            setTimeout(() => window.location.reload(), 1500);
            return;
          }
        }
      } catch { /* backend probably still restarting */ }
      if (Date.now() > deadline) {
        setPhase('done-fail');
        setLines((prev) => [...prev, { type: 'err', text: '\nTimed out waiting for backend to come back. Check `journalctl -u virtpilot` on the host.\n' }]);
        return;
      }
      setTimeout(tick, 2000);
    };

    void tick();
    return () => { cancelled = true; };
  }, [phase, targetVersion]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [lines]);

  const done = phase === 'done-success' || phase === 'done-fail';
  const success = phase === 'done-success' || (phase === 'restarting' && exitCode === 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-xl overflow-hidden border border-border shadow-2xl"
           style={{ background: 'hsl(224 30% 5%)' }}>
        <div className="flex items-center gap-3 border-b border-white/8 px-4 py-3">
          <div className="flex gap-1.5">
            <div className="h-3 w-3 rounded-full bg-red-500/70" />
            <div className="h-3 w-3 rounded-full bg-amber-500/70" />
            <div className="h-3 w-3 rounded-full bg-emerald-500/70" />
          </div>
          <span className="flex-1 text-center font-mono text-xs text-white/35">
            virtpilot upgrade → {targetVersion}
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

        <div ref={outputRef} className="h-[340px] overflow-y-auto p-4 font-mono text-xs leading-relaxed">
          {lines.map((l, i) => (
            <span key={i} className={cn(
              'whitespace-pre-wrap',
              l.type === 'meta' ? 'text-white/30' : l.type === 'err' ? 'text-red-300/80' : 'text-white/75',
            )}>
              {l.text}
            </span>
          ))}
          {!done && <span className="inline-block h-3.5 w-1.5 animate-pulse bg-white/50 align-middle" />}
        </div>

        <div className="flex items-center justify-between border-t border-white/8 px-4 py-3">
          <div className="flex items-center gap-2">
            {phase === 'streaming' && (
              <>
                <RefreshCw className="h-4 w-4 animate-spin text-white/40" />
                <span className="text-xs text-white/40">Building…</span>
              </>
            )}
            {phase === 'restarting' && (
              <>
                <RefreshCw className="h-4 w-4 animate-spin text-amber-400/80" />
                <span className="text-xs text-amber-400/80">Restarting service…</span>
              </>
            )}
            {phase === 'done-success' && (
              <>
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                <span className="text-xs text-emerald-400">Upgrade complete</span>
              </>
            )}
            {phase === 'done-fail' && (
              <>
                <X className="h-4 w-4 text-red-400" />
                <span className="text-xs text-red-400">
                  Upgrade failed{exitCode !== null ? ` (exit ${exitCode})` : ''}
                </span>
              </>
            )}
          </div>
          <Button size="sm" variant="secondary" onClick={onClose} disabled={!done && !success} className="text-xs">
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── VirtPilot update card (Overview section) ──────────────────────────────────

function VirtPilotUpdateCard() {
  const { data, isLoading } = useVirtPilotVersion();
  const [upgrading, setUpgrading] = useState(false);
  const checkNow = useCheckVersionNow();

  const handleCheck = () => {
    checkNow.mutate(undefined, {
      onSuccess: (latest) => {
        if (latest.updateAvailable) {
          toast.success(`Update v${latest.latest} available`);
        } else {
          toast.success(`Up to date — v${latest.current}`);
        }
      },
      onError: () => {
        toast.error('Failed to check for updates');
      },
    });
  };

  const checkNowButton = (hoverClass: string) => (
    <button
      type="button"
      onClick={handleCheck}
      disabled={checkNow.isPending}
      className={cn(
        'inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors duration-200 disabled:cursor-default disabled:opacity-50',
        hoverClass,
      )}
    >
      <RefreshCw className={cn('h-3 w-3', checkNow.isPending && 'animate-spin')} />
      {checkNow.isPending ? 'Checking…' : 'Check now'}
    </button>
  );

  if (isLoading || !data) return null;

  const targetVersion = data.latest ?? '';

  // ── Up to date ───────────────────────────────────────────────────────────
  // Mirrors the visual structure of the Update-available card so the section
  // has consistent weight regardless of state — same shell, same icon badge,
  // same big mono version display, just emerald instead of blue/violet.
  if (!data.updateAvailable) {
    const broken = !data.repoOk;
    return (
      <div className={cn(
        'group relative overflow-hidden rounded-2xl border shadow-airy transition-all duration-300 ease-out',
        broken
          ? 'border-amber-500/30 hover:shadow-[0_0_48px_-8px_rgb(245_158_11_/_0.30)]'
          : 'border-emerald-500/25 hover:shadow-[0_0_48px_-8px_rgb(52_211_153_/_0.30)]',
      )}>
        {/* Layered gradient background — kept subtle so text stays readable */}
        <div className={cn(
          'pointer-events-none absolute inset-0 bg-gradient-to-br to-transparent',
          broken ? 'from-amber-500/[0.06] via-amber-500/[0.03]' : 'from-emerald-500/[0.06] via-teal-500/[0.03]',
        )} />
        <div className={cn(
          'pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full blur-3xl',
          broken ? 'bg-amber-500/10' : 'bg-emerald-500/10',
        )} />
        <div className={cn(
          'pointer-events-none absolute -left-16 -bottom-20 h-56 w-56 rounded-full blur-3xl',
          broken ? 'bg-orange-500/[0.07]' : 'bg-teal-500/[0.07]',
        )} />

        {/* Static top stripe */}
        <div className={cn(
          'relative h-[3px] w-full bg-gradient-to-r to-transparent',
          broken ? 'from-amber-500 via-amber-500/40' : 'from-emerald-500 via-teal-500/50',
        )} />

        <div className="relative px-6 py-5">
          <div className="flex items-start gap-4">
            {/* Icon badge — matches the Update-available card's structure */}
            <div className="relative shrink-0">
              <div className={cn(
                'absolute inset-0 rounded-2xl blur-xl',
                broken ? 'bg-amber-500/30' : 'bg-emerald-500/30',
              )} />
              <div className={cn(
                'relative flex h-12 w-12 items-center justify-center rounded-2xl ring-1 shadow-[0_4px_20px_-2px_rgb(0_0_0_/_0.2)]',
                broken
                  ? 'bg-gradient-to-br from-amber-500/30 via-amber-500/15 to-orange-500/20 ring-amber-400/30'
                  : 'bg-gradient-to-br from-emerald-500/30 via-emerald-500/15 to-teal-500/20 ring-emerald-400/30',
              )}>
                {broken
                  ? <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-300" />
                  : <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-300" />}
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={cn(
                  'text-[10px] font-bold uppercase tracking-[0.2em]',
                  broken ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300',
                )}>
                  {broken ? 'In-app upgrades unavailable' : 'Up to date'}
                </span>
              </div>

              {/* Big version display — solid colours for max contrast */}
              <div className="mt-2 font-mono">
                <span className={cn(
                  'text-2xl font-bold tabular-nums',
                  broken ? 'text-amber-700 dark:text-amber-200' : 'text-emerald-700 dark:text-emerald-200',
                )}>
                  v{data.current}
                </span>
              </div>

              <p className="mt-1.5 text-xs text-muted-foreground">
                {broken
                  ? data.repoReason ?? 'Repository check failed.'
                  : `Running the latest release${data.publishedAt ? ` from ${new Date(data.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}` : ''}`}
              </p>

              <div className="mt-4 flex items-center gap-4">
                {checkNowButton(broken ? 'hover:text-amber-600 dark:hover:text-amber-300' : 'hover:text-emerald-600 dark:hover:text-emerald-300')}
                {data.releaseUrl && (
                  <a
                    href={data.releaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      'inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors duration-200',
                      broken ? 'hover:text-amber-600 dark:hover:text-amber-300' : 'hover:text-emerald-600 dark:hover:text-emerald-300',
                    )}
                  >
                    View latest release
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Update available, repo broken (manual upgrade required) ──────────────
  if (!data.repoOk) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.04] shadow-sm overflow-hidden">
        <div className="h-[3px] w-full bg-gradient-to-r from-amber-500/80 via-amber-500/30 to-transparent" />
        <div className="flex items-start gap-3 px-5 py-4">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/15">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">
              Update {targetVersion} available — but in-app upgrade is unavailable
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {data.repoReason ?? 'Repository check failed.'} Upgrade manually from the host:
            </p>
            <pre className="mt-2 rounded bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] text-foreground">
              cd {data.repoPath} && sudo bash update.sh
            </pre>
            <div className="mt-3">
              {checkNowButton('hover:text-amber-600 dark:hover:text-amber-300')}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Update available, repo OK ────────────────────────────────────────────
  return (
    <>
      <div className="group relative overflow-hidden rounded-2xl border border-blue-500/30 shadow-airy transition-all duration-300 ease-out hover:shadow-[0_0_48px_-8px_rgb(99_102_241_/_0.35)]">
        {/* Layered gradient background — kept subtle so text stays readable */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-blue-500/[0.06] via-violet-500/[0.03] to-transparent" />
        <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-blue-500/10 blur-3xl" />
        <div className="pointer-events-none absolute -left-16 -bottom-20 h-56 w-56 rounded-full bg-violet-500/[0.07] blur-3xl" />

        {/* Animated top stripe */}
        <div className="relative h-[3px] w-full overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-r from-blue-500 via-violet-500 to-blue-500 bg-[length:200%_100%] animate-[shimmer_3s_linear_infinite]" />
        </div>

        <div className="relative px-6 py-5">
          <div className="flex items-start gap-4">
            {/* Glowing icon badge */}
            <div className="relative shrink-0">
              <div className="absolute inset-0 rounded-2xl bg-blue-500/40 blur-xl animate-glow-pulse" />
              <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500/30 via-blue-500/15 to-violet-500/20 ring-1 ring-blue-400/30 shadow-[0_4px_20px_-2px_rgb(59_130_246_/_0.4)]">
                <Sparkles className="h-5 w-5 text-blue-600 dark:text-blue-300" />
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-700 dark:text-blue-300">
                  Update available
                </span>
                <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-glow-pulse shadow-[0_0_8px_2px_rgb(59_130_246_/_0.7)]" />
              </div>

              {/* Big version transition — solid colours for max contrast */}
              <div className="mt-2 flex items-center gap-3 font-mono">
                <span className="text-xl font-medium tabular-nums text-muted-foreground line-through decoration-muted-foreground/40 decoration-1">
                  v{data.current}
                </span>
                <ArrowRight className="h-4 w-4 text-blue-500 dark:text-blue-400 transition-transform duration-300 group-hover:translate-x-0.5" />
                <span className="text-2xl font-bold tabular-nums text-blue-700 dark:text-blue-200">
                  v{targetVersion}
                </span>
              </div>

              {data.publishedAt && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Released {new Date(data.publishedAt).toLocaleDateString(undefined, {
                    year: 'numeric', month: 'short', day: 'numeric',
                  })}
                </p>
              )}

              <div className="mt-4 flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => setUpgrading(true)}
                  className={cn(
                    'group/btn relative inline-flex items-center gap-1.5 overflow-hidden rounded-lg px-4 py-2 text-xs font-semibold text-white',
                    'bg-gradient-to-r from-blue-500 to-violet-500',
                    'shadow-[0_4px_16px_-2px_rgb(59_130_246_/_0.5)]',
                    'transition-all duration-200 ease-out',
                    'hover:shadow-[0_6px_24px_-2px_rgb(99_102_241_/_0.65)] hover:-translate-y-px',
                    'active:scale-95',
                  )}
                >
                  {/* Hover shimmer */}
                  <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent transition-transform duration-700 ease-out group-hover/btn:translate-x-full" />
                  <RefreshCw className="relative h-3.5 w-3.5" />
                  <span className="relative">Update now</span>
                </button>

                {checkNowButton('hover:text-blue-600 dark:hover:text-blue-300')}

                {data.releaseUrl && (
                  <a
                    href={data.releaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-blue-600 dark:hover:text-blue-300 transition-colors duration-200"
                  >
                    View release notes
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {upgrading && (
        <VirtPilotUpgradeModal
          targetVersion={targetVersion}
          onClose={() => setUpgrading(false)}
        />
      )}
    </>
  );
}

// ─── Dashboard page ────────────────────────────────────────────────────────────

type HostMetricsRange = 'live' | SystemMetricsRange;

interface HostMetricsPoint {
  ts: number;
  cpuPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  diskReadBps: number;
  diskWriteBps: number;
  netRxBps: number;
  netTxBps: number;
}

function formatChartTime(ts: number, range: HostMetricsRange): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  if (range === 'live') {
    const ss = d.getSeconds().toString().padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  if (range === '24h') {
    const dd = d.getDate().toString().padStart(2, '0');
    const mo = (d.getMonth() + 1).toString().padStart(2, '0');
    return `${dd}/${mo} ${hh}:${mm}`;
  }
  return `${hh}:${mm}`;
}

export function DashboardPage() {
  const { data, isLoading } = useSystemStats();
  const liveHistory = data?.history ?? [];
  const current = data?.current;

  const [range, setRange] = useState<HostMetricsRange>('live');
  const [metricsCollapsed, setMetricsCollapsed] = useState<boolean>(
    () => localStorage.getItem('virtpilotHostMetricsCollapsed') === '1',
  );
  useEffect(() => {
    localStorage.setItem('virtpilotHostMetricsCollapsed', metricsCollapsed ? '1' : '0');
  }, [metricsCollapsed]);
  const historyEnabled = range !== 'live';
  const { data: persisted } = useSystemMetricsHistory(
    range === 'live' ? '1h' : range,
    historyEnabled,
  );

  const points: HostMetricsPoint[] = range === 'live'
    ? liveHistory.map((s) => ({
        ts: s.timestamp,
        cpuPercent: s.cpuPercent,
        memUsedMb: s.memUsedMb,
        memTotalMb: s.memTotalMb,
        diskReadBps: s.diskReadBps,
        diskWriteBps: s.diskWriteBps,
        netRxBps: s.netRxBps,
        netTxBps: s.netTxBps,
      }))
    : (persisted?.history ?? []);

  const timestamps = points.map((p) => p.ts);
  const cpuData    = points.map((p) => p.cpuPercent);
  const memPctData = points.map((p) => (p.memTotalMb > 0 ? (p.memUsedMb / p.memTotalMb) * 100 : 0));
  const diskRdData = points.map((p) => p.diskReadBps);
  const diskWrData = points.map((p) => p.diskWriteBps);
  const netRxData  = points.map((p) => p.netRxBps);
  const netTxData  = points.map((p) => p.netTxBps);
  const formatX = (ts: number) => formatChartTime(ts, range);

  return (
    <Layout title="Dashboard" subtitle="Live server metrics and system status.">
      <div className="space-y-8">

        {/* ── Overview ── */}
        <section className="space-y-3">
          <SectionLabel label="Overview" />
          <HostOverview />
        </section>

        {/* ── VirtPilot ── */}
        <section className="space-y-3">
          <SectionLabel label="VirtPilot" />
          <VirtPilotUpdateCard />
        </section>

        {/* ── Host Metrics ── */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setMetricsCollapsed((v) => !v)}
              aria-expanded={!metricsCollapsed}
              className="group flex items-center gap-1.5 select-none"
            >
              <ChevronDown
                className={cn(
                  'h-3 w-3 text-muted-foreground/40 transition-transform duration-200 group-hover:text-muted-foreground/70',
                  metricsCollapsed && '-rotate-90',
                )}
              />
              <SectionLabel label="Host Metrics" />
            </button>
            {!metricsCollapsed && (
              <div className="inline-flex rounded-lg border border-border bg-card p-0.5 shadow-card">
                {(['live', '1h', '24h'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRange(r)}
                    className={cn(
                      'rounded-md px-3 py-1 text-[10px] font-semibold uppercase tracking-widest transition',
                      range === r
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {r === 'live' ? 'Live' : r}
                  </button>
                ))}
              </div>
            )}
          </div>

          {!metricsCollapsed && (
          <div className="flex flex-col gap-4">
            <HostMetricCard
              id="host-cpu"
              icon={Cpu}
              label="CPU Usage"
              scheme="blue"
              primaryValue={current ? fmtPct(current.cpuPercent) : '—'}
              data={cpuData}
              timestamps={timestamps}
              color={ACCENT_CFG.blue.chartHex}
              formatY={(v) => `${Math.round(v)}%`}
              formatX={formatX}
              max={100}
              loading={isLoading}
              delay={0}
            />
            <HostMetricCard
              id="host-mem"
              icon={MemoryStick}
              label="Memory"
              scheme="violet"
              primaryValue={current ? fmtMb(current.memUsedMb) : '—'}
              secondaryValue={current ? `of ${fmtMb(current.memTotalMb)}` : undefined}
              data={memPctData}
              timestamps={timestamps}
              color={ACCENT_CFG.violet.chartHex}
              formatY={(v) => `${Math.round(v)}%`}
              formatX={formatX}
              max={100}
              loading={isLoading}
              delay={60}
            />
            <HostMetricCard
              id="host-disk"
              icon={HardDrive}
              label="Disk I/O"
              scheme="warn"
              primaryValue={current ? fmtBps(current.diskReadBps + current.diskWriteBps) : '—'}
              secondaryValue="total"
              legend={
                <div className="flex items-center gap-3">
                  <LegendItem color="#f59e0b" label="Read" />
                  <LegendItem color="#f97316" label="Write" dashed />
                </div>
              }
              data={diskRdData}
              data2={diskWrData}
              color="#f59e0b"
              color2="#f97316"
              timestamps={timestamps}
              formatY={fmtBps}
              formatX={formatX}
              loading={isLoading}
              delay={120}
            />
            <HostMetricCard
              id="host-net"
              icon={Activity}
              label="Network"
              scheme="ok"
              primaryValue={current ? fmtBps(current.netRxBps + current.netTxBps) : '—'}
              secondaryValue="total"
              legend={
                <div className="flex items-center gap-3">
                  <LegendItem color="#10b981" label="RX" />
                  <LegendItem color="#06b6d4" label="TX" dashed />
                </div>
              }
              data={netRxData}
              data2={netTxData}
              color="#10b981"
              color2="#06b6d4"
              timestamps={timestamps}
              formatY={fmtBps}
              formatX={formatX}
              loading={isLoading}
              delay={180}
            />
          </div>
          )}
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
