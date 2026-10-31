import { Router } from 'express';
import * as networkService from '../services/networkService.js';
import * as portForwardService from '../services/portForwardService.js';
import * as logService from '../services/logService.js';
import * as vmService from '../services/vmService.js';
import { listVmMetas } from '../services/vmMetaService.js';
import { readVxlanRuntime, type VxlanRuntime } from '../services/vxlanService.js';
import { parseDhcpLeases } from '../lib/vmAddresses.js';
import { VXLAN_DEFAULT_PORT, VxlanInputError } from '../lib/vxlan.js';
import { validateIpv4, ValidationError } from '../lib/validate.js';
import { virsh } from '../services/safeExec.js';

export const networksRouter = Router();

// A failure worded for the operator goes out as it stands, under its own status.
function failure(err: unknown): { status: number; error: string } {
  if (err instanceof networkService.NetworkError) return { status: err.status, error: err.message };
  if (err instanceof VxlanInputError) return { status: 400, error: err.message };
  if (err instanceof ValidationError) return { status: 400, error: err.message };
  return { status: 500, error: String(err) };
}

// ─── VXLAN ────────────────────────────────────────────────────────────────────
// Above the /:id routes: "vxlan" is not a network ID.

// What the form needs: the ID "next available" would give, and every ID it can't
// have, including ones in use outside VirtPilot.
networksRouter.get('/vxlan/ids', async (_req, res) => {
  try {
    res.json(await networkService.listVxlanIds());
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

interface VxlanVm {
  id: string;
  name: string;
  status: string;
  mac: string;
  ip?: string;
}

// The live state of every VXLAN, read from the host and libvirt on each call: what
// its tunnel is doing and which VMs are connected, running or not.
networksRouter.get('/vxlan/status', async (_req, res) => {
  try {
    const networks = (await networkService.listNetworks()).filter((n) => n.type === 'vxlan');
    const status: Record<string, VxlanRuntime & { vms: VxlanVm[] }> = {};
    if (networks.length > 0) {
      const [runtime, vms, metas] = await Promise.all([readVxlanRuntime(networks), vmService.listVmsWithNics(), listVmMetas()]);
      const staticIp = new Map(metas.flatMap((m) => (m.networks ?? []).map((a) => [a.mac.toLowerCase(), a.ip] as const)));
      for (const n of networks) {
        const onThis = vms.flatMap((vm) => vm.nics.filter((nic) => nic.source === n.bridge).map((nic) => ({ vm, nic })));
        const leases = n.ipMode === 'dhcp' && onThis.length > 0
          ? parseDhcpLeases(await virsh(['net-dhcp-leases', n.libvirtName!]).catch(() => ''))
          : new Map<string, string>();
        status[n.id] = {
          ...runtime.get(n.id)!,
          vms: onThis.map(({ vm, nic }) => {
            const mac = nic.mac.toLowerCase();
            return { id: vm.id, name: vm.name, status: vm.status, mac, ip: staticIp.get(mac) ?? leases.get(mac) };
          }),
        };
      }
    }
    res.json({ status });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// Remote hosts are the one thing about a VXLAN that changes after it is made.
networksRouter.put('/:id/peers', async (req, res) => {
  const start = Date.now();
  const { id } = req.params;
  try {
    const { peers } = req.body as { peers?: unknown };
    // Missing is not "none": emptying the list takes a tunnel down.
    if (peers === undefined || peers === null) return res.status(400).json({ error: 'peers is required: a list of IPv4 addresses, empty for none' });
    const network = await networkService.updateVxlanPeers(id, peers);
    void logService.appendLog({
      type: 'network.vxlan.peers',
      subject: network.name,
      status: 'success',
      output: `remote hosts: ${network.peers?.length ? network.peers.join(', ') : 'none'}`,
      durationMs: Date.now() - start,
    });
    res.json({ network });
  } catch (err: unknown) {
    const { status, error } = failure(err);
    void logService.appendLog({ type: 'network.vxlan.peers', subject: id, status: 'error', output: error, durationMs: Date.now() - start });
    res.status(status).json({ error });
  }
});

networksRouter.get('/', async (_req, res) => {
  try {
    const networks = await networkService.listNetworks();
    res.json({ networks });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

networksRouter.get('/:id', async (req, res) => {
  try {
    const network = await networkService.getNetwork(req.params.id);
    if (!network) return res.status(404).json({ error: 'Network not found' });
    const ips = await networkService.getNetworkIpStatus(req.params.id);
    res.json({ network, ips });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

networksRouter.post('/', async (req, res) => {
  const start = Date.now();
  try {
    const { name, type, cidr, gateway, dns, ipMode, physicalNic, bridge: existingBridgeName, vni, peers, mtu, port } = req.body;
    // A VXLAN can do without a CIDR: with ipMode "none" it has no addresses at all.
    if (!name || !type || (!cidr && type !== 'vxlan')) {
      return res.status(400).json({ error: 'name, type, and cidr are required' });
    }
    // gateway is interpolated into the libvirt network XML, so it has to be a
    // real address before it goes anywhere near the service layer.
    if (gateway) {
      try {
        validateIpv4(gateway);
      } catch (err) {
        return res.status(400).json({ error: err instanceof ValidationError ? err.message : 'Invalid gateway' });
      }
    }

    let network: networkService.Network;

    if (type === 'nat') {
      network = await networkService.createNatNetwork({ name, cidr, gateway, dns });
    } else if (type === 'vxlan') {
      network = await networkService.createVxlanNetwork({ name, vni, ipMode: ipMode ?? 'dhcp', cidr, gateway, peers, mtu, port });
    } else if (type === 'bridge') {
      if (!gateway) {
        return res.status(400).json({ error: 'gateway is required for bridge networks' });
      }
      const mode: networkService.BridgeIpMode = ipMode === 'dhcp' ? 'dhcp' : 'static';
      network = await networkService.createBridgeNetwork({
        name, cidr, gateway, dns,
        ipMode: mode,
        physicalNic: physicalNic || undefined,
      });
    } else if (type === 'existing-bridge') {
      if (!gateway) {
        return res.status(400).json({ error: 'gateway is required for bridge networks' });
      }
      if (!existingBridgeName) {
        return res.status(400).json({ error: 'bridge name is required for existing-bridge networks' });
      }
      const mode: networkService.BridgeIpMode = ipMode === 'dhcp' ? 'dhcp' : 'static';
      network = await networkService.createExistingBridgeNetwork({
        name, cidr, gateway, dns,
        ipMode: mode,
        bridge: existingBridgeName,
      });
    } else {
      return res.status(400).json({ error: 'type must be "nat", "bridge", "existing-bridge", or "vxlan"' });
    }

    void logService.appendLog({
      type: 'network.create',
      subject: name,
      status: 'success',
      output: network.type === 'vxlan'
        ? `type=vxlan id=${network.vni} port=${network.vxlanPort ?? VXLAN_DEFAULT_PORT} mtu=${network.mtu} addresses=${network.ipMode}${network.cidr ? ` cidr=${network.cidr}` : ''} remote hosts=${network.peers?.length ?? 0}`
        : `type=${type} cidr=${cidr}`,
      durationMs: Date.now() - start,
    });

    res.status(201).json({ network });
  } catch (err: unknown) {
    const { status, error } = failure(err);
    void logService.appendLog({
      type: 'network.create',
      subject: (req.body as { name?: string }).name ?? 'unknown',
      status: 'error',
      output: error,
      durationMs: Date.now() - start,
    });
    res.status(status).json({ error });
  }
});

networksRouter.delete('/:id', async (req, res) => {
  const start = Date.now();
  const { id } = req.params;
  try {
    // Fetch name before deleting for the log subject
    const network = await networkService.getNetwork(id);
    await networkService.deleteNetwork(id);
    void logService.appendLog({
      type: 'network.delete',
      subject: network?.name ?? id,
      status: 'success',
      durationMs: Date.now() - start,
    });
    res.json({ ok: true });
  } catch (err: unknown) {
    const { status, error } = failure(err);
    void logService.appendLog({ type: 'network.delete', subject: id, status: 'error', output: error, durationMs: Date.now() - start });
    res.status(status).json({ error });
  }
});

// Port forwards — NAT networks only

networksRouter.get('/:id/port-forwards', async (req, res) => {
  try {
    const forwards = await portForwardService.listPortForwards(req.params.id);
    res.json({ forwards });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

networksRouter.post('/:id/port-forwards', async (req, res) => {
  const start = Date.now();
  try {
    const { vmUuid, mac, protocol, hostPort, vmPort, description } = req.body;
    if (!vmUuid || !mac || !protocol || !hostPort || !vmPort) {
      return res.status(400).json({ error: 'vmUuid, mac, protocol, hostPort, and vmPort are required' });
    }
    if (protocol !== 'tcp' && protocol !== 'udp') {
      return res.status(400).json({ error: 'protocol must be "tcp" or "udp"' });
    }
    const forward = await portForwardService.createPortForward({
      networkId: req.params.id,
      vmUuid,
      mac,
      protocol,
      hostPort: Number(hostPort),
      vmPort: Number(vmPort),
      description,
    });
    void logService.appendLog({
      type: 'network.port-forward.create',
      subject: vmUuid,
      subjectUuid: vmUuid,
      status: 'success',
      output: `${protocol} :${hostPort} → ${vmUuid}:${vmPort}${description ? ` (${description})` : ''}`,
      durationMs: Date.now() - start,
    });
    res.status(201).json({ forward });
  } catch (err: unknown) {
    void logService.appendLog({
      type: 'network.port-forward.create',
      subject: (req.body as { vmUuid?: string }).vmUuid ?? 'unknown',
      status: 'error',
      output: String(err),
      durationMs: Date.now() - start,
    });
    res.status(500).json({ error: String(err) });
  }
});

networksRouter.delete('/:id/port-forwards/:forwardId', async (req, res) => {
  const start = Date.now();
  const { forwardId } = req.params;
  try {
    await portForwardService.deletePortForward(forwardId);
    void logService.appendLog({ type: 'network.port-forward.delete', subject: forwardId, status: 'success', durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'network.port-forward.delete', subject: forwardId, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

networksRouter.post('/:id/reserve', async (req, res) => {
  try {
    const { vmUuid, mac } = req.body as { vmUuid: string; mac: string };
    if (!vmUuid || !mac) return res.status(400).json({ error: 'vmUuid and mac are required' });
    const ip = await portForwardService.reserveVmIp(req.params.id, vmUuid, mac);
    res.json({ ip });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});
