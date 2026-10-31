import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2, Waypoints } from 'lucide-react';
import { toast } from 'sonner';
import { StatusGlyph, statusLabels, WarnGlyph } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { RowAction } from '@/components/ui/RowAction';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { NicConfigHelp } from '@/components/networks/NicConfigHelp';
import { parseRemoteHosts, RemoteHostsField } from '@/components/networks/RemoteHostsField';
import { useConnectVm, useNetwork, useSetVxlanPeers, useVxlanStatus } from '@/hooks/useNetworks';
import { useVms } from '@/hooks/useVms';
import { formatBytes } from '@/lib/format';
import type { Network, VxlanStatus } from '@/types';

const COLUMNS = ['Name', 'ID', 'Connected VMs', 'Addresses', 'Remote hosts', ''];
/** A VXLAN can hold a lot of VMs: the row stays a row until asked. */
const VMS_SHOWN = 5;

function errorMessage(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

function StaticPool({ networkId }: { networkId: string }) {
  const { data } = useNetwork(networkId);
  if (!data?.ips?.length) return <>Static, from a pool</>;
  const free = data.ips.filter((i) => !i.allocated).length;
  return <span className="tabular-nums">Static, {free} of {data.ips.length} free</span>;
}

function Addresses({ network }: { network: Network }) {
  if (network.ipMode === 'none') {
    return <span className="text-[12.5px] text-muted-foreground">Set by the VMs</span>;
  }
  return (
    <>
      <div className="whitespace-nowrap font-mono text-[12.5px] text-foreground">{network.cidr}</div>
      <div className="mt-0.5 whitespace-nowrap text-[12px] text-muted-foreground">
        {network.ipMode === 'dhcp'
          ? <>DHCP from <span className="font-mono">{network.gateway}</span></>
          : <StaticPool networkId={network.id} />}
      </div>
    </>
  );
}

function ConnectedVms({ network, status, onConnect }: { network: Network; status?: VxlanStatus; onConnect: () => void }) {
  const [showAll, setShowAll] = useState(false);
  // The row shows a skeleton while this first loads, so no status here means the request failed.
  if (!status) return <span className="text-[12.5px] text-muted-foreground">Unknown</span>;
  const vms = [...status.vms].sort((a, b) => a.name.localeCompare(b.name));
  const shown = showAll ? vms : vms.slice(0, VMS_SHOWN);
  const hidden = vms.length - VMS_SHOWN;
  return (
    <div className="space-y-1">
      {vms.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">None yet</p>
      ) : (
        // One grid across the rows, so the addresses share a left edge whatever the names.
        <ul className="grid w-fit grid-cols-[auto_auto] gap-x-2.5 gap-y-1">
          {shown.map((vm) => (
            <li key={vm.mac} className="col-span-2 grid grid-cols-subgrid items-center whitespace-nowrap">
              <span className="flex items-center gap-2">
                <StatusGlyph status={vm.status} size={7} />
                <span className="sr-only">{statusLabels[vm.status]}:</span>
                <Link to={`/vms/${vm.id}?tab=network`} className="text-[13px] text-primary underline-offset-2 hover:underline">{vm.name}</Link>
              </span>
              <span className="font-mono text-[12px] text-muted-foreground">{vm.ip}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-baseline gap-x-3">
        {hidden > 0 && (
          <button
            type="button"
            aria-expanded={showAll}
            onClick={() => setShowAll((v) => !v)}
            className="text-[12px] tabular-nums text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {showAll ? 'Show fewer' : `and ${hidden} more`}
          </button>
        )}
        <button
          type="button"
          onClick={onConnect}
          aria-label={`Connect a VM to ${network.name}`}
          className="text-[12.5px] font-medium text-primary underline-offset-2 hover:underline"
        >
          Connect a VM
        </button>
      </div>
    </div>
  );
}

function RemoteHosts({ status, network }: { status?: VxlanStatus; network: Network }) {
  const peers = network.peers ?? [];
  if (peers.length === 0) return <span className="whitespace-nowrap text-[12.5px] text-muted-foreground">This host only</span>;
  return (
    <ul className="space-y-1">
      {peers.map((address) => {
        const machines = status?.peers.find((p) => p.address === address)?.machines ?? 0;
        return (
          <li key={address} className="flex flex-wrap items-baseline gap-x-2 whitespace-nowrap">
            <span className="font-mono text-[12.5px] text-foreground">{address}</span>
            <span className="text-[12px] tabular-nums text-muted-foreground">
              {machines > 0 ? `${machines} ${machines === 1 ? 'machine' : 'machines'} seen` : 'Nothing received yet'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function RemoteHostsDialog({ network, status, onClose }: { network: Network; status?: VxlanStatus; onClose: () => void }) {
  const [text, setText] = useState((network.peers ?? []).join('\n'));
  const setPeers = useSetVxlanPeers();

  const listed = parseRemoteHosts(text);
  const dirty = listed.join(' ') !== (network.peers ?? []).join(' ');

  const save = async () => {
    try {
      await setPeers.mutateAsync({ id: network.id, peers: listed });
      toast.success(listed.length ? 'Remote hosts saved' : 'This VXLAN now stays on this host');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, 'Failed to save remote hosts'));
    }
  };

  const farEnd: Array<[string, string]> = [
    ['VXLAN ID', String(network.vni)],
    ['UDP port', String(network.vxlanPort)],
    ['MTU', String(network.mtu)],
    ["This host's address", status?.localAddress ?? '…'],
  ];

  return (
    <Dialog
      open
      onClose={onClose}
      title="Remote hosts"
      description={`${network.name} · VXLAN ID ${network.vni}`}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={setPeers.isPending}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={!dirty || setPeers.isPending}>
            {setPeers.isPending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <RemoteHostsField
          value={text}
          onChange={setText}
          rows={4}
          help="One IPv4 address per line. Leave it empty to keep this VXLAN on this host."
        />
        <div>
          <p className="text-[13px] font-semibold text-foreground">Set these on each of those hosts</p>
          <dl className="mt-1 divide-y divide-border">
            {farEnd.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-4 py-1.5">
                <dt className="text-[12.5px] text-muted-foreground">{label}</dt>
                <dd className="font-mono text-[12px] text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-1 text-[12px] leading-[1.45] text-muted-foreground">
            Only the hosts listed here can reach this VXLAN. Any firewall between the hosts has to pass UDP {network.vxlanPort}.
          </p>
        </div>
        {listed.length > 0 && (
          <Callout tone="warn">
            Traffic between hosts is not encrypted: use a private link or a VPN between them.
            {network.ipMode === 'dhcp' && ' Only one host on a VXLAN should hand out addresses: on the others, choose None.'}
          </Callout>
        )}
        {status?.tunnel === 'up' && (
          <p className="text-[12.5px] tabular-nums text-muted-foreground">
            Sent {formatBytes(status.txBytes)} and received {formatBytes(status.rxBytes)} over the tunnel so far.
          </p>
        )}
      </div>
    </Dialog>
  );
}

function ConnectVmDialog({ network, status, onClose }: { network: Network; status?: VxlanStatus; onClose: () => void }) {
  const { data: vms } = useVms();
  const connect = useConnectVm();
  const needsIp = network.ipMode === 'static';
  const { data: detail } = useNetwork(needsIp ? network.id : '');
  const [vmId, setVmId] = useState('');
  const [ip, setIp] = useState('');
  const [added, setAdded] = useState<{ mac: string; staticIp?: string } | null>(null);

  const connected = new Set((status?.vms ?? []).map((vm) => vm.id));
  const candidates = (vms ?? []).filter((vm) => !connected.has(vm.id));
  const freeIps = (detail?.ips ?? []).filter((i) => !i.allocated);
  const poolFull = needsIp && !!detail && freeIps.length === 0;
  const cannot = candidates.length === 0 || poolFull;

  const submit = async () => {
    if (!vmId) return;
    try {
      const { mac } = await connect.mutateAsync({ vmId, networkId: network.id, staticIp: needsIp ? ip : undefined });
      setAdded({ mac, staticIp: needsIp ? ip : undefined });
    } catch (err) {
      toast.error(errorMessage(err, 'Failed to connect the VM'));
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={added ? 'VM connected' : 'Connect a VM'}
      description={!added ? `${network.name} · VXLAN ID ${network.vni}` : undefined}
      note={!added && !cannot && !connect.isPending ? (!vmId ? 'Choose a VM.' : needsIp && !ip ? 'Choose an address.' : undefined) : undefined}
      footer={
        added ? (
          <Button size="sm" onClick={onClose}>Done</Button>
        ) : cannot ? (
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={submit} disabled={!vmId || (needsIp && !ip) || connect.isPending}>
              {connect.isPending ? 'Connecting…' : 'Connect VM'}
            </Button>
          </>
        )
      }
    >
      {added ? (
        <NicConfigHelp mac={added.mac} network={network} staticIp={added.staticIp} />
      ) : candidates.length === 0 ? (
        <p className="text-[13.5px] text-muted-foreground">
          {(vms ?? []).length === 0 ? 'There are no VMs on this host yet.' : 'Every VM on this host is already connected.'}
        </p>
      ) : poolFull ? (
        <p className="text-[13.5px] text-muted-foreground">No available IPs - all addresses are allocated.</p>
      ) : (
        <div className="space-y-4">
          <Select label="VM" id="connect-vm" value={vmId} onChange={(e) => setVmId(e.target.value)}>
            <option value="">Select a VM…</option>
            {candidates.map((vm) => <option key={vm.id} value={vm.id}>{vm.name}</option>)}
          </Select>
          {needsIp && (
            <Select label="IP address" id="connect-ip" value={ip} onChange={(e) => setIp(e.target.value)} className="font-mono">
              <option value="">Select an IP…</option>
              {freeIps.map((i) => <option key={i.ip} value={i.ip}>{i.ip}</option>)}
            </Select>
          )}
          <Callout tone="warn">
            This adds a NIC to the VM, at once if it is running. Cloud-init will not configure it: the steps are shown after connecting.
          </Callout>
        </div>
      )}
    </Dialog>
  );
}

export function VxlanPanel({
  networks, onNew, onDelete,
}: {
  networks: Network[];
  onNew: () => void;
  /** With the names of the VMs still on it: the delete dialog says who is in the way. */
  onDelete: (n: Network, connected: string[]) => void;
}) {
  const { data: statuses, isLoading } = useVxlanStatus(networks.length > 0);
  const [hostsFor, setHostsFor] = useState<Network | null>(null);
  const [connectTo, setConnectTo] = useState<Network | null>(null);

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="VXLANs"
        meta={<span className="hidden sm:inline">Private networks between VMs</span>}
        actions={
          <Button variant="secondary" size="sm" onClick={onNew}>
            <Plus size={14} /> New VXLAN
          </Button>
        }
      />
      {networks.length === 0 ? (
        <p className="px-5 py-3.5 text-[13px] text-muted-foreground">
          No VXLANs yet. A VXLAN connects VMs to each other, on this host or across several.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="table-head">
                {COLUMNS.map((h, i) => (
                  <th
                    key={h || 'actions'}
                    className={`whitespace-nowrap py-2.5 text-left text-[12px] font-medium text-muted-foreground ${i === 0 ? 'pl-5 pr-3' : i === COLUMNS.length - 1 ? 'pl-3 pr-5' : 'px-3'}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {networks.map((n) => {
                const status = statuses?.[n.id];
                const problems = status
                  ? [
                      ...status.problems,
                      ...(!status.bridgeUp && status.problems.length === 0 ? ['Its libvirt network is not running. VirtPilot is trying to start it again.'] : []),
                      ...(status.tunnel === 'down' && status.problems.length === 0 ? ['The tunnel to the remote hosts is down. VirtPilot is trying to bring it up again.'] : []),
                    ]
                  : [];
                return (
                  <tr key={n.id} className="table-row align-top">
                    <td className="py-3 pl-5 pr-3">
                      <div className="text-[13.5px] font-semibold text-foreground">{n.name}</div>
                      <div className="mt-0.5 whitespace-nowrap font-mono text-[12px] text-muted-foreground">{n.bridge}</div>
                      {problems.map((p) => (
                        <p key={p} className="mt-1.5 flex max-w-[34ch] items-start gap-1.5 text-[12px] leading-[1.45] text-amber-800 dark:text-amber-200">
                          <WarnGlyph className="mt-[3px] shrink-0" />{p}
                        </p>
                      ))}
                    </td>
                    <td className="px-3 py-3 font-mono text-[12.5px] text-foreground">{n.vni}</td>
                    <td className="px-3 py-3">
                      {isLoading
                        ? <Skeleton className="h-4 w-24" />
                        : <ConnectedVms network={n} status={status} onConnect={() => setConnectTo(n)} />}
                    </td>
                    <td className="px-3 py-3"><Addresses network={n} /></td>
                    <td className="px-3 py-3"><RemoteHosts network={n} status={status} /></td>
                    <td className="whitespace-nowrap py-1.5 pl-3 pr-5 text-right">
                      <div className="inline-flex items-center justify-end gap-0.5">
                        <RowAction label={`Remote hosts of ${n.name}`} tooltip="Remote hosts" onClick={() => setHostsFor(n)}>
                          <Waypoints size={14} />
                        </RowAction>
                        <RowAction
                          label={`Delete network ${n.name}`}
                          tooltip="Delete network"
                          danger
                          onClick={() => onDelete(n, [...new Set((status?.vms ?? []).map((vm) => vm.name))])}
                        >
                          <Trash2 size={14} />
                        </RowAction>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-surface/60">
                <td colSpan={COLUMNS.length} className="px-5 py-2.5 text-[12px] tabular-nums text-muted-foreground">
                  {networks.length} {networks.length === 1 ? 'VXLAN' : 'VXLANs'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Mounted only while open: the VM picker polls the VM list. */}
      {hostsFor && <RemoteHostsDialog network={hostsFor} status={statuses?.[hostsFor.id]} onClose={() => setHostsFor(null)} />}
      {connectTo && <ConnectVmDialog network={connectTo} status={statuses?.[connectTo.id]} onClose={() => setConnectTo(null)} />}
    </Panel>
  );
}
