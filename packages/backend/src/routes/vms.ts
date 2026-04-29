import { Router } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

const execAsync = promisify(exec);
import * as vmService from '../services/vmService.js';
import * as storageService from '../services/storageService.js';
import * as networkService from '../services/networkService.js';
import * as vmMetaService from '../services/vmMetaService.js';
import * as portForwardService from '../services/portForwardService.js';
import * as firewallService from '../services/firewallService.js';
import * as logService from '../services/logService.js';
import { type TraceEntry, formatTrace } from '../services/traceService.js';
import { buildCloudInitIso, getHostSshPublicKey, type NicCloudInit } from '../services/cloudInitService.js';
import { buildDomainXml, generateMac, type NicDefinition, type CpuMode } from '../services/xmlBuilder.js';

export const vmsRouter = Router();

vmsRouter.get('/', async (_req, res) => {
  try {
    const vms = await vmService.listVmsRaw();
    res.json({ vms });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.get('/disks', async (_req, res) => {
  try {
    let vmNames: Set<string> = new Set();
    try {
      const vms = await vmService.listVmsRaw();
      vmNames = new Set(vms.map((v) => v.name));
    } catch { /* libvirt unavailable */ }

    let entries: string[] = [];
    try {
      entries = await fs.readdir(config.vmsDir);
    } catch { /* vms dir not created yet */ }

    const disks: Array<{ vmName: string; filename: string; sizeGb: number; vmExists: boolean }> = [];

    for (const entry of entries) {
      const vmDir = path.join(config.vmsDir, entry);
      try {
        const s = await fs.stat(vmDir);
        if (!s.isDirectory()) continue;
      } catch { continue; }

      let files: string[] = [];
      try { files = await fs.readdir(vmDir); } catch { continue; }

      for (const file of files.filter((f) => f.endsWith('.qcow2'))) {
        try {
          const fileStat = await fs.stat(path.join(vmDir, file));
          disks.push({
            vmName: entry,
            filename: file,
            sizeGb: Math.round((fileStat.size / 1_073_741_824) * 100) / 100,
            vmExists: vmNames.has(entry),
          });
        } catch { continue; }
      }
    }

    res.json({ disks });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.get('/:name', async (req, res) => {
  try {
    const vm = await vmService.getVmInfo(req.params.name);
    res.json({ vm });
  } catch (err: unknown) {
    res.status(404).json({ error: String(err) });
  }
});

vmsRouter.get('/:name/meta', async (req, res) => {
  try {
    const meta = await vmMetaService.getVmMeta(req.params.name);

    let ip: string | null = null;
    if (meta?.networks) {
      const primaryAlloc = meta.networks.find((n) => n.isPrimary);
      ip = primaryAlloc?.ip ?? null;
    }

    if (!ip) {
      try {
        const { stdout } = await execAsync(`virsh domifaddr "${req.params.name}" --source arp`);
        const match = stdout.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/\d+/);
        if (match) ip = match[1];
      } catch { /* VM not running or no lease yet */ }
    }

    res.json({ meta, ip });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.get('/:name/ifaddrs', async (req, res) => {
  try {
    const ips = await vmService.getVmInterfaceIps(req.params.name);
    res.json({ ips });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.get('/:name/reservations', async (req, res) => {
  try {
    const reservations = await portForwardService.getReservationsForVm(req.params.name);
    res.json({ reservations });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.get('/:name/port-forwards', async (req, res) => {
  try {
    const forwards = await portForwardService.getPortForwardsForVm(req.params.name);
    res.json({ forwards });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

interface NetworkRequest {
  networkId: string;
  staticIp?: string;
  isPrimary: boolean;
}

vmsRouter.post('/', async (req, res) => {
  const start = Date.now();
  try {
    const {
      name, cpus, memoryMb, diskGb,
      templateFilename, isoFilename,
      networks, cloudInit, cpuMode, nicModel,
    } = req.body as {
      name: string;
      cpus: number;
      memoryMb: number;
      diskGb: number;
      templateFilename?: string;
      isoFilename?: string;
      networks?: NetworkRequest[];
      cloudInit?: { hostname: string; username: string; password: string; sshKeys?: string[] };
      cpuMode?: CpuMode;
      nicModel?: string;
    };

    const isIsoInstall = !!isoFilename && !templateFilename;

    if (!name || !cpus || !memoryMb || !diskGb) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name)) {
      return res.status(400).json({ error: 'VM name must be 1–80 characters: letters, numbers, hyphens, underscores only' });
    }
    if (!templateFilename && !isoFilename) {
      return res.status(400).json({ error: 'Either templateFilename or isoFilename is required' });
    }
    if (!isIsoInstall && !cloudInit) {
      return res.status(400).json({ error: 'cloudInit is required for template-based VMs' });
    }

    // Check for duplicate VM name in libvirt
    try {
      await vmService.getVmInfo(name);
      return res.status(409).json({ error: `A VM named "${name}" already exists` });
    } catch {
      // expected — VM does not exist yet
    }

    // Check for orphaned disk directory from a previous partial creation
    const vmDirPath = path.join(config.vmsDir, name);
    try {
      await fs.access(vmDirPath);
      return res.status(409).json({ error: `Storage directory for "${name}" already exists. Remove ${vmDirPath} manually before retrying.` });
    } catch {
      // expected — directory does not exist yet
    }

    if (templateFilename) {
      try {
        await fs.access(path.join(config.templatesDir, templateFilename));
      } catch {
        return res.status(400).json({ error: `Template "${templateFilename}" not found` });
      }
    }
    if (isoFilename) {
      try {
        await fs.access(path.join(config.isosDir, isoFilename));
      } catch {
        return res.status(400).json({ error: `ISO "${isoFilename}" not found` });
      }
    }

    const networkList = networks ?? [];
    if (networkList.length === 0) {
      return res.status(400).json({ error: 'At least one network is required' });
    }
    if (networkList.length > 8) {
      return res.status(400).json({ error: 'Maximum 8 NICs per VM' });
    }
    const primaryCount = networkList.filter((n) => n.isPrimary).length;
    if (primaryCount !== 1) {
      return res.status(400).json({ error: 'Exactly one network must be marked as primary' });
    }

    const nicDefinitions: NicDefinition[] = [];
    const nicCloudInit: NicCloudInit[] = [];
    const metaNetworks: vmMetaService.VmNetworkAlloc[] = [];

    for (const req of networkList) {
      const network = await networkService.getNetwork(req.networkId);
      if (!network) {
        return res.status(400).json({ error: `Network ${req.networkId} not found` });
      }

      const mac = generateMac();

      if ((network.type === 'bridge' || network.type === 'existing-bridge') && network.ipMode === 'static') {
        if (!req.staticIp) {
          return res.status(400).json({ error: `staticIp required for bridge/static network "${network.name}"` });
        }
        await networkService.allocateSpecificIp(req.networkId, name, mac, req.staticIp);
        const { prefix } = networkService.parseCidr(network.cidr);
        nicCloudInit.push({
          mac,
          isPrimary: req.isPrimary,
          ipConfig: { mode: 'static', ip: req.staticIp, prefix, gateway: network.gateway, dns: network.dns },
        });
        metaNetworks.push({ networkId: req.networkId, mac, ip: req.staticIp, isPrimary: req.isPrimary });
      } else {
        nicCloudInit.push({ mac, isPrimary: req.isPrimary, ipConfig: { mode: 'dhcp' } });
        metaNetworks.push({ networkId: req.networkId, mac, isPrimary: req.isPrimary });
      }

      nicDefinitions.push({ bridge: network.bridge, mac, model: nicModel ?? 'virtio' });
    }

    await storageService.ensureDirs();

    // Collect command traces across all creation steps
    const trace: TraceEntry[] = [];

    let diskPath: string;
    let domainXml: string;

    if (isIsoInstall) {
      diskPath = await storageService.createBlankPrimaryDisk(name, diskGb, trace);
      const installIsoPath = path.join(config.isosDir, isoFilename!);
      domainXml = buildDomainXml({ name, cpus, memoryMb, diskPath, installIsoPath, nics: nicDefinitions, cpuMode });
    } else {
      diskPath = await storageService.createVmDisk(name, templateFilename!, diskGb, trace);
      const hostPubKey = await getHostSshPublicKey();
      const sshKeys = [...(cloudInit!.sshKeys ?? [])];
      if (hostPubKey && !sshKeys.includes(hostPubKey)) sshKeys.push(hostPubKey);
      const cloudInitIsoPath = await buildCloudInitIso(name, { ...cloudInit!, sshKeys, nics: nicCloudInit }, trace);
      domainXml = buildDomainXml({ name, cpus, memoryMb, diskPath, cloudInitIsoPath, nics: nicDefinitions, cpuMode });
    }

    const xmlPath = path.join(config.cloudInitDir, `${name}-domain.xml`);
    await fs.writeFile(xmlPath, domainXml, 'utf8');
    await vmService.defineVm(xmlPath, trace);

    await vmMetaService.saveVmMeta({
      vmName: name,
      username: cloudInit?.username ?? '',
      password: cloudInit?.password ?? '',
      networks: metaNetworks,
      createdAt: new Date().toISOString(),
      ...(templateFilename ? { sourceTemplateFilename: templateFilename } : {}),
    });

    void logService.appendLog({
      type: 'vm.create',
      subject: name,
      status: 'success',
      output: formatTrace(trace),
      durationMs: Date.now() - start,
    });

    res.status(201).json({ name });
  } catch (err: unknown) {
    void logService.appendLog({
      type: 'vm.create',
      subject: (req.body as { name?: string }).name ?? 'unknown',
      status: 'error',
      output: String(err),
      durationMs: Date.now() - start,
    });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.delete('/:name', async (req, res) => {
  const start = Date.now();
  const { name } = req.params;
  try {
    const deleteStorage = req.query.deleteStorage === 'true';
    const output = await vmService.deleteVm(name, deleteStorage);
    if (deleteStorage) {
      await storageService.deleteVmDir(name);
    }
    await networkService.deallocateVmIps(name);
    await portForwardService.deletePortForwardsForVm(name);
    await vmMetaService.deleteVmMeta(name);
    await firewallService.deleteFirewallConfig(name);
    void logService.appendLog({ type: 'vm.delete', subject: name, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.delete', subject: name, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.post('/:name/start', async (req, res) => {
  const start = Date.now();
  const { name } = req.params;
  try {
    const output = await vmService.startVm(name);
    void logService.appendLog({ type: 'vm.start', subject: name, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.start', subject: name, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.post('/:name/stop', async (req, res) => {
  const start = Date.now();
  const { name } = req.params;
  const force = req.query.force === 'true';
  try {
    const output = await vmService.stopVm(name, force);
    void logService.appendLog({ type: force ? 'vm.stop.force' : 'vm.stop', subject: name, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: force ? 'vm.stop.force' : 'vm.stop', subject: name, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.post('/:name/reboot', async (req, res) => {
  const start = Date.now();
  const { name } = req.params;
  const force = req.query.force === 'true';
  try {
    const output = force ? await vmService.hardRebootVm(name) : await vmService.rebootVm(name);
    void logService.appendLog({ type: force ? 'vm.reboot.force' : 'vm.reboot', subject: name, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: force ? 'vm.reboot.force' : 'vm.reboot', subject: name, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

// Disks
vmsRouter.post('/:name/disks', async (req, res) => {
  const start = Date.now();
  const { name } = req.params;
  try {
    const { sizeGb, target } = req.body;
    const vm = await vmService.getVmInfo(name);
    const existingExtras = vm.disks.filter((d) => d.target.startsWith('vd') && d.target !== 'vda').length;
    const storageTrace: TraceEntry[] = [];
    const diskPath = await storageService.createBlankDisk(name, existingExtras + 1, sizeGb ?? 20, storageTrace);
    const assignedTarget = target ?? `vd${String.fromCharCode(98 + existingExtras)}`;
    const virshOutput = await vmService.attachDisk(name, diskPath, assignedTarget);
    const output = [formatTrace(storageTrace), virshOutput].filter(Boolean).join('\n\n');
    void logService.appendLog({ type: 'vm.disk.attach', subject: name, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true, diskPath });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.disk.attach', subject: name, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.delete('/:name/disks/:target', async (req, res) => {
  const start = Date.now();
  const { name, target } = req.params;
  try {
    const output = await vmService.detachDisk(name, target);
    void logService.appendLog({ type: 'vm.disk.detach', subject: name, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.disk.detach', subject: name, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

// CDROMs
vmsRouter.post('/:name/cdrom', async (req, res) => {
  const start = Date.now();
  const { name } = req.params;
  try {
    const { isoFilename, target } = req.body;
    const isoPath = path.join(config.isosDir, isoFilename);
    const output = await vmService.attachCdrom(name, isoPath, target ?? 'sdb');
    void logService.appendLog({ type: 'vm.cdrom.attach', subject: name, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.cdrom.attach', subject: name, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.delete('/:name/cdrom/:target', async (req, res) => {
  const start = Date.now();
  const { name, target } = req.params;
  try {
    const output = await vmService.detachCdrom(name, target);
    void logService.appendLog({ type: 'vm.cdrom.detach', subject: name, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.cdrom.detach', subject: name, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

// Boot Order
vmsRouter.get('/:name/boot-order', async (req, res) => {
  try {
    const bootOrder = await vmService.getBootOrder(req.params.name);
    res.json({ bootOrder });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.put('/:name/boot-order', async (req, res) => {
  const start = Date.now();
  const { name } = req.params;
  try {
    const { bootOrder } = req.body as { bootOrder: string[] };
    if (!Array.isArray(bootOrder)) return res.status(400).json({ error: 'bootOrder must be an array' });
    const output = await vmService.setBootOrder(name, bootOrder);
    void logService.appendLog({ type: 'vm.boot-order.set', subject: name, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.boot-order.set', subject: name, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.post('/:name/boot-once', async (req, res) => {
  const start = Date.now();
  const { name } = req.params;
  try {
    const { device } = req.body as { device: 'cdrom' | 'hd' };
    if (!device) return res.status(400).json({ error: 'device is required' });
    const output = await vmService.startVmBootOnce(name, device);
    void logService.appendLog({ type: 'vm.boot-once', subject: name, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.boot-once', subject: name, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

// NICs
vmsRouter.post('/:name/nics', async (req, res) => {
  const start = Date.now();
  const { name } = req.params;
  try {
    const { networkId, model, staticIp } = req.body as { networkId: string; model?: string; staticIp?: string };
    if (!networkId) return res.status(400).json({ error: 'networkId is required' });

    const network = await networkService.getNetwork(networkId);
    if (!network) return res.status(400).json({ error: `Network ${networkId} not found` });

    const mac = generateMac();

    let allocatedIp: string | undefined;
    if ((network.type === 'bridge' || network.type === 'existing-bridge') && network.ipMode === 'static') {
      if (!staticIp) return res.status(400).json({ error: `staticIp required for static network "${network.name}"` });
      await networkService.allocateSpecificIp(networkId, name, mac, staticIp);
      allocatedIp = staticIp;
    }

    const output = await vmService.attachNic(name, network.bridge, model ?? 'virtio', mac);

    const meta = await vmMetaService.getVmMeta(name);
    if (meta) {
      await vmMetaService.saveVmMeta({
        ...meta,
        networks: [...(meta.networks ?? []), { networkId, mac, ip: allocatedIp, isPrimary: false }],
      });
    }

    void logService.appendLog({ type: 'vm.nic.attach', subject: name, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true, mac });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.nic.attach', subject: name, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.delete('/:name/nics/:mac', async (req, res) => {
  const start = Date.now();
  const { name, mac } = req.params;
  try {
    const output = await vmService.detachNic(name, mac);

    const meta = await vmMetaService.getVmMeta(name);
    if (meta?.networks) {
      const alloc = meta.networks.find((n) => n.mac === mac);
      if (alloc?.ip) await networkService.deallocateByMac(mac);
      await vmMetaService.saveVmMeta({
        ...meta,
        networks: meta.networks.filter((n) => n.mac !== mac),
      });
    }

    void logService.appendLog({ type: 'vm.nic.detach', subject: name, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.nic.detach', subject: name, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

// Snapshots
vmsRouter.get('/:name/snapshots', async (req, res) => {
  try {
    const snapshots = await vmService.listSnapshots(req.params.name);
    res.json({ snapshots });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.post('/:name/snapshots', async (req, res) => {
  const start = Date.now();
  const { name } = req.params;
  try {
    const { name: snapshotName, description } = req.body as { name: string; description?: string };
    if (!snapshotName) return res.status(400).json({ error: 'name is required' });
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(snapshotName)) {
      return res.status(400).json({ error: 'Snapshot name may only contain letters, numbers, hyphens, and underscores' });
    }
    const output = await vmService.createSnapshot(name, snapshotName, description);
    void logService.appendLog({ type: 'vm.snapshot.create', subject: name, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.snapshot.create', subject: name, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.delete('/:name/snapshots/:snapshot', async (req, res) => {
  const start = Date.now();
  const { name, snapshot } = req.params;
  try {
    const output = await vmService.deleteSnapshot(name, snapshot);
    void logService.appendLog({ type: 'vm.snapshot.delete', subject: name, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.snapshot.delete', subject: name, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.post('/:name/snapshots/:snapshot/revert', async (req, res) => {
  const start = Date.now();
  const { name, snapshot } = req.params;
  try {
    const output = await vmService.revertSnapshot(name, snapshot);
    void logService.appendLog({ type: 'vm.snapshot.revert', subject: name, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.snapshot.revert', subject: name, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.post('/:name/snapshots/:snapshot/to-template', async (req, res) => {
  const start = Date.now();
  const { name, snapshot } = req.params;
  try {
    const { templateName } = req.body as { templateName?: string };
    if (!templateName?.trim()) return res.status(400).json({ error: 'templateName is required' });
    const safeName = templateName.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
    const filename = `${safeName}.qcow2`;

    // Detect source template from qcow2 backing chain before flattening
    let sourceTemplateFilename: string | undefined;
    try {
      const disks = await vmService.getVmDisks(name);
      const primaryDisk = disks.find((d) => d.target === 'vda' && d.source);
      if (primaryDisk?.source) {
        const { stdout } = await execAsync(`qemu-img info --output=json "${primaryDisk.source}"`);
        const info = JSON.parse(stdout) as { 'backing-filename'?: string };
        const backingFile = info['backing-filename'];
        if (backingFile) {
          const candidate = path.basename(backingFile);
          if (candidate.match(/\.(qcow2|img)$/)) sourceTemplateFilename = candidate;
        }
      }
    } catch { /* non-fatal — proceed without logo hint */ }

    const output = await vmService.exportSnapshotAsTemplate(name, snapshot, filename);
    await storageService.setTemplateDisplayName(filename, templateName.trim());
    void logService.appendLog({ type: 'vm.snapshot.export', subject: name, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true, filename, sourceTemplateFilename });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.snapshot.export', subject: name, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

// Firewall
vmsRouter.get('/:name/firewall', async (req, res) => {
  try {
    const cfg = await firewallService.getFirewallConfig(req.params.name);
    res.json(cfg);
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.put('/:name/firewall', async (req, res) => {
  try {
    const body = req.body as firewallService.FirewallConfig;
    if (!Array.isArray(body.rules)) return res.status(400).json({ error: 'rules must be an array' });
    const cfg: firewallService.FirewallConfig = {
      rules: body.rules,
      defaultInbound: body.defaultInbound ?? 'allow',
      defaultOutbound: body.defaultOutbound ?? 'allow',
      allowEstablishedInbound: body.allowEstablishedInbound ?? false,
      allowEstablishedOutbound: body.allowEstablishedOutbound ?? false,
    };
    await firewallService.saveFirewallConfig(req.params.name, cfg);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.post('/:name/firewall/apply', async (req, res) => {
  const start = Date.now();
  const { name } = req.params;
  try {
    let ip: string | null = null;
    const meta = await vmMetaService.getVmMeta(name);
    if (meta?.networks) {
      const primary = meta.networks.find((n) => n.isPrimary);
      ip = primary?.ip ?? null;
    }
    if (!ip) {
      try {
        const { stdout } = await execAsync(`virsh domifaddr "${name}" --source arp`);
        const match = stdout.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/\d+/);
        if (match) ip = match[1];
      } catch { /* VM not running */ }
    }
    if (!ip) return res.status(400).json({ error: 'Could not resolve VM IP — ensure the VM is running' });
    const cfg = await firewallService.getFirewallConfig(name);
    await firewallService.applyFirewallRules(name, ip, cfg);
    void logService.appendLog({ type: 'vm.firewall.apply', subject: name, status: 'success', output: `Applied ${cfg.rules.length} rule(s) to ${ip}`, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.firewall.apply', subject: name, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});
