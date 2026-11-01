import { useState } from 'react';
import { BookOpen, Network, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { RowAction } from '@/components/ui/RowAction';
import { Skeleton } from '@/components/ui/Skeleton';
import { useBridgeStatus, useConnectedVms, useNetworks, useCreateNetwork, useDeleteNetwork, useNetwork, useSystemNics, useVxlanIds } from '@/hooks/useNetworks';
import { cn } from '@/lib/cn';
import { networkTypeLabel } from '@/lib/format';
import { WarnGlyph } from '@/components/ui/Badge';
import { Callout } from '@/components/ui/Callout';
import { parseRemoteHosts, RemoteHostsField } from '@/components/networks/RemoteHostsField';
import { VxlanPanel } from '@/components/networks/VxlanPanel';
import { NetworkGuide } from './NetworkGuide';
import type { BridgeStatus, Network as NetworkType, NetworkIpMode } from '@/types';

function IpPoolDetail({ networkId }: { networkId: string }) {
  const { data } = useNetwork(networkId);
  if (!data?.ips?.length) return null;
  const free = data.ips.filter((i) => !i.allocated).length;
  return <span className="tabular-nums">{free} of {data.ips.length} free</span>;
}

// A VM on a network VirtPilot would destroy has to come off it first. An OS bridge stays when
// its record goes, as does the bridge of an old record that was never VirtPilot's.
function isManagedBridge(network: NetworkType): boolean {
  return network.type === 'bridge' && /^vp\d+$/.test(network.bridge);
}

function deleteWaitsForVms(network: NetworkType): boolean {
  return network.type === 'nat' || network.type === 'vxlan' || isManagedBridge(network);
}

function bridgeDeleteText(network: NetworkType, status?: BridgeStatus): string {
  if (!isManagedBridge(network)) return `This will remove the network record. The bridge "${network.bridge}" will not be touched.`;
  if (!network.physicalNic) return 'This will destroy the bridge.';
  if (status && !status.uplink?.attached) return `This will destroy the bridge. ${network.physicalNic} is not on it, and is left as it is.`;
  return `This will take ${network.physicalNic} off the bridge, leave it down unless something else is on it, and destroy the bridge.`;
}

function NetworkRow({ network, status, onDelete }: { network: NetworkType; status?: BridgeStatus; onDelete: () => void }) {
  const problems = status
    ? [
        ...status.problems,
        ...(!status.bridgeUp && status.problems.length === 0 ? ['Its bridge is not running. VirtPilot is trying to start it again.'] : []),
      ]
    : [];
  return (
    <>
      <tr className="table-row align-top">
        {/* A name of any length wraps rather than widen the table, but never to a letter per line. */}
        <td className="py-3 pl-5 pr-3 text-[13.5px] font-semibold text-foreground">
          <div className="min-w-[5.5rem] [overflow-wrap:anywhere]">{network.name}</div>
        </td>
        <td className="px-3 py-3">
          <div className="whitespace-nowrap text-[12.5px] text-foreground">{networkTypeLabel(network.type, network.ipMode)}</div>
        </td>
        <td className="px-3 py-3">
          <div className="whitespace-nowrap font-mono text-[12.5px] text-foreground">{network.cidr}</div>
          <div className="mt-0.5 whitespace-nowrap text-[12px] text-muted-foreground">
            Gateway <span className="font-mono">{network.gateway}</span>
          </div>
          {network.type !== 'nat' && network.ipMode === 'static' && (
            <div className="mt-0.5 whitespace-nowrap text-[12px] text-muted-foreground"><IpPoolDetail networkId={network.id} /></div>
          )}
        </td>
        <td className="px-3 py-3 font-mono text-[12px] text-muted-foreground">
          <div className="whitespace-nowrap">
            {network.bridge}
            {network.physicalNic && (
              <span className="ml-1.5">← {network.physicalNic}</span>
            )}
            {network.type === 'existing-bridge' && (
              <span className="ml-1.5">(OS)</span>
            )}
          </div>
          {status?.uplink?.attached && status.uplink.carrier === false && (
            <div className="mt-0.5 font-sans">{status.uplink.nic} has no link</div>
          )}
        </td>
        <td className="py-1.5 pl-3 pr-5 text-right">
          <RowAction label={`Delete network ${network.name}`} tooltip="Delete network" danger onClick={onDelete}>
            <Trash2 size={14} />
          </RowAction>
        </td>
      </tr>
      {/* A row of its own: in the name's cell, a table that has run out of width squeezes it to a word per line. */}
      {problems.length > 0 && (
        <tr className="!border-t-0">
          <td colSpan={5} className="px-5 pb-3">
            {problems.map((p) => (
              <p key={p} className="flex max-w-[min(80ch,calc(100vw-5rem))] items-start gap-1.5 text-[12px] leading-[1.45] text-amber-800 dark:text-amber-200">
                <WarnGlyph className="mt-[3px] shrink-0" />{p}
              </p>
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

function ipToNum(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function cidrRange(cidr: string): { start: number; end: number } | null {
  const m = cidr.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
  if (!m) return null;
  const prefix = parseInt(m[2], 10);
  if (prefix < 0 || prefix > 32) return null;
  const mask = (prefix === 0 ? 0 : ~((1 << (32 - prefix)) - 1)) >>> 0;
  const networkNum = (ipToNum(m[1]) & mask) >>> 0;
  const broadcast = (networkNum | (~mask >>> 0)) >>> 0;
  return { start: networkNum, end: broadcast };
}

function cidrsOverlap(a: string, b: string): boolean {
  const ra = cidrRange(a);
  const rb = cidrRange(b);
  if (!ra || !rb) return false;
  return ra.start <= rb.end && rb.start <= ra.end;
}

// The first usable address of a CIDR, or null while what is typed isn't one yet.
function firstUsable(cidr: string): string | null {
  const r = cidrRange(cidr);
  if (!r || r.end - r.start < 2) return null;
  const n = r.start + 1;
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

function suggestNextLocalCidr(networks: NetworkType[]): string {
  for (let octet = 1; octet <= 254; octet++) {
    const candidate = `10.0.${octet}.0/24`;
    if (!networks.some((n) => cidrsOverlap(candidate, n.cidr))) return candidate;
  }
  return '10.0.1.0/24';
}

interface CreateForm {
  name: string;
  type: 'nat' | 'bridge' | 'existing-bridge' | 'vxlan';
  ipMode: NetworkIpMode;
  cidr: string;
  gateway: string;
  dns: string;
  physicalNic: string;
  existingBridge: string;
  vniMode: 'next' | 'choose';
  vni: string;
  peers: string;
  mtu: string;
  port: string;
}

const defaultForm: CreateForm = {
  name: '',
  type: 'nat',
  ipMode: 'static',
  cidr: '10.0.1.0/24',
  gateway: '',
  dns: '8.8.8.8, 8.8.4.4',
  physicalNic: '',
  existingBridge: '',
  vniMode: 'next',
  vni: '',
  peers: '',
  mtu: '',
  port: '',
};

const VNI_MAX = 16777215;
const NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

const VXLAN_TAGGING = ' They can tag their own VLANs on it, including nested QinQ.';

const TYPE_DESCRIPTIONS: Record<string, string> = {
  nat: 'A libvirt NAT network is created automatically. VMs get DHCP IPs and are reachable from this host. Ideal for isolated dev/test networks.',
  'bridge-dhcp': 'VirtPilot creates a new Linux bridge and optionally enslaves a dedicated NIC (one with no active IPs). Both come back by themselves after a reboot. VMs are bridged onto your upstream network and receive IPs from its DHCP server.',
  'bridge-static': 'VirtPilot creates a new Linux bridge and optionally enslaves a dedicated NIC (one with no active IPs). Both come back by themselves after a reboot. VirtPilot assigns static IPs from the pool you define via cloud-init.',
  'existing-bridge-dhcp': 'Attach to a bridge already configured at the OS level (netplan / /etc/network/interfaces). VirtPilot will never modify this bridge. VMs receive IPs from the upstream DHCP server.',
  'existing-bridge-static': 'Attach to a bridge already configured at the OS level (netplan / /etc/network/interfaces). VirtPilot will never modify this bridge. VirtPilot assigns static IPs from the pool you define via cloud-init.',
  'vxlan-dhcp': `VMs on it reach each other and this host, and nothing else. A VM that needs the internet keeps its NAT or bridge NIC.${VXLAN_TAGGING}`,
  'vxlan-static': `VMs on it reach each other and nothing else. VirtPilot gives each VM an address from the pool through cloud-init.${VXLAN_TAGGING}`,
  'vxlan-none': `VMs on it reach each other and nothing else. Set addresses inside the VMs, or run a DHCP server on the network.${VXLAN_TAGGING}`,
};

export function NetworksPage() {
  const { data: networks, isLoading } = useNetworks();
  const { data: systemNics } = useSystemNics();
  const createNetwork = useCreateNetwork();
  const deleteNetwork = useDeleteNetwork();

  const [createOpen, setCreateOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<NetworkType | null>(null);
  const [optionalOpen, setOptionalOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(defaultForm);

  const openCreate = (type: CreateForm['type'] = 'nat') => {
    const suggested = suggestNextLocalCidr(networks ?? []);
    setForm({ ...defaultForm, cidr: suggested, type, ipMode: type === 'vxlan' ? 'dhcp' : defaultForm.ipMode });
    setOptionalOpen(false);
    setCreateOpen(true);
  };

  const vxlans = networks?.filter((n) => n.type === 'vxlan') ?? [];
  const others = networks?.filter((n) => n.type !== 'vxlan') ?? [];
  const { data: bridgeStatus } = useBridgeStatus(others.some((n) => n.type === 'bridge'));
  const natCount = networks?.filter((n) => n.type === 'nat').length ?? 0;
  const bridgeCount = networks?.filter((n) => n.type === 'bridge' || n.type === 'existing-bridge').length ?? 0;

  const isVxlan = form.type === 'vxlan';
  const hasAddresses = !(isVxlan && form.ipMode === 'none');

  const { data: vxlanIds } = useVxlanIds(createOpen && isVxlan);
  const vniNumber = Number(form.vni);
  const vniInRange = /^\d+$/.test(form.vni.trim()) && vniNumber >= 1 && vniNumber <= VNI_MAX;
  const vniClash = form.vniMode === 'choose' && vniInRange ? vxlanIds?.used.find((u) => u.vni === vniNumber) : undefined;
  const vniProblem = !isVxlan || form.vniMode !== 'choose' || !form.vni.trim()
    ? undefined
    : !vniInRange
      ? `A VXLAN ID is a whole number from 1 to ${VNI_MAX}.`
      : vniClash
        ? `VXLAN ID ${vniNumber} already exists: it is used by ${vniClash.usedBy}.`
        : undefined;
  const nameProblem = isVxlan && form.name && !NETWORK_NAME.test(form.name)
    ? 'Use only letters, numbers, dots, hyphens and underscores, starting with a letter or number.'
    : undefined;
  const peersListed = isVxlan ? parseRemoteHosts(form.peers) : [];
  // Said here rather than left to the server: Number() of a typo would quietly become the default.
  const mtuProblem = isVxlan && form.mtu.trim() && !(/^\d+$/.test(form.mtu.trim()) && Number(form.mtu) >= 576 && Number(form.mtu) <= 9000)
    ? 'The MTU is a whole number from 576 to 9000.'
    : undefined;
  const portProblem = isVxlan && form.port.trim() && !(/^\d+$/.test(form.port.trim()) && Number(form.port) >= 1 && Number(form.port) <= 65535)
    ? 'The UDP port is a whole number from 1 to 65535.'
    : undefined;

  const cidrConflict = form.cidr && hasAddresses
    ? (networks ?? []).find((n) => cidrsOverlap(form.cidr, n.cidr))
    : undefined;

  const set = (key: keyof CreateForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  // Delete can only fail until these are gone. Read live, so a VM removed meanwhile frees the
  // button and one added blocks it. If it can't be read, the delete itself says.
  const { vms: connected, checking: connectedLoading } = useConnectedVms(deleteTarget && deleteWaitsForVms(deleteTarget) ? deleteTarget.id : null);
  const namesOf = (status: 'adding' | 'connected') => (connected ?? [])
    .filter((vm) => (vm.status === 'adding') === (status === 'adding'))
    .map((vm) => vm.name)
    .sort((a, b) => a.localeCompare(b));
  const listed = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]);
  const blockers = namesOf('connected');
  const adding = namesOf('adding');
  const blockedSaying = [
    blockers.length > 0 ? `${listed(blockers)} ${blockers.length === 1 ? 'is' : 'are'} still connected. Remove ${blockers.length === 1 ? 'its NIC on its' : 'their NICs on each VM\'s'} Network tab first.` : '',
    adding.length > 0 ? `${listed(adding)} ${adding.length === 1 ? 'is' : 'are'} being added to this network. Wait for that to finish.` : '',
  ].filter(Boolean).join(' ');

  // Each kind has its own default way of giving out addresses, and a VXLAN's "none"
  // means nothing on a bridge.
  const setType = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const type = e.target.value as CreateForm['type'];
    setForm((f) => ({ ...f, type, ipMode: type === 'vxlan' ? 'dhcp' : f.ipMode === 'none' || f.type === 'vxlan' ? 'static' : f.ipMode }));
  };

  const descKey = form.type === 'nat'
    ? 'nat'
    : form.type === 'existing-bridge'
      ? `existing-bridge-${form.ipMode}`
      : isVxlan
        ? `vxlan-${form.ipMode}`
        : `bridge-${form.ipMode}`;

  const handleCreate = async () => {
    try {
      const dns = form.dns.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
      await createNetwork.mutateAsync({
        name: form.name,
        type: form.type,
        cidr: hasAddresses ? form.cidr : undefined,
        gateway: hasAddresses ? form.gateway || undefined : undefined,
        dns: dns.length && !isVxlan ? dns : undefined,
        ...(isVxlan ? {
          ipMode: form.ipMode,
          vni: form.vniMode === 'choose' ? vniNumber : undefined,
          peers: peersListed,
          mtu: form.mtu ? Number(form.mtu) : undefined,
          port: form.port ? Number(form.port) : undefined,
        } : {}),
        ...(form.type === 'bridge' ? {
          ipMode: form.ipMode,
          physicalNic: form.physicalNic || undefined,
        } : {}),
        ...(form.type === 'existing-bridge' ? {
          ipMode: form.ipMode,
          bridge: form.existingBridge,
        } : {}),
      });
      toast.success(isVxlan ? `VXLAN "${form.name}" created` : `Network "${form.name}" created`);
      setCreateOpen(false);
      setForm(defaultForm);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to create network';
      toast.error(msg);
    }
  };

  const handleDelete = async (network: NetworkType) => {
    try {
      await deleteNetwork.mutateAsync(network.id);
      toast.success(`Network "${network.name}" deleted`);
      setDeleteTarget(null);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to delete network';
      toast.error(msg);
    }
  };

  const createDisabled =
    !form.name ||
    (hasAddresses && !form.cidr) ||
    !!cidrConflict ||
    !!nameProblem ||
    !!mtuProblem ||
    !!portProblem ||
    (isVxlan && form.vniMode === 'choose' && (!vniInRange || !!vniClash)) ||
    createNetwork.isPending ||
    ((form.type === 'bridge' || form.type === 'existing-bridge') && !form.gateway) ||
    (form.type === 'existing-bridge' && !form.existingBridge);
  // What Create is waiting for, in words beside it. A CIDR clash is said under its field.
  const createWaitingFor =
    !form.name ? 'Name the network.'
    : hasAddresses && !form.cidr ? 'Give it a CIDR range.'
    : isVxlan && form.vniMode === 'choose' && !form.vni.trim() ? 'Enter a VXLAN ID.'
    : mtuProblem || portProblem ? 'Check the optional settings.'
    : form.type === 'existing-bridge' && !form.existingBridge ? 'Choose the OS bridge.'
    : (form.type === 'bridge' || form.type === 'existing-bridge') && !form.gateway ? 'A bridge needs a gateway.'
    : undefined;

  return (
    <Layout
      title="Networks"
      subtitle="NAT and bridge networks your VMs connect to, and VXLANs that connect VMs to each other."
      actions={
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setGuideOpen(true)}>
            <BookOpen className="h-3.5 w-3.5" /> Setup guide
          </Button>
          <Button onClick={() => openCreate()}>
            <Plus className="h-3.5 w-3.5" /> New network
          </Button>
        </div>
      }
    >
      <div className="space-y-6">
        {isLoading ? (
          <div className="panel overflow-hidden">
            <div className="space-y-px p-3">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[60px] rounded-lg" />)}
            </div>
          </div>
        ) : !networks?.length ? (
          <div className="panel overflow-hidden">
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <Network className="mb-3 h-5 w-5 text-muted-foreground" />
              <p className="text-sm font-semibold text-foreground">No networks configured</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Create a NAT network, a bridge to an upstream network, or a private VXLAN.
              </p>
              <Button size="sm" className="mt-5" onClick={() => openCreate()}>
                <Plus className="h-3.5 w-3.5" /> New network
              </Button>
            </div>
          </div>
        ) : (
          <>
            {others.length > 0 && (
              <Panel className="overflow-hidden">
                <PanelHeader title="NAT and bridge" />
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="table-head">
                        {['Name', 'Type', 'Addresses', 'Bridge', ''].map((h, i) => (
                          <th
                            key={h}
                            className={cn(
                              'whitespace-nowrap py-2.5 text-left text-[12px] font-medium text-muted-foreground',
                              i === 0 ? 'pl-5 pr-3' : h === '' ? 'pl-3 pr-5' : 'px-3'
                            )}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {others.map((n) => (
                        <NetworkRow
                          key={n.id}
                          network={n}
                          status={bridgeStatus?.[n.id]}
                          onDelete={() => setDeleteTarget(n)}
                        />
                      ))}
                    </tbody>
                    {/* The count in the list's own foot; the split by kind only when there is one. */}
                    <tfoot>
                      <tr className="border-t border-border bg-surface/60">
                        <td colSpan={5} className="px-5 py-2.5 text-[12px] tabular-nums text-muted-foreground">
                          {others.length} {others.length === 1 ? 'network' : 'networks'}
                          {natCount > 0 && bridgeCount > 0 && <> · {natCount} NAT · {bridgeCount} bridged</>}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Panel>
            )}
            <VxlanPanel networks={vxlans} onNew={() => openCreate('vxlan')} onDelete={setDeleteTarget} />
          </>
        )}
      </div>

      {/* Create dialog */}
      <Dialog
        open={createOpen}
        onClose={() => { setCreateOpen(false); setForm(defaultForm); }}
        title="New network"
        note={createNetwork.isPending ? undefined : createWaitingFor}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => { setCreateOpen(false); setForm(defaultForm); }}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={createDisabled}>
              {createNetwork.isPending ? 'Creating…' : 'Create network'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input label="Name" value={form.name} onChange={set('name')} required placeholder="e.g. lab-net" error={nameProblem} />

          <Select label="Type" value={form.type} onChange={setType}>
            <option value="nat">NAT - libvirt managed, isolated DHCP</option>
            <option value="bridge">Bridge - VirtPilot creates a new bridge</option>
            <option value="existing-bridge">Existing OS bridge - attach to a pre-configured bridge</option>
            <option value="vxlan">VXLAN - private network</option>
          </Select>

          {isVxlan && <Callout>{TYPE_DESCRIPTIONS[descKey]}</Callout>}

          {isVxlan && (
            <div className="space-y-1.5">
              <p id="vxlan-id-label" className="text-[13px] font-semibold text-foreground">VXLAN ID</p>
              <div className="segmented" role="group" aria-labelledby="vxlan-id-label">
                <button type="button" aria-pressed={form.vniMode === 'next'} onClick={() => setForm((f) => ({ ...f, vniMode: 'next' }))}>
                  Next available
                </button>
                <button type="button" aria-pressed={form.vniMode === 'choose'} onClick={() => setForm((f) => ({ ...f, vniMode: 'choose' }))}>
                  Choose an ID
                </button>
              </div>
              {form.vniMode === 'next' ? (
                <p className="text-[12.5px] text-muted-foreground">
                  This network gets ID <span className="font-mono text-foreground">{vxlanIds?.next ?? '…'}</span>.
                </p>
              ) : (
                <Input
                  aria-labelledby="vxlan-id-label"
                  id="vxlan-id"
                  value={form.vni}
                  onChange={set('vni')}
                  inputMode="numeric"
                  placeholder={`1 to ${VNI_MAX}`}
                  className="font-mono"
                  error={vniProblem}
                />
              )}
            </div>
          )}

          {isVxlan && (
            <Select label="Addresses" value={form.ipMode} onChange={set('ipMode')}>
              <option value="dhcp">DHCP - from this host</option>
              <option value="static">Static - from a pool</option>
              <option value="none">None - set by the VMs</option>
            </Select>
          )}

          {(form.type === 'bridge' || form.type === 'existing-bridge') && (
            <Select label="IP mode" value={form.ipMode} onChange={set('ipMode')}>
              <option value="static">Static - VirtPilot assigns IPs from pool</option>
              <option value="dhcp">DHCP - upstream network assigns IPs</option>
            </Select>
          )}

          {hasAddresses && (
            <div className="space-y-1">
              <Input
                label="CIDR"
                value={form.cidr}
                onChange={set('cidr')}
                required
                placeholder={form.type === 'nat' || isVxlan ? '10.0.1.0/24' : '203.0.113.0/29'}
                className="font-mono"
              />
              {cidrConflict && (
                <p className="text-xs text-destructive">
                  Overlaps with existing network &ldquo;{cidrConflict.name}&rdquo; ({cidrConflict.cidr})
                </p>
              )}
            </div>
          )}

          {!isVxlan && (
            <Input
              label={form.type === 'nat' ? 'Gateway (optional - defaults to first usable IP)' : 'Gateway'}
              id="network-gateway"
              value={form.gateway}
              onChange={set('gateway')}
              required={form.type === 'bridge'}
              placeholder={form.type === 'nat' ? '10.0.1.1' : '203.0.113.1'}
              className="font-mono"
            />
          )}

          {!isVxlan && (
            <Input
              label="DNS servers (comma-separated)"
              value={form.dns}
              onChange={set('dns')}
              placeholder="8.8.8.8, 8.8.4.4"
            />
          )}

          {/* A private network on this host needs none of these: the form stays short enough
              for its buttons to fit a laptop's window. */}
          {isVxlan && (
            <div className="space-y-4">
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={optionalOpen}
                aria-controls="vxlan-optional"
                onClick={() => setOptionalOpen((v) => !v)}
              >
                {optionalOpen ? 'Hide optional settings' : 'Show optional settings'}
              </Button>
              {optionalOpen && (
                <div id="vxlan-optional" className="space-y-4">
                  {hasAddresses && (
                    <Input
                      label={form.ipMode === 'dhcp' ? "This host's address" : 'Gateway (for a router VM on this network)'}
                      id="network-gateway"
                      value={form.gateway}
                      onChange={set('gateway')}
                      placeholder={form.ipMode === 'dhcp' ? firstUsable(form.cidr) ?? '10.0.1.1' : '10.0.1.1'}
                      className="font-mono"
                    />
                  )}
                  <RemoteHostsField
                    value={form.peers}
                    onChange={(peers) => setForm((f) => ({ ...f, peers }))}
                    rows={2}
                    help="Other hosts that carry this VXLAN, one IPv4 address per line."
                  />
                  {peersListed.length > 0 && (
                    <Callout tone="warn">
                      Traffic between hosts is not encrypted: use a private link or a VPN between them.
                      {form.ipMode === 'dhcp' && ' Only one host on a VXLAN should hand out addresses: on the others, choose None.'}
                    </Callout>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <Input label="MTU" id="vxlan-mtu" value={form.mtu} onChange={set('mtu')} inputMode="numeric" placeholder="1442" className="font-mono" error={mtuProblem} />
                    <Input label="UDP port" id="vxlan-port" value={form.port} onChange={set('port')} inputMode="numeric" placeholder="4789" className="font-mono" error={portProblem} />
                  </div>
                </div>
              )}
            </div>
          )}

          {form.type === 'bridge' && (
            <div className="space-y-1.5">
              <label className="block text-[13px] font-semibold text-foreground">
                Physical NIC <span className="font-normal text-muted-foreground">(optional - must be a dedicated NIC with no active IPs)</span>
              </label>
              <Select value={form.physicalNic} onChange={set('physicalNic')}>
                <option value="">None (floating bridge)</option>
                {(systemNics ?? []).map((nic) => (
                  <option key={nic.name} value={nic.name} disabled={nic.hasIps || nic.inUse}>
                    {nic.name}, {nic.mac}
                    {nic.speed ? `, ${nic.speed}` : ''}
                    {nic.hasIps ? ' ⚠ the host uses it: use Existing OS bridge instead' : nic.inUse ? ' (already in use)' : ''}
                  </option>
                ))}
              </Select>
              {!systemNics?.length && (
                <p className="text-xs text-muted-foreground">No physical NICs detected.</p>
              )}
              {form.physicalNic && systemNics?.find((n) => n.name === form.physicalNic)?.hasIps && (
                <p className="text-xs text-destructive">
                  This NIC has active IPs. Enslaving it will drop host connectivity. Configure the bridge at the OS level first, then use "Existing OS bridge".
                </p>
              )}
            </div>
          )}

          {form.type === 'existing-bridge' && (
            <div className="space-y-1.5">
              <Input
                label="Bridge name"
                value={form.existingBridge}
                onChange={set('existingBridge')}
                required
                placeholder="br0"
              />
              <p className="text-xs text-muted-foreground">
                The bridge must already exist on the host. VirtPilot will attach VMs to it but will never modify or remove it.
              </p>
            </div>
          )}

          {!isVxlan && <Callout>{TYPE_DESCRIPTIONS[descKey]}</Callout>}
        </div>
      </Dialog>

      <NetworkGuide open={guideOpen} onClose={() => setGuideOpen(false)} />

      {/* Delete confirmation */}
      <Dialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete network"
        description={deleteTarget ? [deleteTarget.name, deleteTarget.vni !== undefined ? `VXLAN ID ${deleteTarget.vni}` : '', deleteTarget.cidr].filter(Boolean).join(' · ') : undefined}
        note={connectedLoading
          ? 'Checking for connected VMs…'
          : blockers.length > 0 ? `${blockers.length} ${blockers.length === 1 ? 'VM is' : 'VMs are'} still connected.`
          : adding.length > 0 ? `${adding.length} ${adding.length === 1 ? 'VM is' : 'VMs are'} being added.` : undefined}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => deleteTarget && handleDelete(deleteTarget)}
              disabled={deleteNetwork.isPending || blockers.length > 0 || adding.length > 0 || connectedLoading}
            >
              {deleteNetwork.isPending ? 'Deleting…' : 'Delete network'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-foreground">
          {blockedSaying
            ? blockedSaying
            : deleteTarget?.type === 'vxlan'
            ? 'This will destroy its bridge and tunnel.'
            : deleteTarget?.type === 'nat'
            ? 'This will destroy the libvirt network and its bridge.'
            : deleteTarget?.type === 'existing-bridge'
              ? `This will remove the network record. The OS bridge "${deleteTarget.bridge}" will not be touched.`
              : deleteTarget ? bridgeDeleteText(deleteTarget, bridgeStatus?.[deleteTarget.id]) : ''}
        </p>
      </Dialog>
    </Layout>
  );
}
