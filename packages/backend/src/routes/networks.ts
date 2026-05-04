import { Router } from 'express';
import * as networkService from '../services/networkService.js';
import * as portForwardService from '../services/portForwardService.js';
import * as logService from '../services/logService.js';

export const networksRouter = Router();

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
    const { name, type, cidr, gateway, dns, ipMode, physicalNic, bridge: existingBridgeName } = req.body;
    if (!name || !type || !cidr) {
      return res.status(400).json({ error: 'name, type, and cidr are required' });
    }

    let network: networkService.Network;

    if (type === 'nat') {
      network = await networkService.createNatNetwork({ name, cidr, gateway, dns });
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
      return res.status(400).json({ error: 'type must be "nat", "bridge", or "existing-bridge"' });
    }

    void logService.appendLog({
      type: 'network.create',
      subject: name,
      status: 'success',
      output: `type=${type} cidr=${cidr}`,
      durationMs: Date.now() - start,
    });

    res.status(201).json({ network });
  } catch (err: unknown) {
    void logService.appendLog({
      type: 'network.create',
      subject: (req.body as { name?: string }).name ?? 'unknown',
      status: 'error',
      output: String(err),
      durationMs: Date.now() - start,
    });
    res.status(500).json({ error: String(err) });
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
    void logService.appendLog({ type: 'network.delete', subject: id, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
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
