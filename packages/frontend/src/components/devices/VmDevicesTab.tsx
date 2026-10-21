import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Undo2, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { RowAction } from '@/components/ui/RowAction';
import { Skeleton } from '@/components/ui/Skeleton';
import { useDetachDevice, useDeviceInventory, useKeepAttached, useVmDevices } from '@/hooks/useDevices';
import { apiErrorMessage } from '@/lib/api';
import type { VmDevice } from '@/types';
import { AddDeviceDialog } from './AddDeviceDialog';
import { DeviceSummary, shortAddress } from './DeviceBits';

// A row says nothing about its state when all is settled; a change waiting for the
// next start or stop, or a device that has left the host, is a note under its name.
export function VmDevicesTab({ vmUuid, vmName }: { vmUuid: string; vmName: string }) {
  const { data: view, isLoading, isError, error, refetch } = useVmDevices(vmUuid);
  const { data: inv } = useDeviceInventory();
  const detach = useDetachDevice(vmUuid);
  const keep = useKeepAttached(vmUuid);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<VmDevice | null>(null);
  const running = view?.running ?? false;

  const doDetach = async (d: VmDevice) => {
    try {
      const result = await detach.mutateAsync(d.key);
      if (result.applied === 'now') toast.success(`${d.name} is detached from ${vmName}`);
      else toast.success(`${d.name} leaves ${vmName} when it next stops`, { description: result.reason, duration: 8000 });
      setConfirm(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, `Couldn't detach ${d.name}`), { duration: 10_000 });
    }
  };

  const onDetach = (d: VmDevice) => {
    // Taking a device out of a running guest is worth a second look; changing what it boots with is not.
    if (d.liveDetach) setConfirm(d);
    else void doDetach(d);
  };

  const onKeep = async (d: VmDevice) => {
    try {
      await keep.mutateAsync(d.key);
      toast.success(`${d.name} stays with ${vmName}`);
    } catch (err) {
      toast.error(apiErrorMessage(err, `Couldn't keep ${d.name}`), { duration: 10_000 });
    }
  };

  return (
    <div className="space-y-6">
      {inv && !inv.host.pciReady && (
        <Callout tone="warn" lead="PCI passthrough isn't available on this host yet.">
          {inv.host.blocker} USB devices still work. <Link to="/devices" className="font-medium underline underline-offset-2">See what to change</Link>
        </Callout>
      )}

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Passed-through devices"
          actions={
            <Button size="sm" variant="secondary" onClick={() => setAdding(true)} disabled={!view}>
              <Plus className="h-3.5 w-3.5" /> Attach device
            </Button>
          }
        />
        {isError && !view ? (
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 text-[13px] text-muted-foreground">
            <span>Couldn't read this VM's devices: {apiErrorMessage(error, 'the server did not answer')}.</span>
            <Button size="sm" variant="secondary" onClick={() => void refetch()}>Try again</Button>
          </div>
        ) : isLoading || !view ? (
          <div className="p-3"><Skeleton className="h-14 rounded-lg" /></div>
        ) : view.devices.length === 0 ? (
          <div className="px-5 py-3.5 text-[13px] text-muted-foreground">
            No host devices passed through. A GPU, network card, disk controller or USB device can be given to this VM directly.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="table-head">
                  <th scope="col" className="px-5 py-2.5 text-left font-medium">Device</th>
                  <th scope="col" className="hidden px-5 py-2.5 text-left font-medium sm:table-cell">Address</th>
                  <th scope="col" className="px-5 py-2.5 text-right font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {view.devices.map((d) => (
                  <tr key={d.key} className="table-row align-top">
                    <td className="px-5 py-3">
                      <DeviceSummary
                        name={d.name}
                        vendor={d.vendor}
                        kindLabel={d.kindLabel}
                        members={d.members}
                        notes={d.notes}
                        // Phones have no Address column: the address reads under the name instead.
                        extra={<div className="font-mono text-[12px] leading-5 text-muted-foreground sm:hidden">{d.type === 'pci' ? shortAddress(d.address) : d.address}</div>}
                      />
                    </td>
                    <td className="hidden whitespace-nowrap px-5 py-3 font-mono text-[12px] leading-5 text-muted-foreground sm:table-cell">
                      {d.type === 'pci' ? shortAddress(d.address) : d.address}
                    </td>
                    <td className="whitespace-nowrap px-5 py-1.5 text-right">
                      {d.state === 'pending-detach' ? (
                        <RowAction label={`Keep ${d.name}`} tooltip="Keep it: undo the detach" onClick={() => void onKeep(d)} disabled={keep.isPending}>
                          <Undo2 size={14} />
                        </RowAction>
                      ) : (
                        <RowAction
                          label={`Detach ${d.name}`}
                          tooltip={running && !d.liveDetach && d.state === 'attached' ? 'Detach: it leaves when the VM next stops' : 'Detach'}
                          danger
                          onClick={() => onDetach(d)}
                          disabled={detach.isPending}
                        >
                          <Unplug size={14} />
                        </RowAction>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="text-[12.5px]">
        <Link to="/devices" className="text-primary underline-offset-2 hover:underline">All host devices</Link>
      </p>

      {view && (
        <AddDeviceDialog
          open={adding}
          onClose={() => setAdding(false)}
          vmUuid={vmUuid}
          vmName={vmName}
          running={view.running}
          firmware={view.firmware}
        />
      )}

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title="Detach device"
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={() => confirm && doDetach(confirm)} disabled={detach.isPending}>
              {detach.isPending ? 'Detaching…' : 'Detach'}
            </Button>
          </>
        }
      >
        <p className="text-[13.5px] leading-6 text-muted-foreground">
          <span className="font-medium text-foreground">{confirm?.name}</span> leaves {vmName} now. The running guest loses it
          at once, as if it had been unplugged, and the host gets it back.
        </p>
      </Dialog>
    </div>
  );
}
