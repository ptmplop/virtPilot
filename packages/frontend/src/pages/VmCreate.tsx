import React, { useEffect, useRef, useState, type FormEvent, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, Check, ChevronDown, Copy, Cpu, Disc, Eye, EyeOff,
  GripVertical, HardDrive, Network, Power, RefreshCw, Server, Shield, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Spinner } from '@/components/ui/Spinner';
import { Tooltip } from '@/components/ui/Tooltip';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { WarnGlyph } from '@/components/ui/Badge';
import { StorageDirSelect } from '@/components/StorageDirSelect';
import { useCreateVm } from '@/hooks/useVms';
import { useSshKeys } from '@/hooks/useSshKeys';
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
type FirmwareMode = 'uefi' | 'bios';

interface FormData {
  name: string;
  cpus: string;
  memoryMb: string;
  diskGb: string;
  storageDirId: string;
  sourceType: SourceType;
  templateFilename: string;
  isoFilename: string;
  networks: NetworkSelection[];
  hostname: string;
  username: string;
  password: string;
  selectedSshKeyIds: string[];
  cpuMode: CpuMode;
  nicModel: NicModel;
  firmware: FirmwareMode;
  secureBoot: boolean;
  vtpm: boolean;
}

const defaults: FormData = {
  name: '',
  cpus: '2',
  memoryMb: '2048',
  diskGb: '20',
  storageDirId: '',
  sourceType: 'template',
  templateFilename: '',
  isoFilename: '',
  networks: [],
  hostname: '',
  username: 'virtpilot',
  password: '',
  selectedSshKeyIds: [],
  cpuMode: 'host-passthrough',
  nicModel: 'virtio',
  firmware: 'uefi',
  secureBoot: false,
  vtpm: false,
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
  { id: 'host-model',       label: 'Host model',  desc: 'Copies host model. Safer if you plan to live-migrate VMs.' },
  { id: 'maximum',          label: 'Maximum',     desc: 'All features QEMU supports. Most compatible with unusual guests.' },
];

const NIC_MODELS: Array<{ id: NicModel; label: string; desc: string }> = [
  { id: 'virtio',  label: 'VirtIO',        desc: 'Best performance. Requires guest drivers (standard on Linux).' },
  { id: 'e1000e',  label: 'Intel e1000e',  desc: 'Good compatibility. Works out of the box on Windows and bare-metal images.' },
  { id: 'rtl8139', label: 'RTL8139',       desc: 'Legacy fallback. Use only if other models are unsupported by the guest.' },
];

const FIRMWARE_MODES: Array<{ id: FirmwareMode; label: string; desc: string }> = [
  { id: 'uefi', label: 'UEFI (OVMF)', desc: 'Modern firmware. Required for Windows 11, ARM images, and Secure Boot. Recommended for all new VMs.' },
  { id: 'bios', label: 'SeaBIOS',     desc: 'Legacy BIOS firmware. Use only for older guests or images that do not support UEFI.' },
];

// ─── Shared chrome ────────────────────────────────────────────────────────────

// A text field (DESIGN.md "Fields"), for the two inputs this page builds by hand.
const FIELD =
  'block h-9 w-full rounded-md border border-input bg-field px-3 text-[13.5px] text-foreground ' +
  'transition-[border-color,box-shadow] duration-150 hover:border-muted-foreground/40 ' +
  'focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/20';

// Selectable option cards (DESIGN.md): a hairline at rest, steel border and wash when chosen.
const OPTION = 'text-left transition-[border-color,background-color,box-shadow] duration-150';
const OPTION_REST = 'border-border bg-card hover:border-muted-foreground/40';
const OPTION_CHOSEN = 'border-primary bg-accent ring-1 ring-primary/30';

// A long step reads as ruled sections: a hairline between each, none at the ends.
const SECTIONS = 'divide-y divide-border [&>*]:py-6 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0';

const CALLOUT_ATTENTION =
  'flex items-start gap-2.5 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-amber-800 dark:text-amber-200';
const CALLOUT_INFO =
  'rounded-md border border-border bg-surface px-3.5 py-2.5 text-[12.5px] leading-relaxed text-muted-foreground';

const LINK = 'font-medium text-primary underline-offset-4 hover:underline';

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

// ─── Small controls ───────────────────────────────────────────────────────────

function Switch({ checked, onClick, label }: { checked: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card',
        checked ? 'bg-primary' : 'bg-input'
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.22)] transition-transform duration-200',
          checked ? 'translate-x-4' : 'translate-x-0'
        )}
      />
    </button>
  );
}

// One option card's heading: its name, and a quiet "default" where it is one.
function OptionTitle({ label, isDefault }: { label: string; isDefault?: boolean }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-[13px] font-semibold text-foreground">{label}</span>
      {isDefault && <span className="text-[11.5px] text-muted-foreground">default</span>}
    </span>
  );
}

function EmptySource({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-input px-5 py-10 text-center">
      <p className="text-[13.5px] font-medium text-foreground">{title}</p>
      <p className="mt-1 text-[12.5px] text-muted-foreground">{children}</p>
    </div>
  );
}

// ─── Step indicator ───────────────────────────────────────────────────────────

// Progress speaks steel, the selection colour: the current step wears the chosen-card
// wash, finished steps a check, steps ahead a hairline ring.
function StepIndicator({ current, steps }: { current: Step; steps: Step[] }) {
  const currentIndex = steps.indexOf(current);
  return (
    <div className="mb-6 flex items-center">
      {steps.map((s, i) => {
        const done   = i < currentIndex;
        const active = s === current;
        return (
          <Fragment key={s}>
            <div className="flex shrink-0 items-center gap-2.5" aria-current={active ? 'step' : undefined}>
              <div
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full border text-[12px] font-semibold tabular-nums transition-colors duration-200',
                  done   && 'border-primary/45 text-primary',
                  active && 'border-primary bg-accent text-primary',
                  !done && !active && 'border-border bg-card text-muted-foreground'
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : i + 1}
              </div>
              <span
                className={cn(
                  'text-[13px] transition-colors',
                  active ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground'
                )}
              >
                {STEP_META[s].label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={cn(
                  'mx-4 h-px flex-1 transition-colors duration-500',
                  done ? 'bg-primary/40' : 'bg-border'
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
  const rows: [string, string][] = [
    ['Name',      form.name || '—'],
    [sourceLabel, sourceName || '—'],
    ['vCPU',      form.cpus],
    ['RAM',       mbToDisplay(form.memoryMb)],
    ['Disk',      `${form.diskGb} GB`],
    ['Networks',  networkSummary || '—'],
    ...(form.sourceType === 'template'
      ? ([
          ['Hostname', form.hostname || form.name || '—'],
          ['Username', form.username],
        ] as [string, string][])
      : []),
  ];

  return (
    <Panel>
      <PanelHeader title="VM summary" />
      <dl className="divide-y divide-border px-5 py-1">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[5.25rem_minmax(0,1fr)] items-center gap-x-3 py-[9px]">
            <dt className="text-[12.5px] text-muted-foreground">{label}</dt>
            <dd
              className={cn(
                'min-w-0 truncate text-right font-mono text-[12px] tabular-nums',
                value === '—' ? 'text-muted-foreground' : 'text-foreground'
              )}
              title={value !== '—' ? value : undefined}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

// ─── Section label ────────────────────────────────────────────────────────────

function FieldLabel({
  children,
  hint,
  htmlFor,
}: {
  children: React.ReactNode;
  hint?: string;
  /** Makes the heading the field's label when the section is a single field. */
  htmlFor?: string;
}) {
  const Tag = htmlFor ? 'label' : 'div';
  return (
    <Tag htmlFor={htmlFor} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-[13px] font-semibold text-foreground">
        {children}
      </span>
      {hint && (
        <span className="text-[12px] text-muted-foreground">{hint}</span>
      )}
    </Tag>
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
      className="overflow-hidden rounded-lg border border-border bg-card shadow-pop animate-fade-in"
    >
      <div className="max-h-60 overflow-y-auto p-1">
        {items.map((item) => {
          const isSel = item.filename === value;
          return (
            <button
              key={item.filename}
              type="button"
              onClick={() => select(item.filename)}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-[13.5px] transition-colors',
                isSel ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-muted'
              )}
            >
              <VmLogo slug={slugs[item.filename]} size={22} fallbackIcon={fallbackIcon} />
              <span className={cn('flex-1 truncate text-left', isSel && 'font-medium')}>{item.name}</span>
              <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground">{item.sizeGb} GB</span>
              {isSel ? <Check size={14} className="shrink-0 text-primary" /> : <span className="w-[14px] shrink-0" />}
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
        aria-expanded={open}
        className={cn(
          'flex h-11 w-full items-center gap-3 rounded-md border bg-field px-3 text-[13.5px] transition-[border-color,box-shadow] duration-150',
          'focus:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20',
          open ? 'border-ring ring-[3px] ring-ring/20' : 'border-input hover:border-muted-foreground/40'
        )}
      >
        {selected ? (
          <>
            <VmLogo slug={slugs[selected.filename]} size={22} fallbackIcon={fallbackIcon} />
            <span className="flex-1 truncate text-left text-foreground">{selected.name}</span>
            <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground">{selected.sizeGb} GB</span>
          </>
        ) : (
          <>
            <VmLogo slug={undefined} size={22} fallbackIcon={fallbackIcon} />
            <span className="flex-1 text-left text-muted-foreground">{placeholder}</span>
          </>
        )}
        <ChevronDown
          size={15}
          className={cn('shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-180')}
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
    <div className={SECTIONS}>
      {/* VM Name */}
      <div className="space-y-2.5">
        <FieldLabel htmlFor="vm-name">VM name</FieldLabel>
        <input
          id="vm-name"
          type="text"
          placeholder="my-server"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          required
          className={FIELD}
        />
      </div>

      {/* Size presets */}
      <div className="space-y-3">
        <FieldLabel>Choose a size</FieldLabel>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {SIZE_PRESETS.map((p) => {
            const sel = !customSize && activePreset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => selectPreset(p)}
                aria-pressed={sel}
                className={cn(
                  OPTION,
                  'flex flex-col items-start rounded-lg border px-3.5 py-3',
                  sel ? OPTION_CHOSEN : OPTION_REST
                )}
              >
                <span className="text-[13px] font-semibold text-foreground">
                  {p.label}
                </span>
                <span className={cn('mt-1.5 font-mono text-[12px] tabular-nums', sel ? 'text-accent-foreground' : 'text-muted-foreground')}>
                  {p.cpus} vCPU
                </span>
                <span className={cn('font-mono text-[12px] tabular-nums', sel ? 'text-accent-foreground' : 'text-muted-foreground')}>
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
                className="font-mono tabular-nums"
              />
              <Input
                label="Memory (MB)"
                type="number"
                min="512"
                step="512"
                value={form.memoryMb}
                onChange={(e) => setForm((f) => ({ ...f, memoryMb: e.target.value }))}
                required
                className="font-mono tabular-nums"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                const p = SIZE_PRESETS.find((x) => x.cpus === form.cpus && x.memoryMb === form.memoryMb);
                if (p) setCustomSize(false);
                else setCustomSize(false);
              }}
              className={cn(LINK, 'rounded-sm text-[12.5px]')}
            >
              Use a preset instead
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setCustomSize(true)}
            className={cn(LINK, 'rounded-sm text-[12.5px]')}
          >
            Set custom CPU / RAM
          </button>
        )}
      </div>

      {/* Disk size */}
      <div className="space-y-3">
        <FieldLabel>Disk size</FieldLabel>
        <div className="flex flex-wrap gap-2">
          {DISK_PRESETS.map((gb) => {
            const sel = !customDisk && form.diskGb === gb;
            return (
              <button
                key={gb}
                type="button"
                onClick={() => { setForm((f) => ({ ...f, diskGb: gb })); setCustomDisk(false); }}
                aria-pressed={sel}
                className={cn(
                  OPTION,
                  'h-9 rounded-md border px-4 text-[13px] font-medium tabular-nums',
                  sel ? cn(OPTION_CHOSEN, 'text-accent-foreground') : cn(OPTION_REST, 'text-foreground')
                )}
              >
                {gb} GB
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setCustomDisk((v) => !v)}
            aria-pressed={customDisk}
            className={cn(
              OPTION,
              'h-9 rounded-md border px-4 text-[13px] font-medium',
              customDisk ? cn(OPTION_CHOSEN, 'text-accent-foreground') : cn(OPTION_REST, 'text-foreground')
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
              className="font-mono tabular-nums"
            />
          </div>
        )}
        <div className="max-w-sm pt-1">
          <StorageDirSelect
            purpose="vmDisks"
            value={form.storageDirId}
            onChange={(id) => setForm((f) => ({ ...f, storageDirId: id }))}
          />
        </div>
      </div>

      {/* CPU Mode */}
      <div className="space-y-3">
        <FieldLabel hint="— affects performance and migration compatibility">CPU mode</FieldLabel>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {CPU_MODES.map((m) => {
            const sel = form.cpuMode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setForm((f) => ({ ...f, cpuMode: m.id }))}
                aria-pressed={sel}
                className={cn(
                  OPTION,
                  'flex flex-col items-start rounded-lg border px-3.5 py-3',
                  sel ? OPTION_CHOSEN : OPTION_REST
                )}
              >
                <OptionTitle label={m.label} isDefault={m.id === 'host-passthrough'} />
                <span className="mt-1 text-[12px] leading-[1.45] text-muted-foreground">{m.desc}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Firmware */}
      <div className="space-y-3">
        <FieldLabel hint="— affects OS compatibility and Secure Boot">Firmware</FieldLabel>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {FIRMWARE_MODES.map((m) => {
            const sel = form.firmware === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setForm((f) => ({ ...f, firmware: m.id, ...(m.id === 'bios' ? { secureBoot: false } : {}) }))}
                aria-pressed={sel}
                className={cn(
                  OPTION,
                  'flex flex-col items-start rounded-lg border px-3.5 py-3',
                  sel ? OPTION_CHOSEN : OPTION_REST
                )}
              >
                <OptionTitle label={m.label} isDefault={m.id === 'uefi'} />
                <span className="mt-1 text-[12px] leading-[1.45] text-muted-foreground">{m.desc}</span>
              </button>
            );
          })}
        </div>
        {form.firmware === 'uefi' && (
          <div className="divide-y divide-border rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground">Secure Boot</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                  Enforces signed bootloaders. Required for Windows 11; disable for most Linux guests.
                </p>
              </div>
              <Switch
                checked={form.secureBoot}
                label="Secure Boot"
                onClick={() => setForm((f) => ({ ...f, secureBoot: !f.secureBoot, vtpm: !f.secureBoot ? true : f.vtpm }))}
              />
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground">Virtual TPM 2.0</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                  Emulated TPM chip via swtpm. Required for Windows 11; optional for other guests.
                </p>
              </div>
              <Switch
                checked={form.vtpm}
                label="Virtual TPM 2.0"
                onClick={() => setForm((f) => ({ ...f, vtpm: !f.vtpm }))}
              />
            </div>
          </div>
        )}
      </div>

      {/* Boot Source */}
      <div className="space-y-3">
        <FieldLabel>Boot source</FieldLabel>

        {/* Source type toggle */}
        <div className="segmented flex w-full" role="group" aria-label="Boot source">
          {(['template', 'iso'] as SourceType[]).map((type) => {
            const sel = form.sourceType === type;
            return (
              <button
                key={type}
                type="button"
                onClick={() => switchSource(type)}
                aria-pressed={sel}
                className="flex flex-1 items-center justify-center gap-2 py-1.5"
              >
                {type === 'template' ? (
                  <><HardDrive className="h-3.5 w-3.5" /> Cloud image</>
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
            <EmptySource title="No templates available">
              <Link to="/templates" className={LINK}>
                Upload a qcow2 image
              </Link>{' '}
              on the Templates page first.
            </EmptySource>
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
              <EmptySource title="No ISOs available">
                <Link to="/isos" className={LINK}>
                  Upload an ISO
                </Link>{' '}
                on the ISOs page first.
              </EmptySource>
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
            <p className={CALLOUT_ATTENTION}>
              <WarnGlyph size={10} className="mt-[5px]" />
              <span>
                A blank disk will be created. The VM will boot from the ISO so you can install the OS manually.
                Eject the ISO after installation and reboot to boot from disk.
              </span>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Network step ─────────────────────────────────────────────────────────────

// Both bridge kinds carry a static-IP mode — 'bridge' is a VirtPilot-managed
// bridge, 'existing-bridge' one that already existed on the host. Every place
// that decides "does this NIC need an IP?" has to agree, otherwise the wizard
// lets an existing-bridge static network through without one, shows "DHCP" on
// the Review step, and the backend rejects it at the very last click.
function isStaticBridge(network: import('@/types').Network | undefined): boolean {
  if (!network) return false;
  return (network.type === 'bridge' || network.type === 'existing-bridge') && network.ipMode === 'static';
}

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
  const needsIp = isStaticBridge(network);
  // The DHCP note has to cover both bridge kinds too: an existing bridge on DHCP
  // used to get neither an IP picker nor this line.
  const isBridge = network.type === 'bridge' || network.type === 'existing-bridge';

  const prefix = network.type === 'existing-bridge' ? 'OS Bridge' : 'Bridge';
  const typeLabel = network.type === 'nat' ? 'NAT' : network.ipMode === 'dhcp' ? `${prefix} DHCP` : `${prefix} Static`;

  return (
    <div className={cn(
      'rounded-lg border',
      OPTION,
      checked ? OPTION_CHOSEN : OPTION_REST,
    )}>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={checked}
        className="flex w-full items-center gap-3.5 rounded-lg px-4 py-3.5 text-left"
      >
        <span className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-field'
        )}>
          {checked && <Check className="h-3 w-3" strokeWidth={3} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5">
            <p className="text-[13.5px] font-semibold text-foreground">{network.name}</p>
            <span className="text-[12px] font-medium text-muted-foreground">
              {typeLabel}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[12px] text-muted-foreground">
            <span>{network.cidr}</span>
            <span aria-hidden>·</span>
            <span>br: {network.bridge}</span>
            {network.physicalNic && <><span aria-hidden>·</span><span>{network.physicalNic}</span></>}
            <span aria-hidden>·</span>
            <span>gw: {network.gateway}</span>
          </div>
        </div>
      </button>

      {checked && (
        <div className="space-y-3 border-t border-primary/20 px-4 pb-4 pt-3">
          <button
            type="button"
            onClick={onSetPrimary}
            aria-pressed={selection.isPrimary}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-3 text-[12.5px] font-medium transition-colors',
              selection.isPrimary
                ? 'border-primary/40 text-primary'
                : 'border-input text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground'
            )}
          >
            {selection.isPrimary && <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
            {selection.isPrimary ? 'Primary interface (default gateway)' : 'Set as primary interface'}
          </button>

          {needsIp && (
            availableIps.length === 0 ? (
              <div className="space-y-1.5">
                <p className="text-[12.5px] font-medium text-foreground">IP address</p>
                <p className="rounded-md border border-destructive/30 bg-destructive/[0.06] px-3.5 py-2.5 text-[12.5px] text-red-800 dark:text-red-200">
                  No available IPs — all addresses are allocated.
                </p>
              </div>
            ) : (
              <Select
                id={`ip-${network.id}`}
                label="IP address"
                value={selection.staticIp}
                onChange={(e) => onSetIp(e.target.value)}
                className="font-mono"
              >
                <option value="">Select an IP…</option>
                {availableIps.map((ip) => (
                  <option key={ip.ip} value={ip.ip}>{ip.ip}</option>
                ))}
              </Select>
            )
          )}

          {(network.type === 'nat' || (isBridge && network.ipMode === 'dhcp')) && (
            <p className="text-[12.5px] text-muted-foreground">
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
      <div className="flex items-center gap-2 py-10 text-[13px] text-muted-foreground">
        <Spinner className="h-4 w-4" /> Loading networks…
      </div>
    );
  }

  if (!networks?.length) {
    return (
      <EmptySource title="No networks configured">
        <Link to="/networks" className={LINK}>
          Create a network
        </Link>{' '}
        before provisioning a VM.
      </EmptySource>
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
    <div className={SECTIONS}>
      <div className="space-y-3">
        <FieldLabel hint="— applies to all interfaces">NIC model</FieldLabel>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {NIC_MODELS.map((m) => {
            const sel = form.nicModel === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setForm((f) => ({ ...f, nicModel: m.id }))}
                aria-pressed={sel}
                className={cn(
                  OPTION,
                  'flex flex-col items-start rounded-lg border px-3.5 py-3',
                  sel ? OPTION_CHOSEN : OPTION_REST
                )}
              >
                <OptionTitle label={m.label} isDefault={m.id === 'virtio'} />
                <span className="mt-1 text-[12px] leading-[1.45] text-muted-foreground">{m.desc}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-3">
        <FieldLabel hint="Select one or more — tick to add, set one as primary">
          Networks
        </FieldLabel>
        <div className="space-y-2.5">
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

        {form.networks.length > 1 && (
          <p className={CALLOUT_INFO}>
            <span className="font-medium text-foreground">{form.networks.length} NICs</span> will be created.
            The primary interface receives the default gateway. Additional interfaces are reachable but do not route
            internet traffic by default. NICs added after VM creation require manual configuration inside the VM.
          </p>
        )}
      </div>
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
    selection && isStaticBridge(network) ? network.id : ''
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

// ─── SSH key picker ───────────────────────────────────────────────────────────

function SshKeyPicker({
  form,
  setForm,
}: {
  form: FormData;
  setForm: React.Dispatch<React.SetStateAction<FormData>>;
}) {
  const { data: keys = [], isLoading } = useSshKeys();
  const [dropActive, setDropActive] = useState(false);
  const dragId = useRef<string | null>(null);

  const selected = keys.filter((k) => form.selectedSshKeyIds.includes(k.id));
  const available = keys.filter((k) => !form.selectedSshKeyIds.includes(k.id));

  const addKey = (id: string) =>
    setForm((f) => ({ ...f, selectedSshKeyIds: [...f.selectedSshKeyIds, id] }));
  const removeKey = (id: string) =>
    setForm((f) => ({ ...f, selectedSshKeyIds: f.selectedSshKeyIds.filter((k) => k !== id) }));

  const onDragStart = (e: React.DragEvent, id: string) => {
    dragId.current = id;
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropActive(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropActive(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    if (dragId.current) { addKey(dragId.current); dragId.current = null; }
  };

  return (
    <div className="space-y-3">
      <FieldLabel hint="— optional">SSH keys</FieldLabel>

      {isLoading ? (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Spinner className="h-3.5 w-3.5" /> Loading keys…
        </div>
      ) : !keys.length ? (
        <div className="rounded-lg border border-dashed border-input px-4 py-5 text-center">
          <p className="text-[12.5px] text-muted-foreground">No SSH keys saved.</p>
          <Link to="/ssh-keys" className={cn(LINK, 'mt-1 inline-block text-[12.5px]')}>
            Add keys in SSH Keys settings →
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {/* Available */}
          <div className="space-y-1.5">
            <p className="text-[12.5px] font-medium text-foreground">
              Available
            </p>
            <div className="min-h-[88px] overflow-hidden rounded-lg border border-border bg-card">
              {available.length === 0 ? (
                <div className="flex min-h-[88px] items-center justify-center">
                  <p className="text-[12.5px] text-muted-foreground">All keys added</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {available.map((key) => (
                    <div
                      key={key.id}
                      draggable
                      onDragStart={(e) => onDragStart(e, key.id)}
                      onClick={() => addKey(key.id)}
                      // Keyboard users had no way to add a key: the row was mouse-only.
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addKey(key.id); }
                      }}
                      className="flex cursor-grab select-none items-center gap-2.5 px-3 py-2.5 transition-colors hover:bg-surface focus-visible:outline-offset-[-2px] active:cursor-grabbing"
                      title="Drag or click to add"
                    >
                      <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium text-foreground">{key.name}</p>
                        <p className="truncate font-mono text-[11.5px] text-muted-foreground">
                          {key.publicKey.slice(0, 30)}…
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Drop target */}
          <div className="space-y-1.5">
            <p className="text-[12.5px] font-medium text-foreground">
              Added
            </p>
            <div
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              className={cn(
                'min-h-[88px] overflow-hidden rounded-lg border transition-colors duration-150',
                dropActive
                  ? 'border-primary bg-accent'
                  : selected.length === 0
                  ? 'border-dashed border-input'
                  : 'border-border bg-card'
              )}
            >
              {selected.length === 0 ? (
                <div className="pointer-events-none flex min-h-[88px] flex-col items-center justify-center gap-1">
                  <p className="text-[12.5px] text-muted-foreground">
                    {dropActive ? 'Release to add' : 'Drag keys here'}
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {selected.map((key) => (
                    <div key={key.id} className="flex items-center gap-2.5 py-1.5 pl-3 pr-1.5">
                      <Check className="h-3.5 w-3.5 shrink-0 text-primary" strokeWidth={2.5} />
                      <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                        {key.name}
                      </p>
                      <Tooltip label="Remove key">
                        <button
                          type="button"
                          onClick={() => removeKey(key.id)}
                          aria-label={`Remove ${key.name}`}
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </Tooltip>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {keys.length > 0 && (
        <p className="text-[12.5px] text-muted-foreground">
          {selected.length === 0
            ? 'No keys added — password-only access.'
            : `${selected.length} key${selected.length !== 1 ? 's' : ''} will be authorised on this VM.`}
        </p>
      )}
    </div>
  );
}

// ─── Authentication step ──────────────────────────────────────────────────────

const FIELD_ACTION =
  'flex h-7 w-7 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

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
    <div className={SECTIONS}>
      <div className="space-y-2.5">
        <FieldLabel htmlFor="vm-hostname">Hostname</FieldLabel>
        <Input
          id="vm-hostname"
          placeholder={form.name || 'vm-hostname'}
          value={form.hostname}
          onChange={(e) => setForm((f) => ({ ...f, hostname: e.target.value }))}
        />
        <p className="text-[12.5px] text-muted-foreground">Defaults to the VM name if left blank.</p>
      </div>

      <div className="space-y-3">
        <FieldLabel>Login account</FieldLabel>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Username"
            value={form.username}
            onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
            required
          />
          <div className="space-y-1.5">
            <label htmlFor="vm-password" className="block text-[12.5px] font-medium text-foreground">Password</label>
            <div className="relative">
              <input
                id="vm-password"
                type={showPassword ? 'text' : 'password'}
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                required
                className={cn(FIELD, 'pr-[100px] font-mono text-[13px]')}
              />
              <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
                <Tooltip label={showPassword ? 'Hide password' : 'Show password'}>
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className={FIELD_ACTION}
                  >
                    {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </Tooltip>
                <Tooltip label="Generate new password">
                  <button
                    type="button"
                    onClick={regenerate}
                    aria-label="Generate new password"
                    className={FIELD_ACTION}
                  >
                    <RefreshCw size={14} />
                  </button>
                </Tooltip>
                <Tooltip label={copied ? 'Copied!' : 'Copy password'}>
                  <button
                    type="button"
                    onClick={copyPassword}
                    aria-label={copied ? 'Copied!' : 'Copy password'}
                    className={FIELD_ACTION}
                  >
                    {copied ? <Check size={14} className="text-emerald-600 dark:text-emerald-400" /> : <Copy size={14} />}
                  </button>
                </Tooltip>
              </div>
            </div>
          </div>
        </div>
      </div>

      <SshKeyPicker form={form} setForm={setForm} />
    </div>
  );
}

// ─── Review step ──────────────────────────────────────────────────────────────

function ReviewSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Panel className="overflow-hidden">
      <PanelHeader title={title} />
      <dl className="divide-y divide-border">{children}</dl>
    </Panel>
  );
}

function ReviewRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-2.5">
      <dt className="shrink-0 text-[13px] text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 truncate text-right text-foreground', mono ? 'font-mono text-[12.5px] tabular-nums' : 'text-[13px]')}>
        {value}
      </dd>
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
  const sshKeyCount = form.selectedSshKeyIds.length;
  const isIso = form.sourceType === 'iso';
  return (
    <div className="space-y-4">
      <ReviewSection title="Compute">
        <ReviewRow label="VM name"  value={form.name} />
        <ReviewRow label={isIso ? 'Install ISO' : 'Template'} value={sourceName ?? (isIso ? form.isoFilename : form.templateFilename)} />
        <ReviewRow label="vCPU"     value={`${form.cpus} vCPU${parseInt(form.cpus) !== 1 ? 's' : ''}`} />
        <ReviewRow label="Memory"   value={mbToDisplay(form.memoryMb)} />
        {/* Only an ISO install starts from a blank disk; a template's disk is the image. */}
        <ReviewRow label="Disk"     value={`${form.diskGb} GB${isIso ? ' (blank)' : ''}`} />
        <ReviewRow label="Firmware" value={form.firmware === 'uefi' ? (form.secureBoot ? 'UEFI + Secure Boot' : 'UEFI') : 'SeaBIOS'} mono={false} />
        {form.vtpm && <ReviewRow label="Virtual TPM" value="TPM 2.0 (emulated)" mono={false} />}
      </ReviewSection>

      <ReviewSection title="Network">
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
        <ReviewSection title="Authentication">
          <ReviewRow label="Hostname" value={form.hostname || form.name} />
          <ReviewRow label="Username" value={form.username} />
          <ReviewRow label="Password" value="••••••••" mono={false} />
          <ReviewRow
            label="SSH keys"
            value={sshKeyCount > 0 ? `${sshKeyCount} key${sshKeyCount !== 1 ? 's' : ''}` : 'None'}
            mono={false}
          />
        </ReviewSection>
      )}

      {isIso && (
        <p className={CALLOUT_ATTENTION}>
          <WarnGlyph size={10} className="mt-[5px]" />
          <span>
            The VM will boot from the ISO. Use the VNC console to complete OS installation,
            then eject the ISO and reboot to boot from disk.
          </span>
        </p>
      )}

      <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-5 py-4">
        <div className="flex items-center gap-3">
          <Power className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-[13.5px] font-semibold text-foreground">Start after provisioning</p>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">Automatically start the VM once it has been created.</p>
          </div>
        </div>
        <Switch checked={startAfterCreate} onClick={onToggleStart} label="Start after provisioning" />
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function VmCreatePage() {
  const navigate  = useNavigate();
  const createVm  = useCreateVm();
  const { data: savedSshKeys = [] } = useSshKeys();
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
      return !isStaticBridge(n) || !!s.staticIp;
    });

  const networkRows = form.networks.map((s) => {
    const n = networks?.find((x) => x.id === s.networkId);
    const ip = isStaticBridge(n)
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
      let createdUuid: string;
      if (isIsoInstall) {
        const result = await createVm.mutateAsync({
          name: form.name,
          cpus: parseInt(form.cpus, 10),
          memoryMb: parseInt(form.memoryMb, 10),
          diskGb: parseInt(form.diskGb, 10),
          storageDirId: form.storageDirId || undefined,
          isoFilename: form.isoFilename,
          cpuMode: form.cpuMode,
          nicModel: form.nicModel,
          firmware: form.firmware,
          secureBoot: form.secureBoot,
          vtpm: form.vtpm,
          networks: form.networks.map((s) => ({
            networkId: s.networkId,
            staticIp: s.staticIp || undefined,
            isPrimary: s.isPrimary,
          })),
        });
        createdUuid = result.uuid;
      } else {
        const result = await createVm.mutateAsync({
          name: form.name,
          cpus: parseInt(form.cpus, 10),
          memoryMb: parseInt(form.memoryMb, 10),
          diskGb: parseInt(form.diskGb, 10),
          storageDirId: form.storageDirId || undefined,
          templateFilename: form.templateFilename,
          cpuMode: form.cpuMode,
          nicModel: form.nicModel,
          firmware: form.firmware,
          secureBoot: form.secureBoot,
          vtpm: form.vtpm,
          networks: form.networks.map((s) => ({
            networkId: s.networkId,
            staticIp: s.staticIp || undefined,
            isPrimary: s.isPrimary,
          })),
          cloudInit: {
            hostname: form.hostname || form.name,
            username: form.username,
            password: form.password,
            sshKeys: form.selectedSshKeyIds
              .map((id) => savedSshKeys.find((k) => k.id === id)?.publicKey ?? '')
              .filter(Boolean),
          },
        });
        createdUuid = result.uuid;
      }
      const inheritedSlug = isIsoInstall
        ? isoLogos[form.isoFilename]
        : templateLogos[form.templateFilename];
      if (inheritedSlug) setVmLogo(form.name, inheritedSlug);
      if (startAfterCreate) {
        try {
          await api.post(`/api/vms/${createdUuid}/start`);
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
      <div className="mb-5">
        {/* Labelled "Virtual machines", so it goes there: it used to lead to the dashboard. */}
        <Link
          to="/vms"
          className="inline-flex items-center gap-1.5 rounded-sm text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Virtual machines
        </Link>
      </div>

      <div className="mb-7">
        <h1 className="text-[26px] font-semibold leading-8 tracking-[-0.024em] text-foreground">Create virtual machine</h1>
        <p className="mt-1 text-[13.5px] text-muted-foreground">
          Provision a new KVM guest from a cloud image or install from ISO.
        </p>
      </div>

      <StepIndicator current={step} steps={activeSteps} />

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[1fr_264px]">
        <form onSubmit={handleSubmit} className="min-w-0">
          <Panel className="overflow-hidden">
            <PanelHeader
              title={STEP_META[step].label}
              meta={STEP_META[step].desc}
            />

            <div className="px-5 py-6">
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

            <div className="flex items-center justify-between border-t border-border bg-surface px-5 py-3">
              <Button
                type="button"
                variant="secondary"
                onClick={back}
                disabled={currentIndex === 0}
              >
                <ArrowLeft size={14} /> Back
              </Button>

              {step !== 'review' ? (
                <Button
                  type="button"
                  onClick={next}
                  disabled={
                    (step === 'resources' && !resourcesStepValid) ||
                    (step === 'network'   && !networkStepValid)
                  }
                >
                  Continue <ArrowRight size={14} />
                </Button>
              ) : (
                <Button type="button" onClick={handleCreate} disabled={createVm.isPending}>
                  {createVm.isPending ? (
                    <><Spinner className="h-3.5 w-3.5 text-current" /> Creating…</>
                  ) : startAfterCreate ? (
                    <><Power size={14} /> Create & start</>
                  ) : (
                    <><Check size={14} /> Create VM</>
                  )}
                </Button>
              )}
            </div>
          </Panel>
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
