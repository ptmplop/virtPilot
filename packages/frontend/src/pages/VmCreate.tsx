import React, { useEffect, useRef, useState, type FormEvent, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, Check, ChevronDown, Copy, Cpu, Database, Disc, Eye, EyeOff, Globe,
  HardDrive, KeyRound, Network, Power, RefreshCw, Server, Shield, User,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';
import { useCreateVm } from '@/hooks/useVms';
import { api } from '@/lib/api';
import { useTemplates } from '@/hooks/useTemplates';
import { useIsos } from '@/hooks/useIsos';
import { useNetworks, useNetwork } from '@/hooks/useNetworks';
import { cn } from '@/lib/cn';
import { useLogoStore } from '@/store/logoStore';
import { VmLogo } from '@/components/ui/OsLogoPicker';

// ─── Types & constants ────────────────────────────────────────────────────────

type Step = 'resources' | 'network' | 'cloud-init' | 'review';
type SourceType = 'template' | 'iso';

const ALL_STEPS: Step[] = ['resources', 'network', 'cloud-init', 'review'];

const STEP_META: Record<Step, { label: string; desc: string; icon: typeof Cpu }> = {
  resources:    { label: 'Resources',      desc: 'Choose compute size and boot source.',                icon: Cpu     },
  network:      { label: 'Network',         desc: 'Select the network for this VM.',                    icon: Network },
  'cloud-init': { label: 'Authentication', desc: 'Configure login credentials and SSH access.',        icon: Shield  },
  review:       { label: 'Review',          desc: 'Confirm your configuration before creating the VM.', icon: Server  },
};

interface NetworkSelection {
  networkId: string;
  staticIp: string;
  isPrimary: boolean;
}

type CpuMode = 'host-passthrough' | 'host-model' | 'maximum';
type NicModel = 'virtio' | 'e1000e' | 'rtl8139';

interface FormData {
  name: string;
  cpus: string;
  memoryMb: string;
  diskGb: string;
  sourceType: SourceType;
  templateFilename: string;
  isoFilename: string;
  networks: NetworkSelection[];
  hostname: string;
  username: string;
  password: string;
  sshKeys: string;
  cpuMode: CpuMode;
  nicModel: NicModel;
}

const defaults: FormData = {
  name: '',
  cpus: '2',
  memoryMb: '2048',
  diskGb: '20',
  sourceType: 'template',
  templateFilename: '',
  isoFilename: '',
  networks: [],
  hostname: '',
  username: 'ubuntu',
  password: '',
  sshKeys: '',
  cpuMode: 'host-passthrough',
  nicModel: 'virtio',
};

const SIZE_PRESETS = [
  { id: 'basic',       label: 'Basic',       cpus: '1', memoryMb: '1024' },
  { id: 'standard',   label: 'Standard',    cpus: '2', memoryMb: '2048' },
  { id: 'performance',label: 'Performance', cpus: '4', memoryMb: '4096' },
  { id: 'high-ram',   label: 'High RAM',    cpus: '4', memoryMb: '8192' },
];

const DISK_PRESETS = ['10', '20', '40', '80', '100'];

const CPU_MODES: Array<{ id: CpuMode; label: string; desc: string }> = [
  { id: 'host-passthrough', label: 'Host CPU',    desc: 'Exposes host CPU directly. Best performance on a single hypervisor.' },
  { id: 'host-model',       label: 'Host Model',  desc: 'Copies host model. Safer if you plan to live-migrate VMs.' },
  { id: 'maximum',          label: 'Maximum',     desc: 'All features QEMU supports. Most compatible with unusual guests.' },
];

const NIC_MODELS: Array<{ id: NicModel; label: string; desc: string }> = [
  { id: 'virtio',  label: 'VirtIO',        desc: 'Best performance. Requires guest drivers (standard on Linux).' },
  { id: 'e1000e',  label: 'Intel e1000e',  desc: 'Good compatibility. Works out of the box on Windows and bare-metal images.' },
  { id: 'rtl8139', label: 'RTL8139',       desc: 'Legacy fallback. Use only if other models are unsupported by the guest.' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generatePassword(): string {
  const upper   = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower   = 'abcdefghjkmnpqrstuvwxyz';
  const digits  = '23456789';
  const symbols = '!@#$%&*';
  const all = upper + lower + digits + symbols;
  const buf = new Uint8Array(20);
  crypto.getRandomValues(buf);
  // Guarantee at least one of each class
  const chars: string[] = [
    upper[buf[0] % upper.length],
    lower[buf[1] % lower.length],
    digits[buf[2] % digits.length],
    symbols[buf[3] % symbols.length],
  ];
  for (let i = 4; i < 20; i++) chars.push(all[buf[i] % all.length]);
  // Fisher-Yates shuffle
  const order = new Uint8Array(chars.length);
  crypto.getRandomValues(order);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = order[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function mbToDisplay(mb: string): string {
  const n = parseInt(mb, 10);
  if (isNaN(n)) return '—';
  return n >= 1024 && n % 1024 === 0 ? `${n / 1024} GB` : `${n} MB`;
}

function matchPreset(cpus: string, memoryMb: string): string | null {
  return SIZE_PRESETS.find((p) => p.cpus === cpus && p.memoryMb === memoryMb)?.id ?? null;
}

// ─── Step indicator ───────────────────────────────────────────────────────────

function StepIndicator({ current, steps }: { current: Step; steps: Step[] }) {
  const currentIndex = steps.indexOf(current);
  return (
    <div className="mb-8 flex items-center">
      {steps.map((s, i) => {
        const done   = i < currentIndex;
        const active = s === current;
        return (
          <Fragment key={s}>
            <div className="flex shrink-0 items-center gap-2.5">
              <div
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition-all duration-300',
                  done   && 'bg-emerald-500/20 text-emerald-400',
                  active && 'bg-primary text-primary-foreground shadow-[0_0_14px_2px_hsl(214_100%_62%_/_0.35)]',
                  !done && !active && 'bg-muted text-muted-foreground/50'
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </div>
              <span
                className={cn(
                  'text-sm font-medium transition-colors',
                  active ? 'text-foreground' : done ? 'text-muted-foreground' : 'text-muted-foreground/40'
                )}
              >
                {STEP_META[s].label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={cn(
                  'mx-4 h-px flex-1 transition-colors duration-500',
                  done ? 'bg-emerald-500/30' : 'bg-border'
                )}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

// ─── Summary sidebar ──────────────────────────────────────────────────────────

function SummarySidebar({
  form,
  sourceName,
  networkSummary,
}: {
  form: FormData;
  sourceName?: string;
  networkSummary?: string;
}) {
  const sourceLabel = form.sourceType === 'iso' ? 'Install ISO' : 'Template';
  const sourceIcon  = form.sourceType === 'iso' ? Disc : HardDrive;
  const rows: [string, string, typeof Cpu][] = [
    ['Name',      form.name || '—',          Server],
    [sourceLabel, sourceName || '—',          sourceIcon],
    ['vCPU',      form.cpus,                  Cpu],
    ['RAM',       mbToDisplay(form.memoryMb), Database],
    ['Disk',      `${form.diskGb} GB`,        HardDrive],
    ['Networks',  networkSummary || '—',      Network],
    ...(form.sourceType === 'template'
      ? ([
          ['Hostname', form.hostname || form.name || '—', Globe],
          ['Username', form.username,                     User],
        ] as [string, string, typeof Cpu][])
      : []),
  ];

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
      <div className="border-b border-border bg-[hsl(var(--surface))] px-4 py-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/70">
          VM Summary
        </p>
      </div>
      <div className="divide-y divide-border/50">
        {rows.map(([label, value, Icon]) => (
          <div key={label} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Icon className="h-3 w-3 shrink-0 text-muted-foreground/40" />
              {label}
            </div>
            <span
              className={cn(
                'max-w-[140px] truncate text-right text-xs',
                value === '—' ? 'text-muted-foreground/30' : 'font-mono font-medium text-foreground'
              )}
            >
              {value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Section label ────────────────────────────────────────────────────────────

function FieldLabel({
  icon: Icon,
  children,
  hint,
}: {
  icon?: typeof Cpu;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground/50" />}
      <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/70">
        {children}
      </span>
      {hint && (
        <span className="text-[10px] normal-case font-normal text-muted-foreground/40">{hint}</span>
      )}
    </div>
  );
}

// ─── Source dropdown ──────────────────────────────────────────────────────────

function SourceDropdown({
  items,
  value,
  onChange,
  placeholder,
  slugs,
  fallbackIcon,
}: {
  items: Array<{ filename: string; name: string; sizeGb: number }>;
  value: string;
  onChange: (filename: string) => void;
  placeholder: string;
  slugs: Record<string, string>;
  fallbackIcon?: LucideIcon;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [openUpward, setOpenUpward] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const selected = items.find((i) => i.filename === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        triggerRef.current && !triggerRef.current.contains(e.target as Node) &&
        panelRef.current  && !panelRef.current.contains(e.target as Node)
      ) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = () => {
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setRect(r);
      // 260 = max-h-60 (240px) + 6px gap + 14px buffer
      setOpenUpward(r.bottom + 260 > window.innerHeight);
    }
    setOpen((v) => !v);
  };

  const select = (filename: string) => { onChange(filename); setOpen(false); };

  const panelStyle: React.CSSProperties = rect
    ? openUpward
      ? { position: 'fixed', bottom: window.innerHeight - rect.top + 6, left: rect.left, width: rect.width, zIndex: 9999 }
      : { position: 'fixed', top: rect.bottom + 6, left: rect.left, width: rect.width, zIndex: 9999 }
    : {};

  const panel = open && rect && createPortal(
    <div
      ref={panelRef}
      style={panelStyle}
      className="overflow-hidden rounded-xl border border-border bg-card shadow-lg shadow-black/20"
    >
      <div className="max-h-60 overflow-y-auto p-1.5">
        {items.map((item) => {
          const isSel = item.filename === value;
          return (
            <button
              key={item.filename}
              type="button"
              onClick={() => select(item.filename)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors',
                isSel ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted'
              )}
            >
              <VmLogo slug={slugs[item.filename]} size={22} fallbackIcon={fallbackIcon} />
              <span className="flex-1 truncate text-left">{item.name}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground/50">{item.sizeGb} GB</span>
              {isSel && <Check size={14} className="shrink-0 text-primary" />}
            </button>
          );
        })}
      </div>
    </div>,
    document.body
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        className={cn(
          'flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-sm transition-all',
          'hover:border-border/80 focus:outline-none focus:ring-2 focus:ring-ring',
          open ? 'border-primary ring-2 ring-primary/20' : 'border-border'
        )}
      >
        {selected ? (
          <>
            <VmLogo slug={slugs[selected.filename]} size={22} fallbackIcon={fallbackIcon} />
            <span className="flex-1 truncate text-left text-foreground">{selected.name}</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground/50">{selected.sizeGb} GB</span>
          </>
        ) : (
          <>
            <VmLogo slug={undefined} size={22} fallbackIcon={fallbackIcon} />
            <span className="flex-1 text-left text-muted-foreground">{placeholder}</span>
          </>
        )}
        <ChevronDown
          size={14}
          className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>
      {panel}
    </>
  );
}

// ─── Resources step ───────────────────────────────────────────────────────────

function ResourcesStep({
  form,
  setForm,
  templates,
  isos,
}: {
  form: FormData;
  setForm: React.Dispatch<React.SetStateAction<FormData>>;
  templates: Array<{ filename: string; name: string; sizeGb: number }>;
  isos: Array<{ filename: string; name: string; sizeGb: number }>;
}) {
  const activePreset  = matchPreset(form.cpus, form.memoryMb);
  const [customSize, setCustomSize] = useState(!activePreset);
  const [customDisk, setCustomDisk] = useState(!DISK_PRESETS.includes(form.diskGb));
  const { templates: templateLogos, isos: isoLogos } = useLogoStore();

  const selectPreset = (p: typeof SIZE_PRESETS[0]) => {
    setForm((f) => ({ ...f, cpus: p.cpus, memoryMb: p.memoryMb }));
    setCustomSize(false);
  };

  const switchSource = (type: SourceType) => {
    setForm((f) => ({ ...f, sourceType: type, templateFilename: '', isoFilename: '' }));
  };

  return (
    <div className="space-y-8">
      {/* VM Name */}
      <div className="space-y-2">
        <FieldLabel icon={Server}>VM Name</FieldLabel>
        <div className="relative">
          <Server className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/30" />
          <input
            type="text"
            placeholder="my-server"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            required
            className={cn(
              'block w-full rounded-lg border border-input bg-background py-2.5 pl-10 pr-4 text-sm text-foreground',
              'placeholder:text-muted-foreground/35 focus:outline-none focus:ring-2 focus:ring-ring'
            )}
          />
        </div>
      </div>

      {/* Size presets */}
      <div className="space-y-3">
        <FieldLabel icon={Cpu}>Choose a Size</FieldLabel>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {SIZE_PRESETS.map((p) => {
            const sel = !customSize && activePreset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => selectPreset(p)}
                className={cn(
                  'flex flex-col items-start rounded-lg border p-3.5 text-left transition-all duration-150',
                  sel
                    ? 'border-primary bg-primary/[0.07] ring-1 ring-primary/20'
                    : 'border-border bg-card/50 hover:border-border/80 hover:bg-muted/25'
                )}
              >
                <span className={cn('mb-2 text-xs font-semibold', sel ? 'text-foreground' : 'text-muted-foreground')}>
                  {p.label}
                </span>
                <span className={cn('font-mono text-xs', sel ? 'text-primary' : 'text-muted-foreground/50')}>
                  {p.cpus} vCPU
                </span>
                <span className={cn('font-mono text-xs', sel ? 'text-primary/80' : 'text-muted-foreground/50')}>
                  {mbToDisplay(p.memoryMb)}
                </span>
              </button>
            );
          })}
        </div>

        {customSize ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="vCPUs"
                type="number"
                min="1"
                max="64"
                value={form.cpus}
                onChange={(e) => setForm((f) => ({ ...f, cpus: e.target.value }))}
                required
              />
              <Input
                label="Memory (MB)"
                type="number"
                min="512"
                step="512"
                value={form.memoryMb}
                onChange={(e) => setForm((f) => ({ ...f, memoryMb: e.target.value }))}
                required
              />
            </div>
            <button
              type="button"
              onClick={() => {
                const p = SIZE_PRESETS.find((x) => x.cpus === form.cpus && x.memoryMb === form.memoryMb);
                if (p) setCustomSize(false);
                else setCustomSize(false);
              }}
              className="text-xs text-muted-foreground/60 underline underline-offset-2 hover:text-foreground"
            >
              Use a preset instead
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setCustomSize(true)}
            className="text-xs text-muted-foreground/50 underline underline-offset-2 hover:text-foreground"
          >
            Set custom CPU / RAM
          </button>
        )}
      </div>

      {/* Disk size */}
      <div className="space-y-3">
        <FieldLabel>Disk Size</FieldLabel>
        <div className="flex flex-wrap gap-2">
          {DISK_PRESETS.map((gb) => {
            const sel = !customDisk && form.diskGb === gb;
            return (
              <button
                key={gb}
                type="button"
                onClick={() => { setForm((f) => ({ ...f, diskGb: gb })); setCustomDisk(false); }}
                className={cn(
                  'rounded-lg border px-4 py-2 text-sm font-medium transition-all',
                  sel
                    ? 'border-primary bg-primary/[0.07] text-primary ring-1 ring-primary/20'
                    : 'border-border bg-card/50 text-muted-foreground hover:border-border/80 hover:bg-muted/25 hover:text-foreground'
                )}
              >
                {gb} GB
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setCustomDisk((v) => !v)}
            className={cn(
              'rounded-lg border px-4 py-2 text-sm font-medium transition-all',
              customDisk
                ? 'border-primary bg-primary/[0.07] text-primary ring-1 ring-primary/20'
                : 'border-border bg-card/50 text-muted-foreground hover:border-border/80 hover:bg-muted/25 hover:text-foreground'
            )}
          >
            Custom
          </button>
        </div>
        {customDisk && (
          <div className="max-w-[160px]">
            <Input
              label="Size (GB)"
              type="number"
              min="5"
              value={form.diskGb}
              onChange={(e) => setForm((f) => ({ ...f, diskGb: e.target.value }))}
              required
            />
          </div>
        )}
      </div>

      {/* CPU Mode */}
      <div className="space-y-3">
        <FieldLabel icon={Cpu} hint="— affects performance and migration compatibility">CPU Mode</FieldLabel>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {CPU_MODES.map((m) => {
            const sel = form.cpuMode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setForm((f) => ({ ...f, cpuMode: m.id }))}
                className={cn(
                  'flex flex-col items-start rounded-lg border p-3.5 text-left transition-all duration-150',
                  sel
                    ? 'border-primary bg-primary/[0.07] ring-1 ring-primary/20'
                    : 'border-border bg-card/50 hover:border-border/80 hover:bg-muted/25'
                )}
              >
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span className={cn('text-xs font-semibold', sel ? 'text-foreground' : 'text-muted-foreground')}>
                    {m.label}
                  </span>
                  {m.id === 'host-passthrough' && (
                    <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary">
                      default
                    </span>
                  )}
                </div>
                <span className="text-[10px] leading-relaxed text-muted-foreground/60">{m.desc}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Boot Source */}
      <div className="space-y-3">
        <FieldLabel icon={HardDrive}>Boot Source</FieldLabel>

        {/* Source type toggle */}
        <div className="flex rounded-lg border border-border bg-muted/20 p-1 gap-1">
          {(['template', 'iso'] as SourceType[]).map((type) => {
            const sel = form.sourceType === type;
            return (
              <button
                key={type}
                type="button"
                onClick={() => switchSource(type)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-all',
                  sel
                    ? 'bg-card shadow-sm text-foreground border border-border'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {type === 'template' ? (
                  <><HardDrive className="h-3.5 w-3.5" /> Cloud Image</>
                ) : (
                  <><Disc className="h-3.5 w-3.5" /> Install from ISO</>
                )}
              </button>
            );
          })}
        </div>

        {/* Template picker */}
        {form.sourceType === 'template' && (
          templates.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-muted/20 px-5 py-10 text-center">
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-muted">
                <HardDrive className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-semibold text-foreground">No templates available</p>
              <p className="mt-1 text-xs text-muted-foreground">
                <Link to="/templates" className="text-primary underline underline-offset-2">
                  Upload a qcow2 image
                </Link>{' '}
                on the Templates page first.
              </p>
            </div>
          ) : (
            <SourceDropdown
              items={templates}
              value={form.templateFilename}
              onChange={(filename) => setForm((f) => ({ ...f, templateFilename: filename }))}
              placeholder="Select a template…"
              slugs={templateLogos}
            />
          )
        )}

        {/* ISO picker */}
        {form.sourceType === 'iso' && (
          <>
            {isos.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/20 px-5 py-10 text-center">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-muted">
                  <Disc className="h-5 w-5 text-muted-foreground" />
                </div>
                <p className="text-sm font-semibold text-foreground">No ISOs available</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  <Link to="/isos" className="text-primary underline underline-offset-2">
                    Upload an ISO
                  </Link>{' '}
                  on the ISOs page first.
                </p>
              </div>
            ) : (
              <SourceDropdown
                items={isos}
                value={form.isoFilename}
                onChange={(filename) => setForm((f) => ({ ...f, isoFilename: filename }))}
                placeholder="Select an ISO…"
                slugs={isoLogos}
                fallbackIcon={Disc}
              />
            )}
            <p className="rounded-lg bg-amber-500/5 border border-amber-500/20 px-3 py-2.5 text-xs text-amber-400/80">
              A blank disk will be created. The VM will boot from the ISO so you can install the OS manually.
              Eject the ISO after installation and reboot to boot from disk.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Network step ─────────────────────────────────────────────────────────────

function NetworkCard({
  network,
  selection,
  onToggle,
  onSetPrimary,
  onSetIp,
  ipOptions: availableIps,
}: {
  network: import('@/types').Network;
  selection: NetworkSelection | undefined;
  onToggle: () => void;
  onSetPrimary: () => void;
  onSetIp: (ip: string) => void;
  ipOptions: Array<{ ip: string; allocated: boolean }>;
}) {
  const checked = !!selection;
  const needsIp = (network.type === 'bridge' || network.type === 'existing-bridge') && network.ipMode === 'static';

  const typeBadgeClass = network.type === 'nat'
    ? 'bg-blue-500/10 text-blue-400'
    : network.ipMode === 'dhcp'
      ? 'bg-violet-500/10 text-violet-400'
      : 'bg-emerald-500/10 text-emerald-400';

  const typeLabel = network.type === 'nat' ? 'NAT' : network.ipMode === 'dhcp' ? 'Bridge DHCP' : 'Bridge Static';

  return (
    <div className={cn(
      'rounded-lg border transition-all duration-150',
      checked ? 'border-primary bg-primary/[0.04] ring-1 ring-primary/20' : 'border-border bg-card/50',
    )}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-4 p-4 text-left"
      >
        <div className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors',
          checked ? 'border-primary bg-primary' : 'border-border bg-transparent'
        )}>
          {checked && <Check className="h-3 w-3 text-primary-foreground" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-foreground">{network.name}</p>
            <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', typeBadgeClass)}>
              {typeLabel}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground/60">
            <span>{network.cidr}</span>
            <span className="text-muted-foreground/25">·</span>
            <span>br: {network.bridge}</span>
            {network.physicalNic && <><span className="text-muted-foreground/25">·</span><span>{network.physicalNic}</span></>}
            <span className="text-muted-foreground/25">·</span>
            <span>gw: {network.gateway}</span>
          </div>
        </div>
      </button>

      {checked && (
        <div className="border-t border-border/50 px-4 pb-4 pt-3 space-y-3">
          <button
            type="button"
            onClick={onSetPrimary}
            className={cn(
              'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-all',
              selection.isPrimary
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-muted/30'
            )}
          >
            <div className={cn(
              'h-2 w-2 rounded-full',
              selection.isPrimary ? 'bg-primary' : 'bg-muted-foreground/30'
            )} />
            {selection.isPrimary ? 'Primary interface (default gateway)' : 'Set as primary interface'}
          </button>

          {needsIp && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">IP Address</p>
              {availableIps.length === 0 ? (
                <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
                  No available IPs — all addresses are allocated.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {availableIps.map((ip) => {
                    const sel = selection.staticIp === ip.ip;
                    return (
                      <button
                        key={ip.ip}
                        type="button"
                        onClick={() => onSetIp(ip.ip)}
                        className={cn(
                          'rounded border px-2.5 py-1 font-mono text-xs transition-all',
                          sel
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:bg-muted/30 hover:text-foreground'
                        )}
                      >
                        {ip.ip}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {(network.type === 'nat' || (network.type === 'bridge' && network.ipMode === 'dhcp')) && (
            <p className="text-xs text-muted-foreground">
              IP assigned via DHCP
              {network.type === 'nat' ? ' by libvirt' : ' by upstream network'}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function NetworkStep({
  form,
  setForm,
}: {
  form: FormData;
  setForm: React.Dispatch<React.SetStateAction<FormData>>;
}) {
  const { data: networks, isLoading } = useNetworks();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Spinner className="h-4 w-4" /> Loading networks…
      </div>
    );
  }

  if (!networks?.length) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/20 px-5 py-10 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-muted">
          <Network className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-sm font-semibold text-foreground">No networks configured</p>
        <p className="mt-1 text-xs text-muted-foreground">
          <Link to="/networks" className="text-primary underline underline-offset-2">
            Create a network
          </Link>{' '}
          before provisioning a VM.
        </p>
      </div>
    );
  }

  const toggle = (networkId: string) => {
    setForm((f) => {
      const exists = f.networks.find((s) => s.networkId === networkId);
      if (exists) {
        const remaining = f.networks.filter((s) => s.networkId !== networkId);
        if (exists.isPrimary && remaining.length > 0) {
          return { ...f, networks: remaining.map((s, i) => i === 0 ? { ...s, isPrimary: true } : s) };
        }
        return { ...f, networks: remaining };
      }
      const isFirst = f.networks.length === 0;
      return { ...f, networks: [...f.networks, { networkId, staticIp: '', isPrimary: isFirst }] };
    });
  };

  const setPrimary = (networkId: string) => {
    setForm((f) => ({
      ...f,
      networks: f.networks.map((s) => ({ ...s, isPrimary: s.networkId === networkId })),
    }));
  };

  const setIp = (networkId: string, ip: string) => {
    setForm((f) => ({
      ...f,
      networks: f.networks.map((s) => s.networkId === networkId ? { ...s, staticIp: ip } : s),
    }));
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <FieldLabel icon={Network} hint="— applies to all interfaces">NIC Model</FieldLabel>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {NIC_MODELS.map((m) => {
            const sel = form.nicModel === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setForm((f) => ({ ...f, nicModel: m.id }))}
                className={cn(
                  'flex flex-col items-start rounded-lg border p-3.5 text-left transition-all duration-150',
                  sel
                    ? 'border-primary bg-primary/[0.07] ring-1 ring-primary/20'
                    : 'border-border bg-card/50 hover:border-border/80 hover:bg-muted/25'
                )}
              >
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span className={cn('text-xs font-semibold', sel ? 'text-foreground' : 'text-muted-foreground')}>
                    {m.label}
                  </span>
                  {m.id === 'virtio' && (
                    <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary">
                      default
                    </span>
                  )}
                </div>
                <span className="text-[10px] leading-relaxed text-muted-foreground/60">{m.desc}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-3">
        <FieldLabel icon={Network} hint="Select one or more — tick to add, set one as primary">
          Networks
        </FieldLabel>
        <div className="space-y-2">
          {networks.map((n) => (
            <NetworkCardWithIps
              key={n.id}
              network={n}
              selection={form.networks.find((s) => s.networkId === n.id)}
              onToggle={() => toggle(n.id)}
              onSetPrimary={() => setPrimary(n.id)}
              onSetIp={(ip) => setIp(n.id, ip)}
            />
          ))}
        </div>
      </div>

      {form.networks.length > 1 && (
        <p className="rounded-lg bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{form.networks.length} NICs</span> will be created.
          The primary interface receives the default gateway. Additional interfaces are reachable but do not route
          internet traffic by default. NICs added after VM creation require manual configuration inside the VM.
        </p>
      )}
    </div>
  );
}

function NetworkCardWithIps({
  network,
  selection,
  onToggle,
  onSetPrimary,
  onSetIp,
}: {
  network: import('@/types').Network;
  selection: NetworkSelection | undefined;
  onToggle: () => void;
  onSetPrimary: () => void;
  onSetIp: (ip: string) => void;
}) {
  const { data: detail } = useNetwork(
    selection && (network.type === 'bridge' || network.type === 'existing-bridge') && network.ipMode === 'static' ? network.id : ''
  );
  const availableIps = (detail?.ips ?? []).filter((i) => !i.allocated);

  return (
    <NetworkCard
      network={network}
      selection={selection}
      onToggle={onToggle}
      onSetPrimary={onSetPrimary}
      onSetIp={onSetIp}
      ipOptions={availableIps}
    />
  );
}

// ─── Authentication step ──────────────────────────────────────────────────────

function AuthStep({
  form,
  setForm,
}: {
  form: FormData;
  setForm: React.Dispatch<React.SetStateAction<FormData>>;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const [copied, setCopied] = useState(false);

  const regenerate = () => {
    setForm((f) => ({ ...f, password: generatePassword() }));
    setShowPassword(true);
    setCopied(false);
  };

  const copyPassword = async () => {
    await navigator.clipboard.writeText(form.password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <FieldLabel icon={Server}>Hostname</FieldLabel>
        <Input
          placeholder={form.name || 'vm-hostname'}
          value={form.hostname}
          onChange={(e) => setForm((f) => ({ ...f, hostname: e.target.value }))}
        />
        <p className="text-xs text-muted-foreground/50">Defaults to the VM name if left blank.</p>
      </div>

      <div className="space-y-3">
        <FieldLabel icon={User}>Login Account</FieldLabel>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Username"
            value={form.username}
            onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
            required
          />
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground">Password</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                required
                className={cn(
                  'block w-full rounded-lg border border-input bg-background py-2 pl-3 pr-[84px]',
                  'font-mono text-sm text-foreground placeholder:text-muted-foreground/35',
                  'focus:outline-none focus:ring-2 focus:ring-ring'
                )}
              />
              <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  title={showPassword ? 'Hide password' : 'Show password'}
                  className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button
                  type="button"
                  onClick={regenerate}
                  title="Generate new password"
                  className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <RefreshCw size={13} />
                </button>
                <button
                  type="button"
                  onClick={copyPassword}
                  title={copied ? 'Copied!' : 'Copy password'}
                  className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <FieldLabel icon={KeyRound} hint="— optional">SSH Public Keys</FieldLabel>
        <textarea
          className={cn(
            'block w-full resize-none rounded-lg border border-input bg-background px-3 py-2.5',
            'font-mono text-xs text-foreground placeholder:text-muted-foreground/35',
            'focus:outline-none focus:ring-2 focus:ring-ring'
          )}
          rows={4}
          value={form.sshKeys}
          onChange={(e) => setForm((f) => ({ ...f, sshKeys: e.target.value }))}
          placeholder={'ssh-ed25519 AAAA...\nssh-rsa AAAA...'}
        />
        <p className="text-xs text-muted-foreground/50">
          One key per line. SSH keys are preferred over passwords for production use.
        </p>
      </div>
    </div>
  );
}

// ─── Review step ──────────────────────────────────────────────────────────────

function ReviewSection({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Cpu;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-[hsl(var(--surface))] px-5 py-2.5">
        <Icon className="h-3.5 w-3.5 text-muted-foreground/50" />
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/70">
          {title}
        </span>
      </div>
      <div className="divide-y divide-border">{children}</div>
    </div>
  );
}

function ReviewRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={cn('text-sm text-foreground', mono && 'font-mono')}>{value}</span>
    </div>
  );
}

function ReviewStep({
  form,
  sourceName,
  networkRows,
  startAfterCreate,
  onToggleStart,
}: {
  form: FormData;
  sourceName?: string;
  networkRows: Array<{ name: string; ip: string; primary: boolean }>;
  startAfterCreate: boolean;
  onToggleStart: () => void;
}) {
  const sshKeyCount = form.sshKeys.split('\n').filter((k) => k.trim()).length;
  const isIso = form.sourceType === 'iso';
  return (
    <div className="space-y-4">
      <ReviewSection title="Compute" icon={Cpu}>
        <ReviewRow label="VM Name"  value={form.name} />
        <ReviewRow label={isIso ? 'Install ISO' : 'Template'} value={sourceName ?? (isIso ? form.isoFilename : form.templateFilename)} />
        <ReviewRow label="vCPU"     value={`${form.cpus} vCPU${parseInt(form.cpus) !== 1 ? 's' : ''}`} />
        <ReviewRow label="Memory"   value={mbToDisplay(form.memoryMb)} />
        <ReviewRow label="Disk"     value={`${form.diskGb} GB (blank)`} />
      </ReviewSection>

      <ReviewSection title="Network" icon={Network}>
        {networkRows.length === 0 ? (
          <ReviewRow label="Network" value="—" />
        ) : (
          networkRows.map((r) => (
            <ReviewRow
              key={r.name}
              label={r.primary ? `${r.name} (primary)` : r.name}
              value={r.ip}
            />
          ))
        )}
      </ReviewSection>

      {!isIso && (
        <ReviewSection title="Authentication" icon={Shield}>
          <ReviewRow label="Hostname" value={form.hostname || form.name} />
          <ReviewRow label="Username" value={form.username} />
          <ReviewRow label="Password" value="••••••••" mono={false} />
          <ReviewRow
            label="SSH Keys"
            value={sshKeyCount > 0 ? `${sshKeyCount} key${sshKeyCount !== 1 ? 's' : ''}` : 'None'}
            mono={false}
          />
        </ReviewSection>
      )}

      {isIso && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-5 py-3">
          <p className="text-xs text-amber-400/80">
            The VM will boot from the ISO. Use the VNC console to complete OS installation,
            then eject the ISO and reboot to boot from disk.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between rounded-lg border border-border bg-card px-5 py-4">
        <div className="flex items-center gap-3">
          <Power className="h-4 w-4 shrink-0 text-muted-foreground/50" />
          <div>
            <p className="text-sm font-semibold text-foreground">Start after provisioning</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Automatically start the VM once it has been created.</p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={startAfterCreate}
          onClick={onToggleStart}
          className={cn(
            'relative ml-4 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent',
            'transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-card',
            startAfterCreate ? 'bg-primary' : 'bg-muted'
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200',
              startAfterCreate ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function VmCreatePage() {
  const navigate  = useNavigate();
  const createVm  = useCreateVm();
  const { data: templates = [] } = useTemplates();
  const { data: isos = [] }      = useIsos();
  const { data: networks }       = useNetworks();
  const { templates: templateLogos, isos: isoLogos, setVmLogo } = useLogoStore();

  const [step, setStep] = useState<Step>('resources');
  const [form, setForm] = useState<FormData>(() => ({ ...defaults, password: generatePassword() }));
  const [startAfterCreate, setStartAfterCreate] = useState(false);

  const isIsoInstall = form.sourceType === 'iso';
  const activeSteps: Step[] = isIsoInstall
    ? ['resources', 'network', 'review']
    : ALL_STEPS;

  const currentIndex = activeSteps.indexOf(step);

  const selectedTemplate = templates.find((t) => t.filename === form.templateFilename);
  const selectedIso      = isos.find((i) => i.filename === form.isoFilename);
  const sourceName       = isIsoInstall ? selectedIso?.name : selectedTemplate?.name;

  const next = () => setStep(activeSteps[currentIndex + 1]);
  const back = () => setStep(activeSteps[currentIndex - 1]);

  const networkStepValid = form.networks.length > 0 &&
    form.networks.some((s) => s.isPrimary) &&
    form.networks.every((s) => {
      const n = networks?.find((x) => x.id === s.networkId);
      return !(n?.type === 'bridge' && n?.ipMode === 'static') || !!s.staticIp;
    });

  const networkRows = form.networks.map((s) => {
    const n = networks?.find((x) => x.id === s.networkId);
    const ip = n?.type === 'bridge' && n?.ipMode === 'static'
      ? (s.staticIp || '—')
      : 'DHCP';
    return { name: n?.name ?? s.networkId, ip, primary: s.isPrimary };
  });
  const networkSummary = networkRows.length === 0
    ? undefined
    : networkRows.length === 1
      ? networkRows[0].name
      : `${networkRows.length} networks`;

  const resourcesStepValid = !!form.name && (isIsoInstall ? !!form.isoFilename : !!form.templateFilename);

  const handleCreate = async () => {
    try {
      if (isIsoInstall) {
        await createVm.mutateAsync({
          name: form.name,
          cpus: parseInt(form.cpus, 10),
          memoryMb: parseInt(form.memoryMb, 10),
          diskGb: parseInt(form.diskGb, 10),
          isoFilename: form.isoFilename,
          cpuMode: form.cpuMode,
          nicModel: form.nicModel,
          networks: form.networks.map((s) => ({
            networkId: s.networkId,
            staticIp: s.staticIp || undefined,
            isPrimary: s.isPrimary,
          })),
        });
      } else {
        await createVm.mutateAsync({
          name: form.name,
          cpus: parseInt(form.cpus, 10),
          memoryMb: parseInt(form.memoryMb, 10),
          diskGb: parseInt(form.diskGb, 10),
          templateFilename: form.templateFilename,
          cpuMode: form.cpuMode,
          nicModel: form.nicModel,
          networks: form.networks.map((s) => ({
            networkId: s.networkId,
            staticIp: s.staticIp || undefined,
            isPrimary: s.isPrimary,
          })),
          cloudInit: {
            hostname: form.hostname || form.name,
            username: form.username,
            password: form.password,
            sshKeys: form.sshKeys
              ? form.sshKeys.split('\n').map((k) => k.trim()).filter(Boolean)
              : [],
          },
        });
      }
      const inheritedSlug = isIsoInstall
        ? isoLogos[form.isoFilename]
        : templateLogos[form.templateFilename];
      if (inheritedSlug) setVmLogo(form.name, inheritedSlug);
      if (startAfterCreate) {
        try {
          await api.post(`/api/vms/${form.name}/start`);
          toast.success(`VM "${form.name}" created and started`);
        } catch {
          toast.success(`VM "${form.name}" created`);
          toast.warning('VM created but could not be started — start it manually from the VM list.');
        }
      } else {
        toast.success(`VM "${form.name}" created`);
      }
      navigate('/vms');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to create VM';
      toast.error(msg);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    // Guard against accidental Enter-key submission on non-review steps
    if (step === 'review') void handleCreate();
  };

  return (
    <Layout>
      <div className="mb-6">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Virtual Machines
        </Link>
      </div>

      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Create Virtual Machine</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Provision a new KVM guest from a cloud image or install from ISO.
        </p>
      </div>

      <StepIndicator current={step} steps={activeSteps} />

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[1fr_260px]">
        <form onSubmit={handleSubmit}>
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
            <div className="border-b border-border bg-[hsl(var(--surface))] px-6 py-4">
              <h2 className="text-base font-semibold text-foreground">
                {STEP_META[step].label}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{STEP_META[step].desc}</p>
            </div>

            <div className="p-6">
              {step === 'resources'   && <ResourcesStep form={form} setForm={setForm} templates={templates} isos={isos} />}
              {step === 'network'     && <NetworkStep   form={form} setForm={setForm} />}
              {step === 'cloud-init'  && <AuthStep      form={form} setForm={setForm} />}
              {step === 'review'      && (
                <ReviewStep
                  form={form}
                  sourceName={sourceName}
                  networkRows={networkRows}
                  startAfterCreate={startAfterCreate}
                  onToggleStart={() => setStartAfterCreate((v) => !v)}
                />
              )}
            </div>

            <div className="flex items-center justify-between border-t border-border bg-[hsl(var(--surface))] px-6 py-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={back}
                disabled={currentIndex === 0}
              >
                <ArrowLeft size={13} /> Back
              </Button>

              {step !== 'review' ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={next}
                  disabled={
                    (step === 'resources' && !resourcesStepValid) ||
                    (step === 'network'   && !networkStepValid)
                  }
                >
                  Continue <ArrowRight size={13} />
                </Button>
              ) : (
                <Button type="button" size="sm" onClick={handleCreate} disabled={createVm.isPending}>
                  {createVm.isPending ? (
                    <><Spinner className="h-3.5 w-3.5" /> Creating…</>
                  ) : startAfterCreate ? (
                    <><Power size={13} /> Create & Start</>
                  ) : (
                    <><Check size={13} /> Create VM</>
                  )}
                </Button>
              )}
            </div>
          </div>
        </form>

        <div className="sticky top-6 hidden xl:block">
          <SummarySidebar
            form={form}
            sourceName={sourceName}
            networkSummary={networkSummary}
          />
        </div>
      </div>
    </Layout>
  );
}
