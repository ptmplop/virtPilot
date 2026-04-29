import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Cpu,
  HardDrive,
  Info,
  MemoryStick,
  PackageOpen,
  RefreshCw,
  Server,
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
import { useSystemStats, useAptPackages, useInvalidateApt, type StatsSample, type AptPackage } from '@/hooks/useSystemStats';
import { releaseNotes, type ChangeType } from '@/data/releaseNotes';
import { useSettings } from '@/hooks/useSettings';
import { useVms } from '@/hooks/useVms';
import { cn } from '@/lib/cn';
import type { VmStatus } from '@/types';

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

// ─── Section label ─────────────────────────────────────────────────────────────

function SectionLabel({ label }: { label: string }) {
  return (
    <h2 className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/40 select-none">
      {label}
    </h2>
  );
}

// ─── Overview stat tiles ───────────────────────────────────────────────────────

type TileAccent = 'ok' | 'warn' | 'neutral';

interface StatTileProps {
  icon: typeof Server;
  label: string;
  primary: React.ReactNode;
  secondary: string;
  accent?: TileAccent;
  href?: string;
}

function StatTile({ icon: Icon, label, primary, secondary, accent = 'neutral', href }: StatTileProps) {
  const isWarn = accent === 'warn';
  const isOk   = accent === 'ok';

  const inner = (
    <div className={cn(
      'flex flex-col justify-between overflow-hidden rounded-2xl border px-5 py-4 shadow-sm transition-all duration-150',
      href && 'cursor-pointer hover:shadow-md hover:-translate-y-px',
      isWarn ? 'border-amber-500/25 bg-amber-500/5' : 'border-border bg-card',
    )}>
      {/* Top row: icon badge + label + status dot */}
      <div className="flex items-center gap-2.5">
        <div className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
          isWarn ? 'bg-amber-500/15' : isOk ? 'bg-emerald-500/10' : 'bg-muted',
        )}>
          <Icon className={cn(
            'h-3.5 w-3.5',
            isWarn ? 'text-amber-500' : isOk ? 'text-emerald-500' : 'text-muted-foreground',
          )} />
        </div>
        <span className={cn(
          'truncate text-[10px] font-semibold uppercase tracking-widest',
          isWarn ? 'text-amber-500 dark:text-amber-400' : 'text-muted-foreground',
        )}>
          {label}
        </span>
        {(isOk || isWarn) && (
          <span className={cn(
            'ml-auto h-1.5 w-1.5 shrink-0 rounded-full',
            isOk
              ? 'bg-emerald-500 shadow-[0_0_6px_1px_rgb(52_211_153_/_0.5)]'
              : 'bg-amber-500 shadow-[0_0_6px_1px_rgb(245_158_11_/_0.5)]',
          )} />
        )}
      </div>

      {/* Value block */}
      <div className="mt-3.5 min-w-0">
        <div className="truncate text-2xl font-bold leading-tight text-foreground">
          {primary}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{secondary}</div>
      </div>
    </div>
  );

  return href ? <Link to={href}>{inner}</Link> : inner;
}

function StatTiles() {
  const { data: settings } = useSettings();
  const { data: vms } = useVms();
  const { data: packages } = useAptPackages();
  const { data: stats } = useSystemStats();
  const current = stats?.current;

  if (!settings) {
    return (
      <div className="grid grid-cols-5 gap-4">
        {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[108px] rounded-2xl" />)}
      </div>
    );
  }

  const total   = vms?.length ?? 0;
  const running = vms?.filter((v) => v.status === 'running').length ?? 0;
  const stopped = vms?.filter((v) => v.status === 'stopped').length ?? 0;
  const updates = packages?.length ?? 0;

  const diskPct = current && current.diskTotalGb > 0
    ? Math.round((current.diskUsedGb / current.diskTotalGb) * 100)
    : 0;

  return (
    <div className="grid grid-cols-5 gap-4">
      {/* Virtualisation */}
      <StatTile
        icon={settings.kvmAvailable ? Zap : ZapOff}
        label="Virtualisation"
        primary={settings.kvmAvailable ? 'KVM' : 'TCG'}
        secondary={settings.kvmAvailable ? 'Hardware acceleration' : 'Software emulation — slower'}
        accent={settings.kvmAvailable ? 'ok' : 'warn'}
      />

      {/* libvirt */}
      <StatTile
        icon={Server}
        label="Hypervisor"
        primary="Connected"
        secondary={settings.libvirtUri}
        accent="ok"
      />

      {/* Virtual machines */}
      <StatTile
        icon={Cpu}
        label="Virtual Machines"
        primary={String(total)}
        secondary={`${running} running · ${stopped} stopped`}
        accent="neutral"
        href="/vms"
      />

      {/* Disk space */}
      <StatTile
        icon={HardDrive}
        label="Disk Space"
        primary={current ? `${current.diskUsedGb.toFixed(1)} GB` : '—'}
        secondary={current ? `${diskPct}% of ${current.diskTotalGb.toFixed(0)} GB` : 'Loading…'}
        accent={diskPct >= 75 ? 'warn' : 'ok'}
      />

      {/* System updates */}
      <StatTile
        icon={PackageOpen}
        label="System Updates"
        primary={updates > 0 ? `${updates} pending` : 'Up to date'}
        secondary={updates > 0 ? 'Packages ready to upgrade' : 'No updates available'}
        accent={updates > 0 ? 'warn' : 'ok'}
      />
    </div>
  );
}

// ─── Host configuration ────────────────────────────────────────────────────────

function HostConfigSection() {
  const { data: settings, isLoading } = useSettings();

  const rows: [string, string][] = settings ? [
    ['Storage Root', settings.storageRoot],
    ['Templates Directory', settings.templatesDir],
    ['ISOs Directory', settings.isosDir],
    ['VMs Directory', settings.vmsDir],
    ['Default Bridge', settings.defaultBridge],
    ['Libvirt URI', settings.libvirtUri],
  ] : [];

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="shrink-0 border-b border-border px-6 py-5">
        <p className="text-sm font-semibold text-foreground">Host Configuration</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Set via environment variables in the backend{' '}
          <span className="font-mono">.env</span> file.
        </p>
      </div>
      {isLoading ? (
        <div className="flex-1 space-y-px p-4">
          {[1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
        </div>
      ) : (
        <dl className="flex-1 divide-y divide-border overflow-y-auto">
          {rows.map(([label, value]) => (
            <div
              key={label}
              className="px-6 py-3.5 transition-colors hover:bg-muted/20"
            >
              <dt className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">{label}</dt>
              <dd className="truncate font-mono text-xs text-foreground" title={value}>{value}</dd>
            </div>
          ))}
        </dl>
      )}
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
  chartData: number[];
  chartData2?: number[];
  chartColor2?: string;
  loading?: boolean;
}

function MetricCard({
  id, icon: Icon, label, color, accentBg,
  primaryValue, secondaryValue, detail,
  chartData, chartData2, chartColor2, loading,
}: MetricCardProps) {
  return (
    <div className="flex h-[168px] overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition-shadow hover:shadow-md">
      {/* Left: label + value + detail — fixed width */}
      <div className="flex w-56 shrink-0 flex-col justify-center gap-3 px-6">
        <div className="flex items-center gap-2.5">
          <div className={cn('flex h-7 w-7 items-center justify-center rounded-lg', accentBg)}>
            <Icon className="h-3.5 w-3.5" style={{ color }} />
          </div>
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {label}
          </span>
        </div>

        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-24 rounded-lg" />
            <Skeleton className="h-3.5 w-32 rounded" />
          </div>
        ) : (
          <div>
            <div className="flex items-baseline gap-2 overflow-hidden">
              <span className="whitespace-nowrap text-3xl font-bold tracking-tight text-foreground tabular-nums">
                {primaryValue}
              </span>
              {secondaryValue && (
                <span className="shrink-0 text-sm text-muted-foreground">{secondaryValue}</span>
              )}
            </div>
            {detail && <div className="mt-1">{detail}</div>}
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="w-px shrink-0 bg-border/60 my-5" />

      {/* Right: chart — fills remaining width, always full height */}
      <div className="min-w-0 flex-1">
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
    const es = new EventSource('/api/system/apt/upgrade');

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
      <div className="w-full max-w-2xl rounded-2xl overflow-hidden border border-border shadow-2xl"
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
              className="flex h-6 w-6 items-center justify-center rounded text-white/30 hover:text-white/60 transition-colors"
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
                l.type === 'err' ? 'text-red-400/80' :
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
      <div className="flex flex-col rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between border-b border-border px-6 py-5">
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
          <div className="flex-1 space-y-px p-4">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 rounded-lg" />)}
          </div>
        )}

        {upToDate && (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            No updates available
          </div>
        )}

        {!isLoading && count > 0 && (
          <div className="flex-1 overflow-y-auto divide-y divide-border/60">
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

// ─── VM agent card ─────────────────────────────────────────────────────────────

const vmStatusDot: Record<VmStatus, string> = {
  running: 'bg-emerald-500',
  stopped: 'bg-slate-400',
  paused:  'bg-amber-500',
  crashed: 'bg-red-500',
  unknown: 'bg-muted-foreground/30',
};

function VmAgentCard() {
  const { data: vms, isLoading } = useVms();
  const list = vms ?? [];
  const running = list.filter((v) => v.status === 'running').length;

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="shrink-0 border-b border-border px-6 py-5">
        <p className="text-sm font-semibold text-foreground">Virtual Machines</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {isLoading ? 'Loading…' : `${list.length} total · ${running} running`}
        </p>
      </div>

      {isLoading && (
        <div className="flex-1 space-y-px p-4">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 rounded-lg" />)}
        </div>
      )}

      {!isLoading && list.length === 0 && (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          No virtual machines
        </div>
      )}

      {!isLoading && list.length > 0 && (
        <div className="flex-1 divide-y divide-border/60 overflow-y-auto">
          {list.map((vm) => (
            <Link
              key={vm.name}
              to={`/vms/${vm.name}`}
              className="flex items-center gap-2.5 px-5 py-3 transition-colors hover:bg-muted/20"
            >
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', vmStatusDot[vm.status])} />
              <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-foreground">
                {vm.name}
              </span>
              {vm.status === 'running' && vm.guestAgent !== undefined && (
                <span className={cn(
                  'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                  vm.guestAgent
                    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : 'bg-muted text-muted-foreground/60',
                )}>
                  {vm.guestAgent ? 'agent' : 'no agent'}
                </span>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── About section ─────────────────────────────────────────────────────────────

const changeTypeBadge: Record<ChangeType, string> = {
  added:   'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  changed: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  fixed:   'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  removed: 'bg-red-500/10 text-red-500',
};

const STACK_TAGS = ['Express', 'React 18', 'TypeScript', 'Vite', 'Tailwind', 'libvirt', 'KVM/QEMU'];

function AboutSection() {
  const current = releaseNotes[0];

  return (
    <div className="grid grid-cols-[1fr_2fr] gap-5">
      {/* Software identity */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="flex flex-col gap-5 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <Info className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">VirtPilot</p>
              <span className="font-mono text-[10px] text-muted-foreground">v{current.version}</span>
            </div>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Web-based KVM/QEMU manager — create, monitor, and control virtual machines from a browser. Wraps libvirt via virsh with a React frontend.
          </p>

          <div className="flex flex-wrap gap-1.5">
            {STACK_TAGS.map((tag) => (
              <span key={tag} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Release notes */}
      <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="shrink-0 border-b border-border px-6 py-5">
          <p className="text-sm font-semibold text-foreground">Release Notes</p>
          <p className="mt-1 text-xs text-muted-foreground">See <span className="font-mono">CHANGELOG.md</span> in the repository root for the full history.</p>
        </div>
        <div className="flex-1 divide-y divide-border/60 overflow-y-auto">
          {releaseNotes.map((entry) => (
            <div key={entry.version} className="px-6 py-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="font-mono text-xs font-semibold text-foreground">v{entry.version}</span>
                <span className="text-[10px] text-muted-foreground">{entry.date}</span>
              </div>
              <ul className="space-y-1.5">
                {entry.changes.map((change, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <span className={cn(
                      'mt-px shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wider',
                      changeTypeBadge[change.type],
                    )}>
                      {change.type}
                    </span>
                    {change.text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
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

  const cpuHistory      = extract(history, 'cpuPercent');
  const ramHistory      = extract(history, 'memUsedMb');
  const diskReadHistory = extract(history, 'diskReadBps');
  const diskWriteHistory= extract(history, 'diskWriteBps');
  const netRxHistory    = extract(history, 'netRxBps');
  const netTxHistory    = extract(history, 'netTxBps');

  const ramPct = current
    ? Math.round((current.memUsedMb / Math.max(current.memTotalMb, 1)) * 100)
    : 0;

  return (
    <Layout title="Dashboard" subtitle="Live server metrics and system status.">
      <div className="space-y-8">

        {/* ── Overview ── */}
        <section className="space-y-3">
          <SectionLabel label="Overview" />
          <StatTiles />
        </section>

        {/* ── Live metrics ── */}
        <section className="space-y-4">
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
            />

            <MetricCard
              id="ram"
              icon={MemoryStick}
              label="Memory"
              color="#8b5cf6"
              accentBg="bg-violet-500/10"
              primaryValue={current ? fmtMb(current.memUsedMb) : '—'}
              secondaryValue={current ? `/ ${fmtMb(current.memTotalMb)}` : undefined}
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
              chartData={diskReadHistory.length ? diskReadHistory : [0]}
              chartData2={diskWriteHistory.length ? diskWriteHistory : [0]}
              chartColor2="#f97316"
              loading={isLoading}
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
              chartData={netRxHistory.length ? netRxHistory : [0]}
              chartData2={netTxHistory.length ? netTxHistory : [0]}
              chartColor2="#06b6d4"
              loading={isLoading}
            />
          </div>

          {/* Chart legend */}
          {!isLoading && (
            <div className="flex items-center gap-6 px-1">
              <LegendItem color="#f59e0b" label="Disk read" />
              <LegendItem color="#f97316" label="Disk write" dashed />
              <LegendItem color="#10b981" label="Net RX" />
              <LegendItem color="#06b6d4" label="Net TX" dashed />
              <span className="ml-auto font-mono text-[10px] text-muted-foreground/50">
                2 s interval · {history.length} samples
              </span>
            </div>
          )}
        </section>

        {/* ── System ── */}
        <section className="space-y-3">
          <SectionLabel label="System" />
          <div className="grid grid-cols-[3fr_2fr_1.5fr] gap-5">
            <AptSection />
            <HostConfigSection />
            <VmAgentCard />
          </div>
        </section>

        {/* ── About ── */}
        <section className="space-y-3">
          <SectionLabel label="About" />
          <AboutSection />
        </section>

      </div>
    </Layout>
  );
}

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
