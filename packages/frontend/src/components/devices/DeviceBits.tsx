import { Fragment, useState, type ReactNode } from 'react';
import { WarnGlyph } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { cn } from '@/lib/cn';
import type { DeviceKind, DeviceNote, GroupMember, PassthroughHost } from '@/types';

// Pieces the host's Devices page, a VM's Devices tab and the picker share, so
// a device reads the same everywhere it appears.

/** Kinds in the order they are listed, with the heading for each group. */
export const KIND_GROUPS: { kind: DeviceKind; label: string }[] = [
  { kind: 'gpu', label: 'GPUs and graphics cards' },
  { kind: 'network', label: 'Network cards' },
  { kind: 'storage', label: 'Storage controllers' },
  { kind: 'usb-controller', label: 'USB controllers' },
  { kind: 'accelerator', label: 'Accelerators' },
  { kind: 'audio', label: 'Audio devices' },
  { kind: 'other', label: 'Other PCI devices' },
  { kind: 'usb', label: 'USB devices' },
];

export function groupByKind<T extends { kind: DeviceKind }>(items: T[]): { kind: DeviceKind; label: string; items: T[] }[] {
  return KIND_GROUPS
    .map((g) => ({ ...g, items: items.filter((i) => i.kind === g.kind) }))
    .filter((g) => g.items.length > 0);
}

export function shortAddress(address: string): string {
  return address.startsWith('0000:') ? address.slice(5) : address;
}

/** Parts on one line, separated by middle dots, breaking only between parts ("NUMA node 0" stays whole). */
function Joined({ parts }: { parts: string[] }) {
  return (
    <div className="text-[12px] leading-5 text-muted-foreground">
      {parts.map((p, i) => (
        <Fragment key={`${i}-${p}`}>
          {i > 0 && ' · '}
          <span className="whitespace-nowrap">{p}</span>
        </Fragment>
      ))}
    </div>
  );
}

/** One attention or information line under a device. */
export function NoteLine({ note }: { note: DeviceNote }) {
  return note.tone === 'warn' ? (
    <p className="flex items-start gap-1.5 text-[12px] leading-5 text-amber-800 dark:text-amber-200">
      <WarnGlyph className="mt-[5px]" />
      <span>{note.text}</span>
    </p>
  ) : (
    <p className="text-[12px] leading-5 text-muted-foreground">{note.text}</p>
  );
}

/**
 * A device by name, then what it is and who made it, then the facts that
 * matter for passthrough and anything to know before using it.
 */
export function DeviceSummary({
  name, vendor, kindLabel, facts = [], members = [], notes = [], muted = false, extra,
}: {
  name: string;
  vendor: string;
  kindLabel: string;
  facts?: string[];
  members?: GroupMember[];
  notes?: DeviceNote[];
  muted?: boolean;
  extra?: ReactNode;
}) {
  // "NVIDIA L4" already says NVIDIA.
  const sub = [kindLabel, vendor && !name.startsWith(vendor) ? vendor : ''].filter(Boolean);
  return (
    <div className="min-w-0">
      <div className={cn('text-[13px] font-medium leading-5', muted ? 'text-muted-foreground' : 'text-foreground')}>{name}</div>
      <Joined parts={sub} />
      {facts.length > 0 && <Joined parts={facts} />}
      {members.length > 0 && (
        <div className="text-[12px] leading-5 text-muted-foreground">
          With {members.map((m) => `${m.name} (${shortAddress(m.address)})`).join(', ')}
        </div>
      )}
      {extra}
      {notes.length > 0 && <div className="mt-1 space-y-0.5">{notes.map((n, i) => <NoteLine key={i} note={n} />)}</div>}
    </div>
  );
}

/**
 * What passthrough needs from the host, in order, each with what is true now
 * and, when something is in the way, what to change. Quiet when all is well.
 */
export function HostChecksPanel({ host }: { host: PassthroughHost }) {
  const trouble = host.checks.some((c) => c.state === 'off');
  const quiet = host.checks.every((c) => c.state === 'ok' || c.state === 'na');
  const [open, setOpen] = useState(false);
  // All well: one line, the checks a click away. Anything off or uncertain stays open.
  const shown = open || !quiet;
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Passthrough on this host"
        className={shown ? undefined : 'border-b-0'}
        meta={trouble
          ? <span className="text-amber-800 dark:text-amber-200">PCI passthrough is not available yet</span>
          : <span>Ready for PCI and USB</span>}
        actions={quiet ? (
          <Button size="sm" variant="ghost" aria-expanded={shown} aria-controls="host-checks" onClick={() => setOpen((v) => !v)}>
            {shown ? 'Hide checks' : 'Show checks'}
          </Button>
        ) : undefined}
      />
      {shown && (
      <dl id="host-checks" className="divide-y divide-border">
        {host.checks.map((c) => (
          <div key={c.key} className="grid grid-cols-1 gap-x-6 gap-y-0.5 px-5 py-3 sm:grid-cols-[13rem_minmax(0,1fr)] sm:items-baseline">
            <dt className="text-[12.5px] text-muted-foreground">{c.label}</dt>
            <dd className="min-w-0">
              <span className={cn(
                'inline-flex items-center gap-1.5 text-[13px]',
                c.state === 'off' || c.state === 'warn' ? 'text-amber-800 dark:text-amber-200' : 'text-foreground',
                c.state === 'na' && 'text-muted-foreground',
              )}>
                {(c.state === 'off' || c.state === 'warn') && <WarnGlyph />}
                {c.value}
              </span>
              {c.fix && <p className="mt-0.5 text-[12.5px] leading-5 text-muted-foreground">{c.fix}</p>}
            </dd>
          </div>
        ))}
      </dl>
      )}
    </Panel>
  );
}
