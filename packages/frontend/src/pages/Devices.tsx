import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardCopy, MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusGlyph } from '@/components/ui/Badge';
import { DeviceSummary, HostChecksPanel, groupByKind, shortAddress } from '@/components/devices/DeviceBits';
import { fetchPassthroughReport, useDeviceInventory, useKeepDevice, useVirtualFunctions } from '@/hooks/useDevices';
import { apiErrorMessage } from '@/lib/api';
import type { HiddenDevice, PassthroughDevice } from '@/types';

const HIDDEN_GROUPS: { category: HiddenDevice['category']; label: string }[] = [
  { category: 'host', label: 'Used by the host' },
  { category: 'chipset', label: 'Chipset and processor functions' },
  { category: 'bridge', label: 'Bridges' },
  { category: 'hub', label: 'USB hubs' },
];

function hiddenSummary(hidden: HiddenDevice[]): string {
  const count = (c: HiddenDevice['category']) => hidden.filter((h) => h.category === c).length;
  const parts = [
    count('host') && `${count('host')} the host needs`,
    count('chipset') && `${count('chipset')} chipset and processor function${count('chipset') === 1 ? '' : 's'}`,
    count('bridge') && `${count('bridge')} bridge${count('bridge') === 1 ? '' : 's'}`,
    count('hub') && `${count('hub')} USB hub${count('hub') === 1 ? '' : 's'}`,
  ].filter(Boolean) as string[];
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `${hidden.length} more device${hidden.length === 1 ? " isn't" : "s aren't"} offered: ${list}.`;
}

/** A CPU repeats the same register function dozens of times; list each kind once, with a count. */
function collapseAlike(rows: HiddenDevice[]): { first: HiddenDevice; count: number }[] {
  const seen = new Map<string, { first: HiddenDevice; count: number }>();
  for (const h of rows) {
    const key = `${h.type}|${h.vendor}|${h.name}|${h.reason}`;
    const entry = seen.get(key);
    if (entry) entry.count += 1;
    else seen.set(key, { first: h, count: 1 });
  }
  return [...seen.values()];
}

/** Who has the device, in two lines like the Address beside it: a VM and its state, or the host and its driver. */
function UsedBy({ d }: { d: PassthroughDevice }) {
  if (d.usedBy.length) {
    return (
      <div className="space-y-1.5">
        {d.usedBy.map((v) => (
          <div key={v.uuid} className="whitespace-nowrap leading-5">
            <Link to={`/vms/${v.uuid}?tab=devices`} className="text-[13px] text-primary underline-offset-2 hover:underline">{v.name}</Link>
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <StatusGlyph status={v.running ? 'running' : 'stopped'} size={7} />
              {v.running ? 'Running' : 'Stopped'}
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (d.kept) {
    return (
      <div className="leading-5">
        <div className="text-[13px] text-foreground">Kept for VMs</div>
        <div className="font-mono text-[12px] text-muted-foreground">vfio-pci</div>
      </div>
    );
  }
  if (d.type === 'pci' && d.driver) {
    return (
      <div className="leading-5">
        <div className="text-[13px] text-muted-foreground">Host</div>
        <div className="font-mono text-[12px] text-muted-foreground">{d.driver}</div>
      </div>
    );
  }
  return <span className="text-[13px] leading-5 text-muted-foreground">{d.type === 'pci' ? 'Free' : 'Host'}</span>;
}

export function DevicesPage() {
  const { data: inv, isLoading, isError, error } = useDeviceInventory();
  const keep = useKeepDevice();
  const vfs = useVirtualFunctions();
  const [showHidden, setShowHidden] = useState(false);
  const [vfTarget, setVfTarget] = useState<PassthroughDevice | null>(null);
  const [vfCount, setVfCount] = useState('');
  const [report, setReport] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);

  const copyReport = async () => {
    setCopying(true);
    try {
      const text = await fetchPassthroughReport();
      try {
        await navigator.clipboard.writeText(text);
        toast.success('Report copied', { description: 'It holds no addresses or VM names, so it can go in a public issue.' });
      } catch {
        setReport(text);
      }
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't put the report together"));
    } finally {
      setCopying(false);
    }
  };

  const setKept = async (d: PassthroughDevice, value: boolean) => {
    try {
      await keep.mutateAsync({ id: d.id, keep: value });
      toast.success(value ? `${d.name} is kept for VMs` : `${d.name} is back with the host`, {
        description: value ? 'The host leaves it alone from now on, after restarts too.' : 'Its own driver has it again.',
      });
    } catch (err) {
      toast.error(apiErrorMessage(err, value ? "Couldn't keep it for VMs" : "Couldn't give it back to the host"), { duration: 10_000 });
    }
  };

  const vfNumber = /^\d{1,4}$/.test(vfCount.trim()) ? Number(vfCount.trim()) : NaN;
  const vfWaiting = !vfTarget?.sriov ? undefined
    : !vfCount.trim() ? 'Type a number.'
    : Number.isNaN(vfNumber) || vfNumber > vfTarget.sriov.total ? `Choose a number from 0 to ${vfTarget.sriov.total}.`
    : vfNumber === vfTarget.sriov.current ? 'That is how many it has now.'
    : undefined;

  const applyVfs = async () => {
    if (!vfTarget || vfWaiting) return;
    try {
      await vfs.mutateAsync({ id: vfTarget.id, count: vfNumber });
      toast.success(vfNumber === 0 ? `Virtual functions are off on ${vfTarget.name}` : `${vfTarget.name} has ${vfNumber} virtual function${vfNumber === 1 ? '' : 's'}`, {
        description: vfNumber === 0 ? undefined : 'Each one is listed below as a network card of its own, and comes back after a restart.',
      });
      setVfTarget(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't change the virtual functions"), { duration: 10_000 });
    }
  };

  const actionsFor = (d: PassthroughDevice): MenuItem[] => {
    if (!inv?.hostTools || d.type !== 'pci') return [];
    const items: MenuItem[] = [];
    const running = d.usedBy.find((v) => v.running);
    if (inv.host.pciReady) {
      items.push(d.kept
        ? {
          label: 'Give back to the host',
          hint: running ? `Not while ${running.name} runs with it` : 'Its own driver takes it again',
          disabled: !!running,
          onSelect: () => void setKept(d, false),
        }
        : {
          label: 'Keep for VMs',
          // libvirt hands a card back to the driver it found when the VM started, so not while one runs with it.
          hint: running ? `Not while ${running.name} runs with it` : 'The host stops using it, after restarts too',
          disabled: !!running,
          onSelect: () => void setKept(d, true),
        });
    }
    if (d.sriov) {
      items.push({
        label: 'Virtual functions…',
        // A disabled item says why in words, not only by being grey.
        hint: d.usedBy.length > 0 ? `Not while ${d.usedBy[0].name} has the card` : `${d.sriov.current} of up to ${d.sriov.total}`,
        disabled: d.usedBy.length > 0,
        onSelect: () => { setVfTarget(d); setVfCount(String(d.sriov!.current)); },
      });
    }
    return items;
  };

  const groups = groupByKind(inv?.devices ?? []);

  return (
    <Layout
      title="Devices"
      subtitle="Host hardware that can be passed straight through to a VM."
      actions={
        <Button variant="secondary" onClick={copyReport} disabled={copying || !inv}>
          <ClipboardCopy className="h-3.5 w-3.5" /> {copying ? 'Copying…' : 'Copy report'}
        </Button>
      }
    >
      <div className="space-y-6">
        {isLoading ? (
          <>
            <Skeleton className="h-48 rounded-lg" />
            <Skeleton className="h-72 rounded-lg" />
          </>
        ) : isError || !inv ? (
          <Panel className="px-5 py-10 text-center text-[13px] text-muted-foreground">
            Couldn't read this host's devices: {apiErrorMessage(error, 'the server did not answer')}. The list tries again on its own.
          </Panel>
        ) : (
          <>
            <HostChecksPanel host={inv.host} />

            <Panel className="overflow-hidden">
              <PanelHeader
                title="Devices you can pass through"
                meta={`${inv.devices.length} device${inv.devices.length === 1 ? '' : 's'}`}
              />
              {inv.devices.length === 0 ? (
                <div className="px-5 py-3.5 text-[13px] text-muted-foreground">This host has no devices it can give away.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px]">
                    <thead>
                      <tr className="table-head">
                        <th scope="col" className="px-5 py-2.5 text-left font-medium">Device</th>
                        <th scope="col" className="px-5 py-2.5 text-left font-medium">Address</th>
                        <th scope="col" className="px-5 py-2.5 text-left font-medium">Used by</th>
                        <th scope="col" className="w-12 px-3 py-2.5 text-right font-medium"><span className="sr-only">Actions</span></th>
                      </tr>
                    </thead>
                    {groups.map((g) => (
                      <tbody key={g.kind} className="divide-y divide-border border-t border-border first-of-type:border-t-0">
                        <tr>
                          <th colSpan={4} scope="rowgroup" className="bg-surface/60 px-5 py-2 text-left text-[12px] font-medium text-muted-foreground">
                            {g.label}
                          </th>
                        </tr>
                        {g.items.map((d) => {
                          const items = actionsFor(d);
                          return (
                            <tr key={d.id} className="table-row align-top">
                              <td className="px-5 py-3">
                                <DeviceSummary name={d.name} vendor={d.vendor} kindLabel={d.kindLabel} facts={d.facts} notes={d.notes} />
                              </td>
                              <td className="whitespace-nowrap px-5 py-3">
                                <div className="font-mono text-[12px] leading-5 text-foreground">{d.type === 'pci' ? shortAddress(d.address) : d.address}</div>
                                {d.iommuGroup !== undefined && <div className="text-[12px] leading-5 text-muted-foreground">Group {d.iommuGroup}</div>}
                              </td>
                              <td className="px-5 py-3"><UsedBy d={d} /></td>
                              <td className="px-3 py-1.5 text-right">
                                {items.length > 0 && (
                                  <Menu
                                    label={`Actions for ${d.name}`}
                                    tooltip="Actions"
                                    icon={<MoreHorizontal className="h-4 w-4" />}
                                    items={items}
                                    align="end"
                                  />
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    ))}
                  </table>
                </div>
              )}
              {inv.hidden.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border bg-surface/60 px-5 py-2.5">
                  <p className="text-[12.5px] text-muted-foreground">{hiddenSummary(inv.hidden)}</p>
                  <Button size="sm" variant="ghost" onClick={() => setShowHidden((v) => !v)} aria-expanded={showHidden} aria-controls="hidden-devices">
                    {showHidden ? 'Hide them' : 'Show them'}
                  </Button>
                </div>
              )}
            </Panel>

            {!inv.hostTools && (
              <p className="text-[12.5px] text-muted-foreground">
                Keeping a device for VMs and switching on virtual functions need the passthrough helper the installer adds. Run update.sh on the host to add it.
              </p>
            )}

            {showHidden && (
              <Panel className="overflow-hidden" id="hidden-devices">
                <PanelHeader title="Not offered" meta={`${inv.hidden.length} device${inv.hidden.length === 1 ? '' : 's'}`} />
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px]">
                    <thead>
                      <tr className="table-head">
                        <th scope="col" className="px-5 py-2.5 text-left font-medium">Device</th>
                        <th scope="col" className="px-5 py-2.5 text-left font-medium">Address</th>
                        <th scope="col" className="px-5 py-2.5 text-left font-medium">Why it isn't offered</th>
                      </tr>
                    </thead>
                    {HIDDEN_GROUPS.map((g) => {
                      const rows = collapseAlike(inv.hidden.filter((h) => h.category === g.category));
                      const total = rows.reduce((n, r) => n + r.count, 0);
                      if (!rows.length) return null;
                      return (
                        <tbody key={g.category} className="divide-y divide-border border-t border-border first-of-type:border-t-0">
                          <tr>
                            <th colSpan={3} scope="rowgroup" className="bg-surface/60 px-5 py-2 text-left text-[12px] font-medium text-muted-foreground">
                              {g.label} ({total})
                            </th>
                          </tr>
                          {rows.map(({ first: h, count }) => (
                            <Fragment key={h.id}>
                              <tr className="table-row align-top">
                                <td className="px-5 py-2.5">
                                  <div className="text-[13px] text-foreground">
                                    {h.name}
                                    {count > 1 && <span className="tabular-nums text-muted-foreground"> ({count})</span>}
                                  </div>
                                  <div className="text-[12px] text-muted-foreground">{h.vendor}</div>
                                </td>
                                <td className="whitespace-nowrap px-5 py-2.5 text-[12px] text-muted-foreground">
                                  <span className="font-mono">{h.type === 'pci' ? shortAddress(h.address) : h.address}</span>
                                  {count > 1 && <span> and {count - 1} more</span>}
                                </td>
                                <td className="px-5 py-2.5 text-[12.5px] text-muted-foreground">{h.reason}</td>
                              </tr>
                            </Fragment>
                          ))}
                        </tbody>
                      );
                    })}
                  </table>
                </div>
              </Panel>
            )}
          </>
        )}
      </div>

      <Dialog
        open={vfTarget !== null}
        onClose={() => setVfTarget(null)}
        title="Set virtual functions"
        description={vfTarget ? `Split ${vfTarget.name} into virtual functions: each one is a network card of its own that can go to a different VM.` : undefined}
        note={vfWaiting}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setVfTarget(null)}>Cancel</Button>
            <Button size="sm" onClick={applyVfs} disabled={!!vfWaiting || vfs.isPending}>{vfs.isPending ? 'Applying…' : 'Apply'}</Button>
          </>
        }
      >
        {vfTarget?.sriov && (
          <div className="space-y-3">
            <Input
              label={`Virtual functions (0 to ${vfTarget.sriov.total})`}
              inputMode="numeric"
              value={vfCount}
              onChange={(e) => setVfCount(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void applyVfs(); }}
            />
            <p className="text-[12.5px] leading-5 text-muted-foreground">
              0 switches them off. The card goes through 0 on the way to any new number, so the virtual functions it has now
              disappear for a moment, and none of them may be given to a VM while that happens. The number is kept after a restart.
            </p>
          </div>
        )}
      </Dialog>

      <Dialog
        open={report !== null}
        onClose={() => setReport(null)}
        size="lg"
        title="Passthrough report"
        description="The browser wouldn't copy it for you: select the text and copy it. It holds no addresses or VM names."
        footer={<Button variant="secondary" size="sm" onClick={() => setReport(null)}>Close</Button>}
      >
        <textarea
          readOnly
          value={report ?? ''}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Passthrough report"
          className="h-80 w-full resize-none rounded-md border border-input bg-field p-3 font-mono text-[12px] leading-5 text-foreground"
        />
      </Dialog>
    </Layout>
  );
}
