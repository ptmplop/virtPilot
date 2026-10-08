import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Power,
  RefreshCw,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { MetricChart } from '@/components/ui/MetricChart';
import { Skeleton } from '@/components/ui/Skeleton';
import { VmLogo } from '@/components/ui/OsLogoPicker';
import { osSlugFromImage } from '@/data/templateSets';
import { useLogoStore } from '@/store/logoStore';
import {
  useSystemStats, useSystemInfo, useAptPackages, useInvalidateApt,
  useVirtPilotVersion, useCheckVersionNow,
  useSystemMetricsHistory,
  type AptPackage, type VirtPilotVersion,
  type SystemMetricsRange,
} from '@/hooks/useSystemStats';
import { useSettings } from '@/hooks/useSettings';
import { useVms } from '@/hooks/useVms';
import { useCountUp } from '@/hooks/useCountUp';
import type { VmStatus, VmSummary } from '@/types';
import { cn } from '@/lib/cn';
import { CHART } from '@/lib/chartColors';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { RingGauge, type GaugeTone } from '@/components/ui/RingGauge';
import { StatusGlyph, WarnGlyph } from '@/components/ui/Badge';
import { streamSse } from '@/lib/sseStream';

// ─── Formatters ────────────────────────────────────────────────────────────────

function fmtPct(n: number) { return `${Math.round(n)}%`; }

function fmtMb(mb: number): string {
  if (mb < 1024) return `${Math.round(mb)} MB`;
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

// ─── Legend item ───────────────────────────────────────────────────────────────

function LegendItem({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <svg width="16" height="8" aria-hidden>
        <line
          x1="0" y1="4" x2="16" y2="4"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={dashed ? '4 3' : undefined}
        />
      </svg>
      <span className="text-[12px] text-muted-foreground">{label}</span>
    </div>
  );
}

// ─── VM roster ───────────────────────────────────────────────────────────────
//
// The machines themselves, running first, so you can see which are up at a glance
// and jump straight in. The foot of the panel answers the question every KVM host
// gets asked: how much of the box have the running guests been given?

const STATUS_ORDER: VmStatus[] = ['running', 'paused', 'crashed', 'stopped', 'unknown'];

const STATUS_WORD: Record<VmStatus, string> = {
  running: 'Running', paused: 'Paused', crashed: 'Crashed', stopped: 'Stopped', unknown: 'Unknown',
};

// Tiny axis-less line for the roster rows — just enough to read the shape of a VM's
// recent CPU. A flat wash under the line, no gradient.
function Sparkline({
  data, color, width = 56, height = 18,
}: { data: number[]; color: string; width?: number; height?: number }) {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - 1 - (Math.min(v, max) / max) * (height - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = `M${pts.join(' L')}`;
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="overflow-visible">
      <path d={area} fill={color} fillOpacity={0.1} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function AllocationMeter({ label, used, total, format }: {
  label: string; used: number; total: number; format: (n: number) => string;
}) {
  const ratio = total > 0 ? used / total : 0;
  const over = ratio > 1;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3 text-[12px]">
        <span className="font-medium text-muted-foreground">{label}</span>
        <span className="truncate tabular-nums text-muted-foreground">
          <span className={cn('font-semibold', over ? 'text-amber-700 dark:text-amber-300' : 'text-foreground')}>{format(used)}</span>
          {' '}of {format(total)}
        </span>
      </div>
      {/* Thin strokes drawn as borders: they snap to whole pixels at any position. */}
      <div className="mt-2 flex h-[5px] overflow-hidden rounded-[2px] bg-gauge-track">
        <div
          className={cn('h-full transition-[width] duration-700', over ? 'bg-amber-500' : 'bg-[#4F7CAC] dark:bg-[#86AEDA]')}
          style={{ width: `${Math.min(ratio, 1) * 100}%` }}
        />
      </div>
    </div>
  );
}

function VmRoster({ vms, cores, memTotalMb }: { vms: VmSummary[]; cores?: number; memTotalMb?: number }) {
  const total = vms.length;
  const live = vms.filter((v) => v.status === 'running');
  const running = live.length;
  const vcpus = live.reduce((n, v) => n + v.cpus, 0);
  const memMb = live.reduce((n, v) => n + v.memoryMb, 0);

  const sorted = [...vms].sort((a, b) => {
    const d = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
  // A logo picked for the VM wins over the one its template implies (as on the VM list).
  const chosenLogos = useLogoStore((s) => s.vms);

  return (
    <Panel className="flex h-full flex-col">
      <PanelHeader
        title="Virtual machines"
        meta={<><span className="font-medium text-foreground tabular-nums">{running}</span> of {total} running</>}
        actions={
          <Link
            to="/vms"
            className="group/manage inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] font-medium text-primary transition-colors hover:bg-accent"
          >
            Manage
            <ArrowRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover/manage:translate-x-0.5" />
          </Link>
        }
      />

      {/* List */}
      <div className="max-h-[232px] flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
            <p className="text-[13px] text-muted-foreground">No virtual machines yet.</p>
            <Link to="/vms/new" className="text-[13px] font-medium text-primary hover:underline">Create the first one</Link>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {sorted.map((vm) => {
              const live = vm.status === 'running';
              return (
                <li key={vm.id}>
                  <Link
                    to={`/vms/${vm.id}`}
                    className="group/row grid grid-cols-[1.25rem_minmax(0,1fr)_5.5rem_3.5rem_7.25rem] items-center gap-x-3 px-5 py-[9px] transition-colors hover:bg-surface"
                  >
                    <span className="block h-5 w-5 shrink-0">
                      <VmLogo slug={chosenLogos[vm.name] ?? osSlugFromImage(vm.sourceTemplateFilename)} size={20} />
                    </span>

                    {/* Name + inline flags */}
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className={cn(
                        'min-w-0 truncate text-[13px] font-medium',
                        live ? 'text-foreground' : 'text-muted-foreground',
                      )}>
                        {vm.name}
                      </span>
                      {vm.autostart && (
                        <Power className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Autostart enabled" />
                      )}
                      {vm.guestAgent && (
                        <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Guest agent active" />
                      )}
                    </span>

                    <span className={cn(
                      'inline-flex items-center gap-1.5 text-[12px]',
                      live ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground',
                    )}>
                      <StatusGlyph status={vm.status} size={7} />
                      {STATUS_WORD[vm.status] ?? 'Unknown'}
                    </span>

                    {/* Recent-CPU sparkline (running VMs with samples) */}
                    <span className="flex h-[18px] items-center justify-end">
                      {live && vm.cpuSpark && vm.cpuSpark.length >= 2 && (
                        <Sparkline data={vm.cpuSpark} color={CHART.cpu} />
                      )}
                    </span>

                    {/* Allocation */}
                    <span className="text-right font-mono text-[11.5px] tabular-nums text-muted-foreground group-hover/row:text-foreground">
                      {vm.cpus} vCPU · {fmtMb(vm.memoryMb)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* What the running guests have been given, against the host */}
      {total > 0 && (
        <div className="mt-auto grid grid-cols-1 gap-x-8 gap-y-3 border-t border-border bg-surface/60 px-5 py-3.5 sm:grid-cols-2">
          <AllocationMeter
            label="vCPU to running VMs"
            used={vcpus}
            total={cores ?? 0}
            format={(n) => `${n}`}
          />
          <AllocationMeter
            label="Memory to running VMs"
            used={memMb}
            total={memTotalMb ?? 0}
            format={fmtMb}
          />
        </div>
      )}
    </Panel>
  );
}

// ─── Host overview ─────────────────────────────────────────────────────────────

// One label/value row of the host plate: a quiet label in a fixed column, then a
// single value style (mono, tabular, full strength), every row ruled.
function PlateRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.25rem_minmax(0,1fr)] items-center gap-x-3 py-[9px]">
      <dt className="text-[12.5px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-mono text-[12px] tabular-nums text-foreground">{children}</dd>
    </div>
  );
}

function LoadValue({ load, cores }: { load?: [number, number, number]; cores?: number }) {
  const color = (v: number) => {
    const r = v / Math.max(cores ?? 1, 1);
    if (r > 1.0) return 'text-red-700 dark:text-red-300';
    if (r > 0.7) return 'text-amber-700 dark:text-amber-300';
    return 'text-foreground';
  };
  if (!load) return <span className="text-muted-foreground">—</span>;
  const spans = ['1m', '5m', '15m'];
  return (
    <span className="flex items-baseline gap-4">
      {load.map((v, i) => (
        <span key={i} className="flex items-baseline gap-1">
          <span className={cn('font-semibold', color(v))}>{v.toFixed(2)}</span>
          <span className="font-sans text-[11px] text-muted-foreground">{spans[i]}</span>
        </span>
      ))}
    </span>
  );
}

function NetValue({ rx, tx }: { rx: number; tx: number }) {
  return (
    <span className="flex items-center gap-4">
      <span className="flex items-center gap-1">
        <ArrowDown className="h-3 w-3 shrink-0 text-[#4F7CAC] dark:text-[#86AEDA]" aria-label="Received" />
        {fmtBps(rx)}
      </span>
      <span className="flex items-center gap-1">
        <ArrowUp className="h-3 w-3 shrink-0 text-[#9A6B2E] dark:text-[#D2A86A]" aria-label="Sent" />
        {fmtBps(tx)}
      </span>
    </span>
  );
}

function HostOverview() {
  const { data: settings } = useSettings();
  const { data: info } = useSystemInfo();
  const { data: vms } = useVms();
  const { data: stats } = useSystemStats();
  const current = stats?.current;

  if (!settings) {
    return (
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1.4fr]">
        <Skeleton className="h-[332px] rounded-lg" />
        <Skeleton className="h-[332px] rounded-lg" />
      </div>
    );
  }

  const isKvm = settings.kvmAvailable;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1.4fr]">
      {/* Host plate */}
      <Panel className="animate-fade-up flex flex-col" style={{ animationDelay: '60ms' }}>
        <PanelHeader
          title="Host"
          actions={
            <span
              className={cn(
                'inline-flex items-center gap-1.5 text-[12.5px] font-medium',
                isKvm ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300',
              )}
              title={isKvm ? 'Hardware-accelerated virtualisation' : 'Software emulation — reduced performance'}
            >
              {isKvm ? <StatusGlyph status="running" size={7} /> : <WarnGlyph size={9} />}
              {isKvm ? 'KVM · hardware accelerated' : 'TCG · software emulation'}
            </span>
          }
        />
        <dl className="divide-y divide-border px-5 py-1">
          <PlateRow label="Hostname">{info?.hostname ?? '—'}</PlateRow>
          <PlateRow label="CPU">
            <span title={info?.cpuModel}>{info ? `${cleanCpuModel(info.cpuModel)} · ${info.cpuCores} cores` : '—'}</span>
          </PlateRow>
          <PlateRow label="QEMU">{info?.qemuVersion ?? '—'}</PlateRow>
          <PlateRow label="Kernel">{info?.kernelVersion ?? '—'}</PlateRow>
          <PlateRow label="Libvirt">{settings.libvirtUri}</PlateRow>
        </dl>
        <dl className="mt-auto divide-y divide-border border-t border-border bg-surface/60 px-5 py-1">
          <PlateRow label="Load"><LoadValue load={info?.load} cores={info?.cpuCores} /></PlateRow>
          <PlateRow label="Network"><NetValue rx={current?.netRxBps ?? 0} tx={current?.netTxBps ?? 0} /></PlateRow>
        </dl>
      </Panel>

      {/* VM roster */}
      <div className="animate-fade-up" style={{ animationDelay: '120ms' }}>
        <VmRoster vms={vms ?? []} cores={info?.cpuCores} memTotalMb={current?.memTotalMb} />
      </div>
    </div>
  );
}

// ─── Host metric card ──────────────────────────────────────────────────────────
//
// One panel per metric (CPU / Memory / Disk / Network): the title bar names it and
// carries its live reading; the chart below is the same MetricChart the per-VM
// Metrics tab uses — axis labels, ruled grid, auto-scaled "nice" max.

interface HostMetricCardProps {
  id: string;
  label: string;
  /** Raw current value; animated via count-up and rendered through formatValue. */
  primaryValue: number;
  formatValue: (n: number) => string;
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
  /** Floor for the auto-scaled max (byte rates: 1 KB/s, so an idle host's axis still reads). */
  minMax?: number;
  /** Plot-area height in px. */
  chartHeight?: number;
  loading?: boolean;
  delay?: number;
}

function HostMetricCard({
  id, label,
  primaryValue, formatValue, secondaryValue, legend,
  data, data2, color, color2,
  timestamps, formatY, formatX, max, minMax,
  chartHeight = 200,
  loading, delay = 0,
}: HostMetricCardProps) {
  return (
    <Panel className="animate-fade-up" style={{ animationDelay: `${delay}ms` }}>
      <PanelHeader
        title={label}
        meta={legend && !loading ? <span className="hidden sm:inline-flex">{legend}</span> : undefined}
        actions={
          loading ? (
            <Skeleton className="h-5 w-20 rounded" />
          ) : (
            <span className="flex items-baseline gap-1.5">
              <span className="whitespace-nowrap text-[18px] font-semibold tracking-[-0.015em] tabular-nums text-foreground">
                <AnimatedNumber value={primaryValue} format={formatValue} />
              </span>
              {secondaryValue && (
                <span className="whitespace-nowrap text-[12px] text-muted-foreground">{secondaryValue}</span>
              )}
            </span>
          )
        }
      />

      <div className="px-4 pb-3 pt-4">
        {loading || data.length < 2 ? (
          <div
            className="flex items-center justify-center text-[12.5px] text-muted-foreground"
            style={{ height: chartHeight + 18 }}
          >
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
            minMax={minMax}
            height={chartHeight}
          />
        )}
      </div>
    </Panel>
  );
}

// ─── Terminal shell ────────────────────────────────────────────────────────────
//
// Both long-running jobs (apt upgrade, VirtPilot self-upgrade) stream into the same
// window: always dark (a terminal is), titled by the command it runs, and closable
// only once the job has finished.

function TerminalShell({
  title, closable, onClose, children, footer,
}: {
  title: string;
  closable: boolean;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  useEffect(() => {
    if (!closable) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closable, onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#1B2433]/45 p-4 animate-fade-in dark:bg-black/70"
    >
      <div className="dark w-full max-w-2xl overflow-hidden rounded-[10px] border border-border bg-background text-foreground shadow-pop animate-slide-up">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
          <img src="/brand/virtpilot-symbol-small-dark.svg" alt="" className="h-4 w-4" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">{title}</span>
          {closable && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {children}
        <div className="flex items-center justify-between gap-3 border-t border-border bg-card px-4 py-3">
          {footer}
        </div>
      </div>
    </div>
  );
}

const TERM_LINE: Record<'out' | 'err' | 'meta', string> = {
  out: 'text-[#D5DAE1]',
  err: 'text-[#F0A39B]',
  meta: 'text-[#8B95A5]',
};

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
    const handle = streamSse(
      '/api/system/apt/upgrade',
      token,
      (msg) => {
        if (msg.type === 'done') {
          const code = parseInt(msg.text, 10);
          setExitCode(code);
          setDone(true);
          handle.close();
          if (code === 0) onDone();
        } else {
          setLines((prev) => [...prev, { type: msg.type === 'err' ? 'err' : 'out', text: msg.text }]);
        }
      },
      () => {
        setLines((prev) => [...prev, { type: 'err', text: '\nConnection lost.\n' }]);
        setDone(true);
      },
    );
    return () => handle.close();
  }, []);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines]);

  const success = done && exitCode === 0;

  return (
    <TerminalShell
      title="apt-get upgrade"
      closable={done}
      onClose={onClose}
      footer={
        <>
          <div className="flex items-center gap-2 text-[12.5px]">
            {done ? (
              success ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  <span className="text-emerald-300">Upgrade complete</span>
                </>
              ) : (
                <>
                  <X className="h-4 w-4 text-red-400" />
                  <span className="text-red-300">Upgrade failed (exit {exitCode})</span>
                </>
              )
            ) : (
              <>
                <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="text-muted-foreground">Running…</span>
              </>
            )}
          </div>
          <Button size="sm" variant="secondary" onClick={onClose} disabled={!done}>
            Close
          </Button>
        </>
      }
    >
      <div
        ref={outputRef}
        className="h-[340px] overflow-y-auto px-4 py-3 font-mono text-[12px] leading-relaxed"
      >
        {lines.map((l, i) => (
          <span key={i} className={cn('whitespace-pre-wrap', TERM_LINE[l.type])}>
            {l.text}
          </span>
        ))}
        {!done && (
          <span className="inline-block h-3.5 w-1.5 animate-pulse bg-[#86AEDA]/70 align-middle" />
        )}
      </div>
    </TerminalShell>
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
      <Panel className="overflow-hidden">
        <PanelHeader
          title="System updates"
          meta={
            isLoading ? 'Checking for updates…'
            : upToDate ? 'Up to date'
            : `${count} ${count === 1 ? 'package' : 'packages'} available`
          }
          actions={
            count > 0 ? (
              <Button size="sm" onClick={() => setUpgrading(true)}>
                <RefreshCw className="h-3.5 w-3.5" />
                Upgrade all
              </Button>
            ) : undefined
          }
        />

        {/* Package list */}
        {isLoading && (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 rounded-md" />)}
          </div>
        )}

        {upToDate && (
          <div className="flex items-center justify-center gap-2 py-9 text-[13px] text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            No updates available for this host
          </div>
        )}

        {!isLoading && count > 0 && (
          <>
            <div className="table-head grid grid-cols-[minmax(0,1fr)_auto] gap-4 px-5 py-2">
              <span>Package</span>
              <span>New version</span>
            </div>
            <div className="max-h-[320px] divide-y divide-border overflow-y-auto">
              {(packages as AptPackage[]).map((pkg) => (
                <div key={pkg.name} className="table-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-5 py-2.5">
                  <span className="min-w-0 truncate font-mono text-[12px] font-medium text-foreground">
                    {pkg.name}
                  </span>
                  <span className="flex shrink-0 items-baseline gap-2 font-mono text-[12px]">
                    <span className="font-semibold text-foreground">{pkg.version}</span>
                    <span className="text-[11px] text-muted-foreground">{pkg.arch}</span>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </Panel>

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
    const handle = streamSse(
      '/api/system/upgrade',
      token,
      (msg) => {
        if (msg.type === 'done') {
          const code = parseInt(msg.text, 10);
          setExitCode(code);
          setPhase(code === 0 ? 'restarting' : 'done-fail');
          handle.close();
        } else {
          setLines((prev) => [...prev, { type: msg.type === 'err' ? 'err' : msg.type === 'meta' ? 'meta' : 'out', text: msg.text }]);
        }
      },
      () => {
        // Connection dropped — likely because the backend just restarted.
        // Switch to "restarting" phase and let the version-poll loop confirm.
        setLines((prev) => [...prev, { type: 'meta', text: '\nBackend restarted. Waiting for new version…\n' }]);
        setPhase('restarting');
      },
    );
    return () => handle.close();
  }, []);

  // Once we believe the upgrade has finished, poll /api/system/version until
  // the reported `current` matches `targetVersion` (or we give up after 90s).
  useEffect(() => {
    if (phase !== 'restarting') return;
    let cancelled = false;
    // Generous: this only starts once the upgrade unit has genuinely
    // finished, and a slow host can still take a while to boot the new
    // backend. It used to start ~60s early because the stream declared
    // success on the poller's first tick, which is what made a healthy
    // upgrade look like a hang.
    const deadline = Date.now() + 180_000;

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
    <TerminalShell
      title={`virtpilot upgrade → ${targetVersion}`}
      closable={done}
      onClose={onClose}
      footer={
        <>
          <div className="flex items-center gap-2 text-[12.5px]">
            {phase === 'streaming' && (
              <>
                <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="text-muted-foreground">Building…</span>
              </>
            )}
            {phase === 'restarting' && (
              <>
                <RefreshCw className="h-4 w-4 animate-spin text-amber-400" />
                <span className="text-amber-300">Restarting service…</span>
              </>
            )}
            {phase === 'done-success' && (
              <>
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                <span className="text-emerald-300">Upgrade complete</span>
              </>
            )}
            {phase === 'done-fail' && (
              <>
                <X className="h-4 w-4 text-red-400" />
                <span className="text-red-300">
                  Upgrade failed{exitCode !== null ? ` (exit ${exitCode})` : ''}
                </span>
              </>
            )}
          </div>
          <Button size="sm" variant="secondary" onClick={onClose} disabled={!done && !success}>
            Close
          </Button>
        </>
      }
    >
      <div ref={outputRef} className="h-[340px] overflow-y-auto px-4 py-3 font-mono text-[12px] leading-relaxed">
        {lines.map((l, i) => (
          <span key={i} className={cn('whitespace-pre-wrap', TERM_LINE[l.type])}>
            {l.text}
          </span>
        ))}
        {!done && <span className="inline-block h-3.5 w-1.5 animate-pulse bg-[#86AEDA]/70 align-middle" />}
      </div>
    </TerminalShell>
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

  const quietAction =
    'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-50';

  const checkNowButton = (
    <button type="button" onClick={handleCheck} disabled={checkNow.isPending} className={quietAction}>
      <RefreshCw className={cn('h-3.5 w-3.5', checkNow.isPending && 'animate-spin')} />
      {checkNow.isPending ? 'Checking…' : 'Check now'}
    </button>
  );

  const releaseLink = (label: string) =>
    data?.releaseUrl ? (
      <a href={data.releaseUrl} target="_blank" rel="noopener noreferrer" className={quietAction}>
        {label}
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    ) : null;

  if (isLoading || !data) return null;

  const targetVersion = data.latest ?? '';
  const published = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' }) : null;

  // Every state is the same row — the mark, what is installed, what to do about it —
  // so the section keeps its weight whether or not there is anything to do.
  const row = (headline: React.ReactNode, detail: React.ReactNode, actions: React.ReactNode, extra?: React.ReactNode) => (
    <Panel className="px-5 py-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <img src="/brand/virtpilot-symbol.svg" alt="" className="h-10 w-10 shrink-0 dark:hidden" />
          <img src="/brand/virtpilot-symbol-dark.svg" alt="" className="hidden h-10 w-10 shrink-0 dark:block" />
          <div className="min-w-0">
            <p className="flex flex-wrap items-baseline gap-x-2 text-[15px] font-semibold tracking-[-0.01em] text-foreground">
              {headline}
            </p>
            <div className="mt-0.5 text-[13px] text-muted-foreground">{detail}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 sm:justify-end">{actions}</div>
      </div>
      {extra}
    </Panel>
  );

  // ── Up to date ───────────────────────────────────────────────────────────
  if (!data.updateAvailable) {
    const broken = !data.repoOk;
    return row(
      <>VirtPilot <span className="font-mono text-[13.5px] font-medium">v{data.current}</span></>,
      broken ? (
        <span className="text-amber-800 dark:text-amber-300">
          In-app upgrades unavailable — {data.repoReason ?? 'repository check failed.'}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <StatusGlyph status="running" size={7} />
          Up to date{published(data.publishedAt) ? ` — the latest release, published ${published(data.publishedAt)}` : ''}
        </span>
      ),
      <>
        {checkNowButton}
        {releaseLink(broken ? 'Latest release' : 'Release notes')}
      </>,
    );
  }

  // ── Update available, repo broken (manual upgrade required) ──────────────
  if (!data.repoOk) {
    return row(
      <>VirtPilot <span className="font-mono text-[13.5px] font-medium">v{data.current}</span></>,
      <span className="text-amber-800 dark:text-amber-300">
        v{targetVersion} is available, but in-app upgrade is unavailable — {data.repoReason ?? 'repository check failed.'}
      </span>,
      <>{checkNowButton}{releaseLink('Release notes')}</>,
      <div className="mt-4 rounded-md border border-border bg-surface px-3 py-2.5">
        <p className="text-[12px] text-muted-foreground">Upgrade from the host:</p>
        <pre className="mt-1 overflow-x-auto font-mono text-[12px] text-foreground">cd {data.repoPath} && sudo bash update.sh</pre>
      </div>,
    );
  }

  // ── Update available, repo OK ────────────────────────────────────────────
  return (
    <>
      {row(
        <>
          <span>Update available</span>
          <span className="flex items-baseline gap-1.5 font-mono text-[13.5px] font-medium">
            <span className="text-muted-foreground">v{data.current}</span>
            <ArrowRight className="h-3.5 w-3.5 self-center text-muted-foreground" aria-label="to" />
            <span className="text-primary">v{targetVersion}</span>
          </span>
        </>,
        published(data.publishedAt) ? `Released ${published(data.publishedAt)}` : 'A new release is ready to install',
        <>
          {checkNowButton}
          {releaseLink('Release notes')}
          <Button size="sm" onClick={() => setUpgrading(true)} className="ml-1">
            <RefreshCw className="h-3.5 w-3.5" />
            Update now
          </Button>
        </>,
      )}

      {upgrading && (
        <VirtPilotUpgradeModal
          targetVersion={targetVersion}
          onClose={() => setUpgrading(false)}
        />
      )}
    </>
  );
}

// ─── Health band ───────────────────────────────────────────────────────────────
//
// The instrument cluster at the top of the landing page: an overall verdict for the
// host, its three vitals and the VM count as ring gauges (the logo's own dial), and
// the installed VirtPilot version. "Is the host happy?" in one glance.

// Tweens a number towards its target with the shared count-up curve, then formats
// it — the readouts count up on mount and glide between polls instead of snapping.
function AnimatedNumber({ value, format }: { value: number; format: (n: number) => string }) {
  const v = useCountUp(value);
  return <>{format(v)}</>;
}

function Dial({
  label, value, reading, unit, sub, tone,
}: {
  label: string;
  /** 0–1 */
  value: number;
  reading: React.ReactNode;
  unit?: string;
  sub?: React.ReactNode;
  tone: GaugeTone;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center text-center">
      <RingGauge value={value} size={92} stroke={7} tone={tone} label={`${label}: ${Math.round(value * 100)}%`}>
        <span className="flex items-baseline text-[22px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-foreground">
          {reading}
          {unit && <span className="ml-px text-[13px] font-medium tracking-normal text-muted-foreground">{unit}</span>}
        </span>
      </RingGauge>
      <p className="mt-2.5 text-[12.5px] font-semibold text-foreground">{label}</p>
      {sub && <p className="mt-0.5 max-w-full truncate text-[12px] tabular-nums text-muted-foreground">{sub}</p>}
    </div>
  );
}

function gaugeTone(pct: number, warnAt: number): GaugeTone {
  if (pct >= 97) return 'danger';
  if (pct >= warnAt) return 'warn';
  return 'steel';
}

function HealthBand() {
  const { data: settings } = useSettings();
  const { data: info } = useSystemInfo();
  const { data: vms } = useVms();
  const { data: stats } = useSystemStats();
  const { data: version } = useVirtPilotVersion();
  const current = stats?.current;

  if (!settings || !current) {
    return <Skeleton className="h-[188px] rounded-lg" />;
  }

  const total   = vms?.length ?? 0;
  const running = vms?.filter((v) => v.status === 'running').length ?? 0;
  const diskPct = current.diskTotalGb > 0 ? (current.diskUsedGb / current.diskTotalGb) * 100 : 0;
  const memPct  = current.memTotalMb > 0 ? (current.memUsedMb / current.memTotalMb) * 100 : 0;
  const cpuPct  = current.cpuPercent;

  // Verdict — warnings turn the headline amber. Updates are informational, not a
  // warning, so they don't.
  const warnings: string[] = [];
  if (!settings.kvmAvailable) warnings.push('Software emulation (no KVM)');
  if (diskPct >= 85) warnings.push('Disk almost full');
  if (memPct >= 90) warnings.push('Memory pressure');
  if (cpuPct >= 90) warnings.push('CPU saturated');
  const healthy = warnings.length === 0;

  const updateAvailable = version?.updateAvailable && version.repoOk;

  return (
    <Panel className="animate-fade-up">
      <div className="grid grid-cols-1 gap-x-8 gap-y-6 px-6 py-6 xl:grid-cols-[minmax(0,15.5rem)_minmax(0,1fr)_auto] xl:items-center">
        {/* Verdict */}
        <div className="min-w-0">
          <p className="text-[12.5px] font-medium text-muted-foreground">Host status</p>
          <p className={cn(
            'mt-1.5 flex items-center gap-2 text-[21px] font-semibold leading-7 tracking-[-0.022em]',
            healthy ? 'text-foreground' : 'text-amber-800 dark:text-amber-200',
          )}>
            {healthy ? <StatusGlyph status="running" size={9} /> : <WarnGlyph size={11} />}
            {healthy ? 'All systems healthy' : `${warnings.length} warning${warnings.length > 1 ? 's' : ''}`}
          </p>
          {healthy ? (
            <div className="mt-2 space-y-0.5 text-[13px] leading-5">
              <p className="truncate font-mono text-[12.5px] text-foreground" title={info?.hostname}>{info?.hostname ?? 'host'}</p>
              <p className="text-muted-foreground">{running} of {total} VMs running</p>
            </div>
          ) : (
            <ul className="mt-2 space-y-0.5 text-[13px] leading-5 text-muted-foreground">
              {warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
        </div>

        {/* Dials */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4 xl:border-l xl:border-border xl:pl-8">
          <Dial
            label="CPU"
            value={cpuPct / 100}
            reading={<AnimatedNumber value={cpuPct} format={(n) => String(Math.round(n))} />}
            unit="%"
            sub={info ? `${info.cpuCores} cores` : undefined}
            tone={gaugeTone(cpuPct, 90)}
          />
          <Dial
            label="Memory"
            value={memPct / 100}
            reading={<AnimatedNumber value={memPct} format={(n) => String(Math.round(n))} />}
            unit="%"
            sub={`${fmtMb(current.memUsedMb)} of ${fmtMb(current.memTotalMb)}`}
            tone={gaugeTone(memPct, 90)}
          />
          <Dial
            label="Disk"
            value={diskPct / 100}
            reading={<AnimatedNumber value={diskPct} format={(n) => String(Math.round(n))} />}
            unit="%"
            sub={`${current.diskUsedGb.toFixed(0)} of ${current.diskTotalGb.toFixed(0)} GB`}
            tone={gaugeTone(diskPct, 85)}
          />
          <Dial
            label="VMs running"
            value={total > 0 ? running / total : 0}
            reading={<AnimatedNumber value={running} format={(n) => String(Math.round(n))} />}
            unit={`/${total}`}
            sub={total - running > 0 ? `${total - running} stopped` : total ? 'all up' : 'none defined'}
            tone="ok"
          />
        </div>

        {/* Installed version */}
        <a
          href="#virtpilot-section"
          onClick={(e) => {
            e.preventDefault();
            document.getElementById('virtpilot-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          className="group flex min-w-0 items-center gap-3 rounded-md xl:flex-col xl:items-start xl:gap-1 xl:border-l xl:border-border xl:pl-8"
        >
          <span className="text-[12.5px] font-medium text-muted-foreground">VirtPilot</span>
          <span className="font-mono text-[15px] font-semibold tabular-nums text-foreground group-hover:underline group-hover:decoration-border group-hover:underline-offset-4">
            v{version?.current ?? '—'}
          </span>
          <span className={cn(
            'inline-flex items-center gap-1.5 text-[12px]',
            updateAvailable ? 'font-medium text-primary' : 'text-muted-foreground',
          )}>
            {updateAvailable ? <>v{version?.latest} available <ArrowRight className="h-3 w-3" /></> : 'Up to date'}
          </span>
        </a>
      </div>
    </Panel>
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
    <Layout title="Dashboard" subtitle="Live host metrics and system status.">
      <div className="relative space-y-9">

        {/* ── Health summary ── */}
        <HealthBand />

        {/* ── Overview ── */}
        <section className="space-y-3.5">
          <SectionHeading label="Overview" />
          <HostOverview />
        </section>

        {/* ── VirtPilot ── */}
        <section id="virtpilot-section" className="animate-fade-up scroll-mt-6 space-y-3.5" style={{ animationDelay: '180ms' }}>
          <SectionHeading label="VirtPilot" />
          <VirtPilotUpdateCard />
        </section>

        {/* ── Host Metrics ── */}
        <section className="space-y-3.5">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setMetricsCollapsed((v) => !v)}
              aria-expanded={!metricsCollapsed}
              className="group flex min-w-0 flex-1 select-none items-center gap-1.5 rounded-md text-left"
            >
              <ChevronDown
                className={cn(
                  'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:text-foreground',
                  metricsCollapsed && '-rotate-90',
                )}
              />
              <div className="min-w-0 flex-1"><SectionHeading label="Host metrics" /></div>
            </button>
            {!metricsCollapsed && (
              <div className="segmented" role="group" aria-label="Time range">
                {(['live', '1h', '24h', '7d', '30d'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRange(r)}
                    aria-pressed={range === r}
                    className="flex items-center gap-1.5"
                  >
                    {r === 'live' && (
                      <StatusGlyph status={range === 'live' ? 'running' : 'stopped'} size={6} />
                    )}
                    {r === 'live' ? 'Live' : r}
                  </button>
                ))}
              </div>
            )}
          </div>

          {!metricsCollapsed && (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <HostMetricCard
              id="host-cpu"
              label="CPU"
              primaryValue={current?.cpuPercent ?? 0}
              formatValue={fmtPct}
              data={cpuData}
              timestamps={timestamps}
              color={CHART.cpu}
              formatY={(v) => `${Math.round(v)}%`}
              formatX={formatX}
              max={100}
              chartHeight={150}
              loading={isLoading}
              delay={240}
            />
            <HostMetricCard
              id="host-mem"
              label="Memory"
              primaryValue={current?.memUsedMb ?? 0}
              formatValue={fmtMb}
              secondaryValue={current ? `of ${fmtMb(current.memTotalMb)}` : undefined}
              data={memPctData}
              timestamps={timestamps}
              color={CHART.memory}
              formatY={(v) => `${Math.round(v)}%`}
              formatX={formatX}
              max={100}
              chartHeight={150}
              loading={isLoading}
              delay={290}
            />
            <HostMetricCard
              id="host-disk"
              label="Disk I/O"
              primaryValue={current ? current.diskReadBps + current.diskWriteBps : 0}
              formatValue={fmtBps}
              secondaryValue="total"
              legend={
                <span className="flex items-center gap-3">
                  <LegendItem color={CHART.inbound} label="Read" />
                  <LegendItem color={CHART.outbound} label="Write" dashed />
                </span>
              }
              data={diskRdData}
              data2={diskWrData}
              color={CHART.inbound}
              color2={CHART.outbound}
              timestamps={timestamps}
              formatY={fmtBps}
              minMax={1024}
              formatX={formatX}
              chartHeight={150}
              loading={isLoading}
              delay={340}
            />
            <HostMetricCard
              id="host-net"
              label="Network"
              primaryValue={current ? current.netRxBps + current.netTxBps : 0}
              formatValue={fmtBps}
              secondaryValue="total"
              legend={
                <span className="flex items-center gap-3">
                  <LegendItem color={CHART.inbound} label="RX" />
                  <LegendItem color={CHART.outbound} label="TX" dashed />
                </span>
              }
              data={netRxData}
              data2={netTxData}
              color={CHART.inbound}
              color2={CHART.outbound}
              timestamps={timestamps}
              formatY={fmtBps}
              minMax={1024}
              formatX={formatX}
              chartHeight={150}
              loading={isLoading}
              delay={390}
            />
          </div>
          )}
        </section>

        {/* ── System ── */}
        <section className="animate-fade-up space-y-3.5" style={{ animationDelay: '450ms' }}>
          <SectionHeading label="System" />
          <AptSection />
        </section>

      </div>
    </Layout>
  );
}
