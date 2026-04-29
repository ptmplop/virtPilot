import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Cpu,
  HardDrive,
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
import { useSettings } from '@/hooks/useSettings';
import { releaseNotes } from '@/data/releaseNotes';
import { siGithub } from 'simple-icons';
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

// ─── Section label ─────────────────────────────────────────────────────────────

function SectionLabel({ label }: { label: string }) {
  return (
    <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/30 select-none border-l-2 border-primary/30 pl-2">
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
  delay?: number;
}

function StatTile({ icon: Icon, label, primary, secondary, accent = 'neutral', href, delay = 0 }: StatTileProps) {
  const isWarn = accent === 'warn';
  const isOk   = accent === 'ok';

  const inner = (
    <div
      className={cn(
        'group flex flex-col justify-between overflow-hidden rounded-xl border bg-gradient-to-b from-white/60 dark:from-white/[0.03] to-transparent px-5 py-4 shadow-airy animate-fade-up',
        'transition-all duration-200 ease-out',
        href && 'cursor-pointer hover:-translate-y-px',
        isWarn
          ? 'border-amber-500/25 bg-amber-500/5 hover:shadow-[0_0_24px_-4px_rgb(245_158_11_/_0.15)]'
          : isOk
          ? 'border-border bg-card hover:shadow-[0_0_24px_-4px_rgb(52_211_153_/_0.15)]'
          : 'border-border bg-card',
      )}
      style={{ animationDelay: `${delay}ms` }}
    >
      {/* Top row: icon badge + label + status dot */}
      <div className="flex items-center gap-2.5">
        <div className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg badge-radial-hover',
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
            'ml-auto h-1.5 w-1.5 shrink-0 rounded-full animate-glow-pulse',
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
        {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[108px] rounded-xl" />)}
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
        delay={0}
      />

      {/* libvirt */}
      <StatTile
        icon={Server}
        label="Hypervisor"
        primary="Connected"
        secondary={settings.libvirtUri}
        accent="ok"
        delay={60}
      />

      {/* Virtual machines */}
      <StatTile
        icon={Cpu}
        label="Virtual Machines"
        primary={String(total)}
        secondary={`${running} running · ${stopped} stopped`}
        accent="neutral"
        href="/vms"
        delay={120}
      />

      {/* Disk space */}
      <StatTile
        icon={HardDrive}
        label="Disk Space"
        primary={current ? `${current.diskUsedGb.toFixed(1)} GB` : '—'}
        secondary={current ? `${diskPct}% of ${current.diskTotalGb.toFixed(0)} GB` : 'Loading…'}
        accent={diskPct >= 75 ? 'warn' : 'ok'}
        delay={180}
      />

      {/* System updates */}
      <StatTile
        icon={PackageOpen}
        label="System Updates"
        primary={updates > 0 ? String(updates) : 'Up to date'}
        secondary={updates > 0 ? 'Packages ready to upgrade' : 'No updates available'}
        accent={updates > 0 ? 'warn' : 'ok'}
        delay={240}
      />
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
  delay?: number;
  chartBgClass?: string;
}

function MetricCard({
  id, icon: Icon, label, color, accentBg,
  primaryValue, secondaryValue, detail,
  chartData, chartData2, chartColor2, loading,
  delay = 0, chartBgClass,
}: MetricCardProps) {
  return (
    <div
      className="flex h-[220px] overflow-hidden rounded-xl border border-border bg-card shadow-airy animate-fade-up transition-all duration-200 ease-out hover:-translate-y-px hover:shadow-[0_4px_20px_rgb(0_0_0_/_0.1)]"
      style={{ animationDelay: `${delay}ms` }}
    >
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
              <span
                className="whitespace-nowrap text-3xl font-bold tracking-tight tabular-nums bg-gradient-to-b from-foreground to-foreground/60 bg-clip-text text-transparent"
              >
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
      <div className="w-px shrink-0 bg-gradient-to-b from-transparent via-border to-transparent my-5" />

      {/* Right: chart — fills remaining width, always full height */}
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
      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
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


// ─── About section ─────────────────────────────────────────────────────────────

const FEATURES = ['VM Lifecycle', 'Cloud-init', 'Console & VNC', 'Networking', 'Firewall', 'Live Metrics', 'Templates & ISOs'];
const STACK    = ['Express', 'React 18', 'TypeScript', 'Vite', 'Tailwind CSS', 'libvirt', 'KVM/QEMU'];

function AboutSection() {
  const { version } = releaseNotes[0];

  return (
    <div className="flex items-start justify-between gap-10">
      {/* Identity + detail */}
      <div className="flex min-w-0 flex-1 gap-5">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Cpu className="h-5 w-5 text-primary" />
        </div>

        <div className="min-w-0">
          <div className="mb-2 flex items-baseline gap-2.5">
            <span className="text-base font-bold bg-gradient-to-r from-foreground via-foreground/90 to-foreground/60 bg-clip-text text-transparent">VirtPilot</span>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">v{version}</span>
          </div>

          <p className="mb-5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Web-based KVM/QEMU virtual machine manager. Provision, monitor, and control VMs from
            a browser using <span className="font-mono text-foreground/70">libvirt</span>. Supports
            cloud-init provisioning, VNC and serial console access, bridged and NAT networking,
            iptables firewall rules, and live system metrics — no database required.
          </p>

          <div className="space-y-2.5">
            <div className="flex flex-wrap gap-1.5">
              {FEATURES.map((f) => (
                <span key={f} className="rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted-foreground">
                  {f}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {STACK.map((t) => (
                <span key={t} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {t}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* GitHub */}
      <a
        href="https://github.com/ptmplop/virtPilot"
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-xs font-medium text-foreground transition-all duration-200 ease-out hover:bg-muted hover:-translate-y-px hover:shadow-sm"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden>
          <path d={siGithub.path} />
        </svg>
        ptmplop/virtPilot
      </a>
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

        {/* ── About ── */}
        <section className="space-y-3">
          <SectionLabel label="About" />
          <AboutSection />
        </section>

        {/* ── CPU ── */}
        <section className="space-y-3">
          <SectionLabel label="CPU" />
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
            chartBgClass="bg-gradient-to-r from-blue-500/[0.04] dark:from-blue-500/[0.03] to-transparent"
          />
        </section>

        {/* ── Memory ── */}
        <section className="space-y-3">
          <SectionLabel label="Memory" />
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
            delay={60}
            chartBgClass="bg-gradient-to-r from-violet-500/[0.04] dark:from-violet-500/[0.03] to-transparent"
          />
        </section>

        {/* ── Disk I/O ── */}
        <section className="space-y-3">
          <SectionLabel label="Disk I/O" />
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
            delay={120}
            chartBgClass="bg-gradient-to-r from-amber-500/[0.04] dark:from-amber-500/[0.03] to-transparent"
          />
          {!isLoading && (
            <div className="flex items-center gap-6 px-1">
              <LegendItem color="#f59e0b" label="Read" />
              <LegendItem color="#f97316" label="Write" dashed />
            </div>
          )}
        </section>

        {/* ── Network ── */}
        <section className="space-y-3">
          <SectionLabel label="Network" />
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
            delay={180}
            chartBgClass="bg-gradient-to-r from-emerald-500/[0.04] dark:from-emerald-500/[0.03] to-transparent"
          />
          {!isLoading && (
            <div className="flex items-center gap-6 px-1">
              <LegendItem color="#10b981" label="RX" />
              <LegendItem color="#06b6d4" label="TX" dashed />
              <span className="ml-auto font-mono text-[10px] text-muted-foreground/50">
                2 s interval · {history.length} samples
              </span>
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
