import { useState } from 'react';
import { BookOpen, Globe, Network, Plus, Trash2, Wifi } from 'lucide-react';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useNetworks, useCreateNetwork, useDeleteNetwork, useNetwork, useSystemNics } from '@/hooks/useNetworks';
import { cn } from '@/lib/cn';
import { NetworkGuide } from './NetworkGuide';
import type { Network as NetworkType } from '@/types';

function StatCard({ icon: Icon, label, value, iconClass }: {
  icon: React.ElementType;
  label: string;
  value: string;
  iconClass: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', iconClass)}>
          <Icon size={15} />
        </div>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</p>
          <p className="mt-0.5 text-xl font-bold tabular-nums leading-tight text-foreground">{value}</p>
        </div>
      </div>
    </div>
  );
}

function IpPoolDetail({ networkId }: { networkId: string }) {
  const { data } = useNetwork(networkId);
  if (!data?.ips?.length) return null;
  const available = data.ips.filter((i) => !i.allocated).length;
  return (
    <span className="text-xs text-muted-foreground">
      {available}/{data.ips.length} available
    </span>
  );
}

function networkTypeLabel(n: NetworkType): string {
  if (n.type === 'nat') return 'NAT';
  if (n.type === 'existing-bridge') return n.ipMode === 'dhcp' ? 'OS Bridge DHCP' : 'OS Bridge Static';
  return n.ipMode === 'dhcp' ? 'Bridge DHCP' : 'Bridge Static';
}

function networkTypeColor(n: NetworkType): string {
  if (n.type === 'nat') return 'text-blue-500 dark:text-blue-400';
  if (n.ipMode === 'dhcp') return 'text-violet-500 dark:text-violet-400';
  return 'text-emerald-500 dark:text-emerald-400';
}

function networkIconBg(n: NetworkType): string {
  if (n.type === 'nat') return 'bg-blue-500/10';
  if (n.ipMode === 'dhcp') return 'bg-violet-500/10';
  return 'bg-emerald-500/10';
}

function NetworkIcon({ n, className }: { n: NetworkType; className?: string }) {
  if (n.type === 'nat') return <Network className={cn('h-4 w-4 text-blue-500 dark:text-blue-400', className)} />;
  if (n.ipMode === 'dhcp') return <Globe className={cn('h-4 w-4 text-violet-500 dark:text-violet-400', className)} />;
  return <Globe className={cn('h-4 w-4 text-emerald-500 dark:text-emerald-400', className)} />;
}

function NetworkRow({ network, onDelete }: { network: NetworkType; onDelete: () => void }) {
  return (
    <tr className="transition-colors hover:bg-muted/30">
      <td className="px-5 py-3.5">
        <div className="flex items-center gap-3">
          <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', networkIconBg(network))}>
            <NetworkIcon n={network} />
          </div>
          <span className="text-sm font-semibold text-foreground">{network.name}</span>
        </div>
      </td>
      <td className="px-5 py-3.5">
        <span className={cn('text-xs font-medium', networkTypeColor(network))}>
          {networkTypeLabel(network)}
        </span>
      </td>
      <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">{network.cidr}</td>
      <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">
        {network.bridge}
        {network.physicalNic && (
          <span className="ml-1.5 text-muted-foreground/50">← {network.physicalNic}</span>
        )}
        {network.type === 'existing-bridge' && (
          <span className="ml-1.5 text-muted-foreground/50">(OS)</span>
        )}
      </td>
      <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">{network.gateway}</td>
      <td className="px-5 py-3.5 text-xs text-muted-foreground">
        {network.type === 'bridge' && network.ipMode === 'static'
          ? <IpPoolDetail networkId={network.id} />
          : <span>DHCP</span>
        }
      </td>
      <td className="px-5 py-3.5 text-right">
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
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

function suggestNextLocalCidr(networks: NetworkType[]): string {
  for (let octet = 1; octet <= 254; octet++) {
    const candidate = `10.0.${octet}.0/24`;
    if (!networks.some((n) => cidrsOverlap(candidate, n.cidr))) return candidate;
  }
  return '10.0.1.0/24';
}

interface CreateForm {
  name: string;
  type: 'nat' | 'bridge' | 'existing-bridge';
  ipMode: 'dhcp' | 'static';
  cidr: string;
  gateway: string;
  dns: string;
  physicalNic: string;
  existingBridge: string;
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
};

const TYPE_DESCRIPTIONS: Record<string, string> = {
  nat: 'A libvirt NAT network is created automatically. VMs get DHCP IPs and are reachable from this host. Ideal for isolated dev/test networks.',
  'bridge-dhcp': 'VirtPilot creates a new Linux bridge and optionally enslaves a dedicated NIC (one with no active IPs). VMs are bridged onto your upstream network and receive IPs from its DHCP server.',
  'bridge-static': 'VirtPilot creates a new Linux bridge and optionally enslaves a dedicated NIC (one with no active IPs). VirtPilot assigns static IPs from the pool you define via cloud-init.',
  'existing-bridge-dhcp': 'Attach to a bridge already configured at the OS level (netplan / /etc/network/interfaces). VirtPilot will never modify this bridge. VMs receive IPs from the upstream DHCP server.',
  'existing-bridge-static': 'Attach to a bridge already configured at the OS level (netplan / /etc/network/interfaces). VirtPilot will never modify this bridge. VirtPilot assigns static IPs from the pool you define via cloud-init.',
};

export function NetworksPage() {
  const { data: networks, isLoading } = useNetworks();
  const { data: systemNics } = useSystemNics();
  const createNetwork = useCreateNetwork();
  const deleteNetwork = useDeleteNetwork();

  const [createOpen, setCreateOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<NetworkType | null>(null);
  const [form, setForm] = useState<CreateForm>(defaultForm);

  const openCreate = () => {
    const suggested = suggestNextLocalCidr(networks ?? []);
    setForm({ ...defaultForm, cidr: suggested });
    setCreateOpen(true);
  };

  const natCount = networks?.filter((n) => n.type === 'nat').length ?? 0;
  const bridgeCount = networks?.filter((n) => n.type === 'bridge' || n.type === 'existing-bridge').length ?? 0;

  const cidrConflict = form.cidr
    ? (networks ?? []).find((n) => cidrsOverlap(form.cidr, n.cidr))
    : undefined;

  const set = (key: keyof CreateForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const descKey = form.type === 'nat'
    ? 'nat'
    : form.type === 'existing-bridge'
      ? `existing-bridge-${form.ipMode}`
      : `bridge-${form.ipMode}`;

  const handleCreate = async () => {
    try {
      const dns = form.dns.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
      await createNetwork.mutateAsync({
        name: form.name,
        type: form.type,
        cidr: form.cidr,
        gateway: form.gateway || undefined,
        dns: dns.length ? dns : undefined,
        ...(form.type === 'bridge' ? {
          ipMode: form.ipMode,
          physicalNic: form.physicalNic || undefined,
        } : {}),
        ...(form.type === 'existing-bridge' ? {
          ipMode: form.ipMode,
          bridge: form.existingBridge,
        } : {}),
      });
      toast.success(`Network "${form.name}" created`);
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
    !form.cidr ||
    !!cidrConflict ||
    createNetwork.isPending ||
    ((form.type === 'bridge' || form.type === 'existing-bridge') && !form.gateway) ||
    (form.type === 'existing-bridge' && !form.existingBridge);

  return (
    <Layout
      title="Networks"
      subtitle="Manage NAT and bridge networks for VMs."
      actions={
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setGuideOpen(true)}>
            <BookOpen className="h-3.5 w-3.5" /> Setup guide
          </Button>
          <Button onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" /> New Network
          </Button>
        </div>
      }
    >
      {/* Stats */}
      <div className="mb-6 grid grid-cols-3 gap-3">
        <StatCard icon={Network} label="Networks" value={isLoading ? '—' : String(networks?.length ?? 0)} iconClass="bg-blue-500/10 text-blue-500" />
        <StatCard icon={Wifi} label="NAT" value={isLoading ? '—' : String(natCount)} iconClass="bg-violet-500/10 text-violet-500" />
        <StatCard icon={Globe} label="Bridge" value={isLoading ? '—' : String(bridgeCount)} iconClass="bg-emerald-500/10 text-emerald-500" />
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {isLoading ? (
          <div className="space-y-px p-3">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[60px] rounded-lg" />)}
          </div>
        ) : !networks?.length ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
              <Network className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-semibold text-foreground">No networks configured</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Create a NAT network or bridge to an upstream network.
            </p>
            <Button size="sm" className="mt-5" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" /> New Network
            </Button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {['Name', 'Type', 'CIDR', 'Bridge', 'Gateway', 'IPs', ''].map((h) => (
                  <th
                    key={h}
                    className={cn(
                      'px-5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground',
                      h === '' ? 'text-right' : 'text-left'
                    )}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {networks.map((n) => (
                <NetworkRow key={n.id} network={n} onDelete={() => setDeleteTarget(n)} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Create dialog */}
      <Dialog
        open={createOpen}
        onClose={() => { setCreateOpen(false); setForm(defaultForm); }}
        title="New Network"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => { setCreateOpen(false); setForm(defaultForm); }}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={createDisabled}>
              {createNetwork.isPending ? 'Creating…' : 'Create Network'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input label="Name" value={form.name} onChange={set('name')} required placeholder="My Network" />

          <Select label="Type" value={form.type} onChange={set('type')}>
            <option value="nat">NAT — libvirt managed, isolated DHCP</option>
            <option value="bridge">Bridge — VirtPilot creates a new bridge</option>
            <option value="existing-bridge">Existing OS bridge — attach to a pre-configured bridge</option>
          </Select>

          {(form.type === 'bridge' || form.type === 'existing-bridge') && (
            <Select label="IP Mode" value={form.ipMode} onChange={set('ipMode')}>
              <option value="static">Static — VirtPilot assigns IPs from pool</option>
              <option value="dhcp">DHCP — upstream network assigns IPs</option>
            </Select>
          )}

          <div className="space-y-1">
            <Input
              label="CIDR"
              value={form.cidr}
              onChange={set('cidr')}
              required
              placeholder={form.type === 'nat' ? '10.0.1.0/24' : '203.0.113.0/29'}
            />
            {cidrConflict && (
              <p className="text-xs text-destructive">
                Overlaps with existing network &ldquo;{cidrConflict.name}&rdquo; ({cidrConflict.cidr})
              </p>
            )}
          </div>

          <Input
            label={form.type === 'nat' ? 'Gateway (optional — defaults to first usable IP)' : 'Gateway'}
            value={form.gateway}
            onChange={set('gateway')}
            required={form.type === 'bridge'}
            placeholder={form.type === 'nat' ? '10.0.1.1' : '203.0.113.1'}
          />

          <Input
            label="DNS servers (comma-separated)"
            value={form.dns}
            onChange={set('dns')}
            placeholder="8.8.8.8, 8.8.4.4"
          />

          {form.type === 'bridge' && (
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-foreground">
                Physical NIC <span className="font-normal text-muted-foreground">(optional — must be a dedicated NIC with no active IPs)</span>
              </label>
              <Select value={form.physicalNic} onChange={set('physicalNic')}>
                <option value="">None (floating bridge)</option>
                {(systemNics ?? []).map((nic) => (
                  <option key={nic.name} value={nic.name} disabled={nic.hasIps || nic.inUse}>
                    {nic.name} — {nic.mac}
                    {nic.speed ? ` — ${nic.speed}` : ''}
                    {nic.hasIps ? ' ⚠ has active IPs — use Existing OS bridge instead' : nic.inUse ? ' (already in use)' : ''}
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

          <p className="rounded-lg bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
            {TYPE_DESCRIPTIONS[descKey]}
          </p>
        </div>
      </Dialog>

      <NetworkGuide open={guideOpen} onClose={() => setGuideOpen(false)} />

      {/* Delete confirmation */}
      <Dialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={`Delete "${deleteTarget?.name}"?`}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => deleteTarget && handleDelete(deleteTarget)}
              disabled={deleteNetwork.isPending}
            >
              {deleteNetwork.isPending ? 'Deleting…' : 'Delete Network'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-foreground">
          {deleteTarget?.type === 'nat'
            ? 'This will destroy the libvirt network and its bridge.'
            : deleteTarget?.type === 'existing-bridge'
              ? `This will remove the network record. The OS bridge "${deleteTarget.bridge}" will not be touched.`
              : deleteTarget?.physicalNic
                ? `This will detach ${deleteTarget.physicalNic} from the bridge, bring it down, and remove the network.`
                : 'This will bring down the bridge and remove the network.'}
        </p>
      </Dialog>
    </Layout>
  );
}
