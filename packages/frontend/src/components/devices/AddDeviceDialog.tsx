import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { Skeleton } from '@/components/ui/Skeleton';
import { useAttachDevice, useDeviceInventory } from '@/hooks/useDevices';
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import type { PassthroughDevice, PassthroughHost } from '@/types';
import { DeviceSummary, groupByKind, shortAddress } from './DeviceBits';

/** BIOS firmware can't place memory windows this large (the guest stops at once); measured with a 32 GB GPU. */
const UEFI_ONLY_BAR = 1024 ** 3;

/** Why a device can't go to this VM right now, in words; undefined when it can. */
export function unavailableReason(d: PassthroughDevice, vmUuid: string, firmware: 'uefi' | 'bios', host: PassthroughHost | undefined): string | undefined {
  const other = d.usedBy.find((v) => v.uuid !== vmUuid);
  if (other) return `Given to ${other.name}${other.running ? ', which is running' : ''}. Detach it there first.`;
  if (d.type === 'pci' && host && !host.pciReady) return "PCI passthrough isn't available on this host yet.";
  if (d.type === 'pci' && firmware === 'bios' && (d.largestBar ?? 0) >= UEFI_ONLY_BAR) {
    return `Needs a VM that boots with UEFI firmware: its ${formatBytes(d.largestBar!)} memory window is more than BIOS firmware can place.`;
  }
  return undefined;
}

/** What happens when, for the device chosen, on a VM in this state: said in the footer, beside Attach. */
function whenItApplies(d: PassthroughDevice, running: boolean): string {
  if (!running) return 'The VM has it from its next start.';
  if (d.type === 'pci' && d.kind === 'gpu') return 'A graphics card joins at the next start.';
  if (d.members.length) return 'It joins at the next start, with its isolation group.';
  return 'Joins now if the guest can take it, or at the next start.';
}

export function AddDeviceDialog({
  open, onClose, vmUuid, vmName, running, firmware,
}: {
  open: boolean;
  onClose: () => void;
  vmUuid: string;
  vmName: string;
  running: boolean;
  firmware: 'uefi' | 'bios';
}) {
  const { data: inv, isLoading, isError, error } = useDeviceInventory({ enabled: open });
  const attach = useAttachDevice(vmUuid);
  const [choice, setChoice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setChoice(null);
  }, [open]);

  // This VM's own devices are on its tab already.
  const offered = useMemo(
    () => (inv?.devices ?? []).filter((d) => !d.usedBy.some((v) => v.uuid === vmUuid)),
    [inv, vmUuid],
  );
  const groups = groupByKind(offered);
  const selected = offered.find((d) => d.id === choice);
  const blocked = selected ? unavailableReason(selected, vmUuid, firmware, inv?.host) : undefined;

  const submit = async () => {
    if (!selected) return;
    try {
      const result = await attach.mutateAsync(selected.id);
      if (result.applied === 'now') {
        toast.success(running ? `${selected.name} is attached and ${vmName} has it now` : `${selected.name} is attached to ${vmName}`);
      } else {
        toast.success(`${selected.name} joins ${vmName} when it next starts`, { description: result.reason, duration: 8000 });
      }
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, `Couldn't attach ${selected.name}`), { duration: 10_000 });
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Attach device"
      description={`Give ${vmName} a host device directly: the VM sees the real hardware and the host stops using it.`}
      note={isError && !inv ? undefined : !selected ? 'Choose a device.' : blocked ?? whenItApplies(selected, running)}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={!selected || !!blocked || attach.isPending}>
            {attach.isPending ? 'Attaching…' : 'Attach'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {inv && !inv.host.pciReady && (
          <Callout tone="warn" lead="PCI passthrough isn't available on this host yet.">
            {inv.host.blocker} USB devices still work. <Link to="/devices" className="font-medium underline underline-offset-2">See what to change</Link>
          </Callout>
        )}

        {isError && !inv ? (
          <p className="py-6 text-center text-[13px] text-muted-foreground">
            Couldn't read this host's devices: {apiErrorMessage(error, 'the server did not answer')}. Close this and try again.
          </p>
        ) : isLoading || !inv ? (
          <div className="space-y-2">
            <Skeleton className="h-16 rounded-md" />
            <Skeleton className="h-16 rounded-md" />
          </div>
        ) : offered.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-muted-foreground">This host has nothing left it can give away.</p>
        ) : (
          // One ruled list with a heading row per kind, like the host's Devices page.
          <div role="radiogroup" aria-label="Device" className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {groups.map((g) => (
              <section key={g.kind} aria-label={g.label} className="divide-y divide-border">
                <h3 className="bg-surface/60 px-3.5 py-2 text-[12px] font-medium text-muted-foreground">{g.label}</h3>
                <div className="divide-y divide-border">
                  {g.items.map((d) => {
                    const reason = unavailableReason(d, vmUuid, firmware, inv.host);
                    const checked = choice === d.id;
                    return (
                      <label
                        key={d.id}
                        className={cn(
                          'flex gap-3 px-3.5 py-3 transition-colors',
                          reason ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-muted/50',
                          checked && 'bg-accent hover:bg-accent',
                        )}
                      >
                        <input
                          type="radio"
                          name="passthrough-device"
                          value={d.id}
                          checked={checked}
                          disabled={!!reason}
                          onChange={() => setChoice(d.id)}
                          className="mt-[3px] h-4 w-4 shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <DeviceSummary
                            name={d.name}
                            vendor={d.vendor}
                            kindLabel={d.kindLabel}
                            facts={d.facts}
                            notes={reason ? [] : d.notes}
                            muted={!!reason}
                            extra={reason ? <p className="text-[12px] leading-5 text-muted-foreground">{reason}</p> : undefined}
                          />
                        </div>
                        <span className="shrink-0 font-mono text-[12px] leading-5 text-muted-foreground">{d.type === 'pci' ? shortAddress(d.address) : d.address}</span>
                      </label>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}

        <p className="text-[12.5px] text-muted-foreground">
          Only devices this host can give away are listed.{' '}
          <Link to="/devices" className="text-primary underline-offset-2 hover:underline">See every device and why</Link>
        </p>
      </div>
    </Dialog>
  );
}
