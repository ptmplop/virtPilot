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
import { formatChartMoment, formatChartTime, formatUptime, formatMemory, formatRate } from '@/lib/format';
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

const fmtMb = formatMemory;
const fmtBps = formatRate;

function fmtPct(n: number) { return `${Math.round(n)}%`; }

// "Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz" → "Intel Xeon Gold 6338"; QEMU's own model
// names carry a flag list ("Intel Xeon Processor (Skylake, IBRS, no TSX)"), which keeps
// only its generation. The full string stays in the row's title.
function cleanCpuModel(raw: string): string {
  return raw
    .replace(/\(R\)/g, '').replace(/\(TM\)/g, '')
    .replace(/\(([^,()]+),[^)]*\)/, '($1)')
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
// recent CPU. It sits in a quiet track (the allocation bars' own colour), so an idle
// VM's flat line reads as a chart at rest rather than an underline. No gradient.
function Sparkline({
  data, color, max, width = 56, height = 18,
}: { data: number[]; color: string; max: number; width?: number; height?: number }) {
  if (!data || data.length < 2) return null;
  const pad = 3;
  const floor = height - pad;
  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (width - pad * 2);
    const y = floor - (Math.min(v, max) / max) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = `M${pts.join(' L')}`;
  const area = `${line} L${width - pad},${floor} L${pad},${floor} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <rect width={width} height={height} rx={3} fill="hsl(var(--gauge-track))" fillOpacity={0.6} />
      <path d={area} fill={color} fillOpacity={0.12} />
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

// vCPUs are routinely over-committed on KVM (1.5× is ordinary), so a ratio above 1 is
// shown, not alarmed: the bar scales to what is allocated, a tick marks the host's
// capacity, and only an extreme ratio turns amber. Memory is different — committing
// more than the host has means swapping or the OOM killer — so it warns above 100%.
const VCPU_WARN_RATIO = 4;

// A ruled row, like the Host plate's Load and Network rows beside it — label, bar,
// value — so the two panels' feet share their rules.
function AllocationMeter({ label, used, total, value, warn }: {
  label: string; used: number; total: number; value: React.ReactNode; warn: boolean;
}) {
  const scale = Math.max(used, total, 1);
  const over = used > total && total > 0;
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 py-[9px] sm:grid-cols-[9.5rem_minmax(0,1fr)_auto]">
      <span className="truncate text-[12.5px] text-muted-foreground">{label}</span>
      <span className={cn('truncate text-right text-[12px] tabular-nums sm:order-last', warn ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>
        {value}
      </span>
      <div className="relative col-span-2 sm:col-span-1">
        <div className="flex h-[5px] overflow-hidden rounded-[2px] bg-gauge-track">
          <div
            className={cn('h-full transition-[width] duration-700', warn ? 'bg-amber-500' : 'bg-[#4F7CAC] dark:bg-[#86AEDA]')}
            style={{ width: `${(Math.min(used, scale) / scale) * 100}%` }}
          />
        </div>
        {over && (
          <span
            aria-hidden
            className="absolute -top-0.5 h-[9px] w-px bg-foreground/60"
            style={{ left: `${(total / scale) * 100}%` }}
            title="Host capacity"
          />
        )}
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
  // Every sparkline on one scale (at least 10%), so rows compare and an idle VM draws a
  // low, quiet line instead of being stretched to fill its box.
  const sparkMax = Math.max(10, ...live.flatMap((v) => v.cpuSpark ?? []));

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
                    className="group/row grid grid-cols-[1.25rem_minmax(0,1fr)_5.5rem] items-center gap-x-3 px-5 py-[9px] transition-colors hover:bg-surface sm:grid-cols-[1.25rem_minmax(0,1fr)_5.5rem_3.5rem_7.25rem]"
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
                    <span
                      className="hidden h-[18px] items-center justify-end sm:flex"
                      title={live && vm.cpuSpark && vm.cpuSpark.length >= 2
                        ? `CPU, last ${Math.max(1, Math.round((vm.cpuSpark.length * 30) / 60))} min · peak ${Math.round(Math.max(...vm.cpuSpark))}%`
                        : undefined}
                    >
                      {live && vm.cpuSpark && vm.cpuSpark.length >= 2 && (
                        <Sparkline data={vm.cpuSpark} color={CHART.cpu} max={sparkMax} />
                      )}
                    </span>

                    {/* Allocation */}
                    <span className="hidden text-right text-[12.5px] tabular-nums text-muted-foreground group-hover/row:text-foreground sm:block">
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
        <div className="mt-auto divide-y divide-border border-t border-border bg-surface/60 px-5 py-1">
          <AllocationMeter
            label="vCPU to running VMs"
            used={vcpus}
            total={cores ?? 0}
            warn={!!cores && vcpus / cores > VCPU_WARN_RATIO}
            value={
              <>
                <span className="font-semibold text-foreground">{vcpus}</span>{cores != null && <> on {cores} cores</>}
                {!!cores && vcpus > cores && <> · {Number((vcpus / cores).toFixed(1))}×</>}
              </>
            }
          />
          <AllocationMeter
            label="Memory to running VMs"
            used={memMb}
            total={memTotalMb ?? 0}
            warn={!!memTotalMb && memMb > memTotalMb}
            value={memTotalMb ? ofTotal(memMb, memTotalMb) : fmtMb(memMb)}
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

function LoadValue({ load, cores, missing = '…' }: { load?: [number, number, number]; cores?: number; missing?: string }) {
  // More runnable work than cores needs attention, not alarm: red is kept for failure.
  const color = (v: number) =>
    v / Math.max(cores ?? 1, 1) > 1 ? 'text-amber-700 dark:text-amber-300' : 'text-foreground';
  if (!load) return <span className="text-muted-foreground">{missing}</span>;
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
  const { data: info, isError: infoFailed } = useSystemInfo();
  // "…" only while the first answer is on its way; a failed one never resolves, so say so.
  const missing = infoFailed ? 'Unknown' : '…';
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
        {/* Acceleration is the status band's verdict; here it is one plain fact on the
            QEMU row, so the first screen says it once. */}
        <PanelHeader title="Host" />
        <dl className="divide-y divide-border px-5 py-1">
          <PlateRow label="Hostname">{info?.hostname ?? missing}</PlateRow>
          <PlateRow label="CPU">
            <span title={info?.cpuModel}>{info ? cleanCpuModel(info.cpuModel) : missing}</span>
          </PlateRow>
          <PlateRow label="QEMU">
            <span title={isKvm ? 'Hardware-accelerated virtualisation (KVM)' : 'Software emulation (TCG): reduced performance'}>
              {info?.qemuVersion ?? missing} · {isKvm ? 'KVM' : 'TCG'}
            </span>
          </PlateRow>
          <PlateRow label="Kernel">{info?.kernelVersion ?? missing}</PlateRow>
          <PlateRow label="Libvirt">{settings.libvirtUri}</PlateRow>
        </dl>
        <dl className="mt-auto divide-y divide-border border-t border-border bg-surface/60 px-5 py-1">
          <PlateRow label="Load"><LoadValue load={info?.load} cores={info?.cpuCores} missing={missing} /></PlateRow>
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
  /** Series names for the hover readout. */
  labels?: [string, string?];
  formatTime?: (ts: number) => string;
  /** Plot-area height in px. */
  chartHeight?: number;
  loading?: boolean;
  delay?: number;
}

function HostMetricCard({
  label,
  primaryValue, formatValue, secondaryValue, legend,
  data, data2, color, color2,
  timestamps, formatY, formatX, max, minMax, labels, formatTime,
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
            data={data}
            data2={data2}
            color={color}
            color2={color2}
            timestamps={timestamps}
            formatY={formatY}
            formatX={formatX}
            max={max}
            minMax={minMax}
            labels={labels}
            formatTime={formatTime}
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

  // One Updates panel: VirtPilot's own row first, then the host's packages as a row of
  // the same shape — a name, one line of state, its actions — with the list beneath.
  return (
    <>
      <Panel className="overflow-hidden">
        <VirtPilotUpdateCard />

        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-semibold leading-5 text-foreground">Host packages</p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {isLoading ? 'Checking for updates…'
                : upToDate ? 'Up to date'
                : `${count} ${count === 1 ? 'update' : 'updates'} available`}
            </p>
          </div>
          {count > 0 && (
            <Button size="sm" variant="secondary" onClick={() => setUpgrading(true)} className="self-start sm:self-auto">
              <RefreshCw className="h-3.5 w-3.5" />
              Upgrade all
            </Button>
          )}
        </div>

        {/* Package list */}
        {isLoading && (
          <div className="space-y-2 px-4 pb-4">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 rounded-md" />)}
          </div>
        )}

        {!isLoading && count > 0 && (
          <>
            <div className="table-head grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-t px-5 py-2">
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
          toast.success(`Up to date - v${latest.current}`);
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

  // Every state is the same row — what is installed, what to do about it — the first of
  // the Updates panel's rows, so the section keeps its weight whether or not there is
  // anything to do.
  const row = (headline: React.ReactNode, detail: React.ReactNode, actions: React.ReactNode, extra?: React.ReactNode) => (
    <div className="border-b border-border px-5 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2 text-[13.5px] font-semibold leading-5 text-foreground">
            {headline}
          </p>
          <div className="mt-0.5 text-[13px] text-muted-foreground">{detail}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1 sm:justify-end">{actions}</div>
      </div>
      {extra}
    </div>
  );

  // ── Up to date ───────────────────────────────────────────────────────────
  if (!data.updateAvailable) {
    const broken = !data.repoOk;
    return row(
      <>VirtPilot <span className="font-mono text-[12.5px] font-medium">v{data.current}</span></>,
      broken ? (
        <span className="text-amber-800 dark:text-amber-300">
          In-app upgrades unavailable. {data.repoReason ?? 'Repository check failed.'}
        </span>
      ) : (
        <span>
          Up to date{published(data.publishedAt) ? ` - the latest release, published ${published(data.publishedAt)}` : ''}
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
      <>VirtPilot <span className="font-mono text-[12.5px] font-medium">v{data.current}</span></>,
      <span className="text-amber-800 dark:text-amber-300">
        v{targetVersion} is available, but in-app upgrade is unavailable. {data.repoReason ?? 'Repository check failed.'}
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
          <span className="flex items-baseline gap-1.5 font-mono text-[12.5px] font-medium">
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
  // Shows the real reading at once (counting up from 0 on every visit briefly showed
  // numbers that weren't true) and glides only when a new sample changes it.
  const v = useCountUp(value, 700, value);
  return <>{format(v)}</>;
}

function Dial({
  label, value, reading, unit, sub, tone, ariaValue,
}: {
  label: string;
  /** 0–1 */
  value: number;
  reading: React.ReactNode;
  unit?: string;
  sub?: React.ReactNode;
  tone: GaugeTone;
  /** What a screen reader hears, when a percentage isn't the reading ("2 of 4"). */
  ariaValue?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center text-center">
      <RingGauge value={value} size={92} stroke={7} tone={tone} label={`${label}: ${ariaValue ?? `${Math.round(value * 100)}%`}`}>
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

// "Used of total" with the unit said once: "5.5 of 7.6 GB", "512 of 2048 MB".
function ofTotal(usedMb: number, totalMb: number): string {
  if (totalMb >= 1024) return `${Number((usedMb / 1024).toFixed(1))} of ${Number((totalMb / 1024).toFixed(1))} GB`;
  return `${Math.round(usedMb)} of ${Math.round(totalMb)} MB`;
}

interface Warning { title: string; detail: string }

function HealthBand({ stale, lastSampleAt }: { stale: boolean; lastSampleAt: number }) {
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
  // warning, so they don't. Each warning has a name and a line saying what it means.
  const warnings: Warning[] = [];
  if (!settings.kvmAvailable) warnings.push({ title: 'Software emulation', detail: 'No KVM: guests run without hardware acceleration' });
  if (diskPct >= 85) warnings.push({ title: 'Disk almost full', detail: `${Math.round(diskPct)}% of ${current.diskTotalGb.toFixed(0)} GB used` });
  if (memPct >= 90) warnings.push({ title: 'Memory pressure', detail: `${Math.round(memPct)}% of ${fmtMb(current.memTotalMb)} in use` });
  if (cpuPct >= 90) warnings.push({ title: 'CPU saturated', detail: `${Math.round(cpuPct)}%${info ? ` across ${info.cpuCores} cores` : ''}` });
  const healthy = warnings.length === 0;

  const updateAvailable = version?.updateAvailable && version.repoOk;

  const headline = stale ? 'Status unknown'
    : healthy ? 'Healthy'
    : warnings.length === 1 ? warnings[0].title
    : `${warnings.length} warnings`;

  // One sub line, always: what the headline needs to be read correctly.
  const subLine = stale ? (
    <>No data since {new Date(lastSampleAt).toLocaleTimeString('en-GB')}</>
  ) : healthy ? (
    <>
      <span className="font-mono text-[12px] text-foreground">{info?.hostname ?? 'host'}</span>
      {info?.uptimeSeconds != null && <> · up {formatUptime(info.uptimeSeconds)}</>}
    </>
  ) : warnings.length === 1 ? warnings[0].detail : warnings.map((w) => w.title).join(' · ');

  const tone = (t: GaugeTone): GaugeTone => (stale ? 'muted' : t);

  return (
    <Panel className="animate-fade-up">
      <div className="grid grid-cols-1 gap-x-8 gap-y-6 px-6 py-6 xl:grid-cols-[minmax(0,15.5rem)_minmax(0,1fr)_auto] xl:items-stretch">
        {/* Verdict — label, value, one sub line: the same three rows as the version block */}
        {/* Not a live region: its uptime changes every 30 s and would be re-announced
            forever. The stale-data note in the header is the one that announces. */}
        <div className="flex min-w-0 flex-col justify-center">
          <p className="text-[12.5px] font-medium leading-5 text-muted-foreground">Host status</p>
          <p className={cn(
            'mt-1.5 flex items-center gap-2 text-[21px] font-semibold leading-7 tracking-[-0.022em]',
            stale ? 'text-muted-foreground' : healthy ? 'text-foreground' : 'text-amber-800 dark:text-amber-200',
          )}>
            {/* A word stands alone; only a warning carries a mark. */}
            {!stale && !healthy && <WarnGlyph size={11} />}
            <span className="truncate">{headline}</span>
          </p>
          {/* Two lines at most: a warning's sentence wraps instead of being cut mid-word. */}
          <p
            className="mt-2 line-clamp-2 text-[12.5px] leading-5 text-muted-foreground"
            title={!healthy && warnings.length > 1 ? warnings.map((w) => `${w.title}: ${w.detail}`).join('\n') : undefined}
          >
            {subLine}
          </p>
        </div>

        {/* Dials */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4 xl:border-l xl:border-border xl:pl-8">
          <Dial
            label="CPU"
            value={cpuPct / 100}
            reading={<AnimatedNumber value={cpuPct} format={(n) => String(Math.round(n))} />}
            unit="%"
            sub={info ? `${info.cpuCores} cores` : undefined}
            tone={tone(gaugeTone(cpuPct, 90))}
          />
          <Dial
            label="Memory"
            value={memPct / 100}
            reading={<AnimatedNumber value={memPct} format={(n) => String(Math.round(n))} />}
            unit="%"
            sub={ofTotal(current.memUsedMb, current.memTotalMb)}
            tone={tone(gaugeTone(memPct, 90))}
          />
          <Dial
            label="Disk"
            value={diskPct / 100}
            reading={<AnimatedNumber value={diskPct} format={(n) => String(Math.round(n))} />}
            unit="%"
            sub={`${current.diskUsedGb.toFixed(0)} of ${current.diskTotalGb.toFixed(0)} GB`}
            tone={tone(gaugeTone(diskPct, 85))}
          />
          <Dial
            label="VMs running"
            value={total > 0 ? running / total : 0}
            reading={<AnimatedNumber value={running} format={(n) => String(Math.round(n))} />}
            unit={`/${total}`}
            sub={total - running > 0 ? `${total - running} stopped` : total ? 'all up' : 'none defined'}
            tone={tone('ok')}
            ariaValue={`${running} of ${total}`}
          />
        </div>

        {/* Installed version */}
        <a
          href="#virtpilot-section"
          onClick={(e) => {
            e.preventDefault();
            document.getElementById('virtpilot-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          className="group flex min-w-0 items-center gap-3 rounded-md xl:flex-col xl:items-start xl:justify-center xl:gap-0 xl:border-l xl:border-border xl:pl-8"
        >
          <span className="text-[12.5px] font-medium leading-5 text-muted-foreground">VirtPilot</span>
          <span className="font-mono text-[15px] font-semibold leading-7 tabular-nums text-foreground group-hover:underline group-hover:decoration-border group-hover:underline-offset-4 xl:mt-1.5">
            {version?.current ? `v${version.current}` : '…'}
          </span>
          <span className={cn(
            'inline-flex items-center gap-1.5 text-[12.5px] leading-5 xl:mt-2',
            updateAvailable ? 'font-medium text-primary' : 'text-muted-foreground',
          )}>
            {updateAvailable ? <>v{version?.latest} available <ArrowRight className="h-3 w-3" /></> : version ? 'Up to date' : 'Checking…'}
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


// Live means live: if the stats stop arriving (the backend restarting after an upgrade,
// a dropped connection) the page says so, instead of freezing the last numbers under a
// green "Live" and a healthy verdict. Samples come every 2 s; 10 s of silence is stale.
// Nothing shows while data is fresh — no ticking "updated 2 s ago".
function useStatsFreshness(dataUpdatedAt: number, isError: boolean): boolean {
  const [now, setNow] = useState(() => Date.now());
  const [visibleSince, setVisibleSince] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 2000);
    // A tab coming back from the background gets a moment to refetch before it can
    // be called stale, so returning to it never flashes the warning.
    const onVisible = () => {
      if (document.visibilityState === 'visible') { setVisibleSince(Date.now()); setNow(Date.now()); }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(tick); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  if (!dataUpdatedAt) return false;
  return (isError || now - dataUpdatedAt > 10_000) && now - visibleSince > 4_000;
}

export function DashboardPage() {
  const { data, isLoading, dataUpdatedAt, isError } = useSystemStats();
  const stale = useStatsFreshness(dataUpdatedAt, isError);
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
  const formatTime = (ts: number) => formatChartMoment(ts, range);

  return (
    <Layout
      title="Dashboard"
      subtitle="Live host metrics and system status."
      actions={stale ? (
        <span role="status" className="inline-flex items-center gap-2 text-[12.5px] text-amber-800 dark:text-amber-200">
          <WarnGlyph size={10} />
          No data since {new Date(dataUpdatedAt).toLocaleTimeString('en-GB')} · retrying
        </span>
      ) : undefined}
    >
      <div className="relative space-y-9">

        {/* ── Health summary ── */}
        <HealthBand stale={stale} lastSampleAt={dataUpdatedAt} />

        {/* ── The host and its VMs: the two panels name themselves ── */}
        <HostOverview />

        {/* ── Host Metrics ── */}
        <section className="space-y-3.5">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setMetricsCollapsed((v) => !v)}
              aria-expanded={!metricsCollapsed}
              // The chevron hangs in the margin, so this heading's tick lines up with the others.
              className="group -ml-5 flex min-w-0 flex-1 select-none items-center gap-1.5 rounded-md text-left"
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
                  >
                    {r === 'live' ? 'Live' : r}
                  </button>
                ))}
              </div>
            )}
          </div>

          {!metricsCollapsed && (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <HostMetricCard
              formatTime={formatTime}
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
              formatTime={formatTime}
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
              labels={['Read', 'Write']}
              formatTime={formatTime}
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
              labels={['RX', 'TX']}
              formatTime={formatTime}
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

        {/* ── Updates: VirtPilot itself, then the host's packages. The band's version
            links here. ── */}
        <section id="virtpilot-section" className="animate-fade-up scroll-mt-6 space-y-3.5" style={{ animationDelay: '450ms' }}>
          <SectionHeading label="Updates" />
          <AptSection />
        </section>

      </div>
    </Layout>
  );
}
