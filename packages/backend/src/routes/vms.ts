import { Router, type Request, type Response, type NextFunction } from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { run, virsh } from '../services/safeExec.js';
import { validateVmName, validateVmUuid } from '../lib/validate.js';
import * as vmService from '../services/vmService.js';
import * as deviceService from '../services/deviceService.js';
import * as storageService from '../services/storageService.js';
import * as networkService from '../services/networkService.js';
import * as vmMetaService from '../services/vmMetaService.js';
import * as vmMetricsService from '../services/vmMetricsService.js';
import * as portForwardService from '../services/portForwardService.js';
import * as firewallService from '../services/firewallService.js';
import * as logService from '../services/logService.js';
import { type TraceEntry, formatTrace } from '../services/traceService.js';
import { buildCloudInitIso, deleteCloudInitArtifacts, getHostSshPublicKey, type NicCloudInit } from '../services/cloudInitService.js';
import { buildDomainXml, generateMac, type NicDefinition, type CpuMode, type FirmwareMode } from '../services/xmlBuilder.js';

export const vmsRouter = Router();

// Validates the `:uuid` path parameter as a strict RFC 4122 UUID before any
// route handler runs. Rejects bad input with a 400 so handlers can assume
// they're working with a well-formed identifier.
function requireUuidParam(req: Request, res: Response, next: NextFunction): void {
  try {
    validateVmUuid(req.params.uuid);
    next();
  } catch {
    res.status(400).json({ error: 'Invalid VM UUID' });
  }
}

// Helper for log entries: pull the VM's friendly name to attach as `subject`,
// while `subjectUuid` carries the immutable identity. Falls back to the UUID
// if the lookup fails (deleted, libvirt offline, etc).
async function logSubject(uuid: string): Promise<{ subject: string; subjectUuid: string }> {
  let subject = uuid;
  try {
    const meta = await vmMetaService.getVmMeta(uuid);
    if (meta?.name) subject = meta.name;
    else {
      const info = await vmService.getVmInfo(uuid);
      subject = info.name;
    }
  } catch { /* fall back to UUID */ }
  return { subject, subjectUuid: uuid };
}

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
    // Map UUID -> friendly name. Live VMs are the source of truth for "still
    // defined"; vmMeta gives us the display label even when libvirt has
    // already forgotten the VM (e.g. operator did `virsh undefine` directly).
    const definedUuids = new Set<string>();
    try {
      const vms = await vmService.listVmsRaw();
      for (const v of vms) definedUuids.add(v.id);
    } catch { /* libvirt unavailable */ }

    let entries: string[] = [];
    try {
      entries = await fs.readdir(config.vmsDir);
    } catch { /* vms dir not created yet */ }

    const disks: Array<{ vmUuid: string; vmName: string; filename: string; sizeGb: number; vmExists: boolean }> = [];

    for (const entry of entries) {
      const vmDir = path.join(config.vmsDir, entry);
      try {
        const s = await fs.stat(vmDir);
        if (!s.isDirectory()) continue;
      } catch { continue; }

      // Reject anything that doesn't look like a UUID — leftover cruft from
      // manual operator action shouldn't be surfaced as if it were a VM.
      let vmUuid: string;
      try { vmUuid = validateVmUuid(entry); } catch { continue; }

      // Resolve a friendly name: live VM > name.txt marker > vmMeta. Falls
      // back to the UUID if everything else fails.
      let displayName = vmUuid;
      try {
        const txt = await fs.readFile(path.join(vmDir, 'name.txt'), 'utf8');
        const trimmed = txt.trim();
        if (trimmed) displayName = trimmed;
      } catch { /* no marker — try meta */ }
      if (displayName === vmUuid) {
        try {
          const meta = await vmMetaService.getVmMeta(vmUuid);
          if (meta?.name) displayName = meta.name;
        } catch { /* fall through */ }
      }

      let files: string[] = [];
      try { files = await fs.readdir(vmDir); } catch { continue; }

      for (const file of files.filter((f) => f.endsWith('.qcow2'))) {
        try {
          const fileStat = await fs.stat(path.join(vmDir, file));
          disks.push({
            vmUuid,
            vmName: displayName,
            filename: file,
            sizeGb: Math.round((fileStat.size / 1_073_741_824) * 100) / 100,
            vmExists: definedUuids.has(vmUuid),
          });
        } catch { continue; }
      }
    }

    res.json({ disks });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// Delete an orphaned VM directory (qcow2 disks left behind after a
// `keep storage` VM delete, or after a manual `virsh undefine`). Refuses if
// libvirt still knows the VM, so this can never wipe storage out from under a
// running domain.
vmsRouter.delete('/disks/:uuid', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid } = req.params;
  try {
    let stillDefined = false;
    try {
      const vms = await vmService.listVmsRaw();
      stillDefined = vms.some((v) => v.id === uuid);
    } catch { /* libvirt unavailable — treat as not defined */ }
    if (stillDefined) {
      return res.status(409).json({ error: `VM "${uuid}" is still defined; delete the VM first` });
    }

    await storageService.deleteVmDir(uuid);
    await deleteCloudInitArtifacts(uuid);

    void logService.appendLog({ type: 'vm.disk.orphan.delete', subject: uuid, subjectUuid: uuid, status: 'success', output: '', durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.disk.orphan.delete', subject: uuid, subjectUuid: uuid, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.get('/:uuid', requireUuidParam, async (req, res) => {
  try {
    const vm = await vmService.getVmInfo(req.params.uuid);
    res.json({ vm });
  } catch (err: unknown) {
    res.status(404).json({ error: String(err) });
  }
});

vmsRouter.get('/:uuid/meta', requireUuidParam, async (req, res) => {
  try {
    const meta = await vmMetaService.getVmMeta(req.params.uuid);

    let ip: string | null = null;
    if (meta?.networks) {
      const primaryAlloc = meta.networks.find((n) => n.isPrimary);
      ip = primaryAlloc?.ip ?? null;
    }

    if (!ip) {
      try {
        const stdout = await virsh(['domifaddr', validateVmUuid(req.params.uuid), '--source', 'arp']);
        const match = stdout.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/\d+/);
        if (match) ip = match[1];
      } catch { /* VM not running or no lease yet */ }
    }

    // Strip the guest password — it's fetched on demand via /credentials so it
    // doesn't ride along in the routine meta poll, the React Query cache, or
    // any incidental request log.
    const safeMeta = meta ? (() => {
      const { password: _omit, ...rest } = meta;
      return rest;
    })() : null;
    res.json({ meta: safeMeta, ip });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.get('/:uuid/credentials', requireUuidParam, async (req, res) => {
  try {
    const meta = await vmMetaService.getVmMeta(req.params.uuid);
    if (!meta) {
      res.status(404).json({ error: 'VM metadata not found' });
      return;
    }
    res.json({ username: meta.username, password: meta.password });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.get('/:uuid/ifaddrs', requireUuidParam, async (req, res) => {
  try {
    const ips = await vmService.getVmInterfaceIps(req.params.uuid);
    res.json({ ips });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.get('/:uuid/reservations', requireUuidParam, async (req, res) => {
  try {
    const reservations = await portForwardService.getReservationsForVm(req.params.uuid);
    res.json({ reservations });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.get('/:uuid/port-forwards', requireUuidParam, async (req, res) => {
  try {
    const forwards = await portForwardService.getPortForwardsForVm(req.params.uuid);
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
      networks, cloudInit, cpuMode, nicModel, firmware, secureBoot, vtpm,
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
      firmware?: FirmwareMode;
      secureBoot?: boolean;
      vtpm?: boolean;
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

    // Libvirt enforces uniqueness on the user-typed name. Catch the conflict
    // here rather than waiting for `virsh define` to fail mid-way.
    try {
      await vmService.getVmInfo(name);
      return res.status(409).json({ error: `A VM named "${name}" already exists` });
    } catch {
      // expected — VM does not exist yet
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

    // Generate the VM's storage identity up front so every downstream
    // artefact (disk dir, NVRAM, cloud-init seed, domain XML) is keyed on it
    // before any qemu-img call writes a single byte. Recreating a VM with the
    // same friendly name now never collides with leftover storage from a
    // previous incarnation — each VM gets its own UUID directory.
    const uuid = randomUUID();

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
        await networkService.allocateSpecificIp(req.networkId, uuid, mac, req.staticIp);
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

    const nvramPath = path.join(config.vmsDir, uuid, `${uuid}-nvram.fd`);
    const firmwareOpts = { firmware, secureBoot, nvramPath, vtpm };

    if (isIsoInstall) {
      diskPath = await storageService.createBlankPrimaryDisk(uuid, diskGb, trace);
      const installIsoPath = path.join(config.isosDir, isoFilename!);
      domainXml = buildDomainXml({ uuid, name, cpus, memoryMb, diskPath, installIsoPath, nics: nicDefinitions, cpuMode, ...firmwareOpts });
    } else {
      diskPath = await storageService.createVmDisk(uuid, templateFilename!, diskGb, trace);
      const hostPubKey = await getHostSshPublicKey();
      const sshKeys = [...(cloudInit!.sshKeys ?? [])];
      if (hostPubKey && !sshKeys.includes(hostPubKey)) sshKeys.push(hostPubKey);
      const cloudInitIsoPath = await buildCloudInitIso(uuid, { ...cloudInit!, sshKeys, nics: nicCloudInit }, trace);
      domainXml = buildDomainXml({ uuid, name, cpus, memoryMb, diskPath, cloudInitIsoPath, nics: nicDefinitions, cpuMode, ...firmwareOpts });
    }

    // name.txt makes UUID-named directories operator-readable: someone sshing
    // into the host and `ls`-ing $vmsDir gets a quick map back to friendly
    // names without going through libvirt or the dashboard.
    await storageService.writeVmNameMarker(uuid, name);

    const xmlPath = path.join(config.cloudInitDir, `${uuid}-domain.xml`);
    await fs.writeFile(xmlPath, domainXml, 'utf8');
    await vmService.defineVm(xmlPath, trace);

    await vmMetaService.saveVmMeta({
      uuid,
      name,
      username: cloudInit?.username ?? '',
      password: cloudInit?.password ?? '',
      networks: metaNetworks,
      createdAt: new Date().toISOString(),
      ...(templateFilename ? { sourceTemplateFilename: templateFilename } : {}),
    });

    void logService.appendLog({
      type: 'vm.create',
      subject: name,
      subjectUuid: uuid,
      status: 'success',
      output: formatTrace(trace),
      durationMs: Date.now() - start,
    });

    res.status(201).json({ uuid, name });
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

// Rename VM. Storage paths, firewall chains, metrics rows, port-forwards,
// and IP allocations are all keyed on UUID — none of them need rewriting.
// Rename touches just the libvirt domain `<name>` element, the vmMeta record,
// and the on-disk name.txt marker.
vmsRouter.put('/:uuid/rename', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid } = req.params;
  const { newName } = req.body as { newName?: string };

  if (!newName || typeof newName !== 'string') return res.status(400).json({ error: 'newName is required' });
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(newName)) {
    return res.status(400).json({ error: 'VM name must be 1–80 characters: letters, numbers, hyphens, underscores only' });
  }

  try {
    const vm = await vmService.getVmInfo(uuid);
    if (vm.status !== 'stopped') return res.status(400).json({ error: 'VM must be stopped before renaming' });
    if (newName === vm.name) return res.status(400).json({ error: 'New name is the same as the current name' });

    // Check new name is not already taken (libvirt enforces name uniqueness)
    try {
      await vmService.getVmInfo(newName);
      return res.status(409).json({ error: `A VM named "${newName}" already exists` });
    } catch { /* expected */ }

    const safeUuid = validateVmUuid(uuid);
    const safeNewName = validateVmName(newName);
    // Dump current XML, replace <name> element, write to tmpfile.
    const xml = await virsh(['dumpxml', safeUuid]);
    const updatedXml = xml.replace(/<name>[^<]*<\/name>/, `<name>${safeNewName}</name>`);
    const tmpFile = path.join(os.tmpdir(), `virtpilot-rename-${randomUUID()}.xml`);
    await fs.writeFile(tmpFile, updatedXml, 'utf8');

    try {
      // `virsh define` on an XML with an existing <uuid> updates the
      // libvirt domain in place — no undefine/redefine cycle needed, and
      // NVRAM stays put because its path is UUID-keyed.
      await virsh(['define', tmpFile]);
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }

    await vmMetaService.setVmMetaName(uuid, newName);
    await storageService.writeVmNameMarker(uuid, newName);

    void logService.appendLog({ type: 'vm.rename', subject: vm.name, subjectUuid: uuid, status: 'success', output: `Renamed to ${newName}`, durationMs: Date.now() - start });
    res.json({ ok: true, newName });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.rename', subject: uuid, subjectUuid: uuid, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.delete('/:uuid', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid } = req.params;
  const log = await logSubject(uuid);
  try {
    // Default `deleteStorage=true`: a VM the user just deleted shouldn't leave
    // multi-GB qcow2 disks lying around. Pass `?deleteStorage=false` to keep them.
    const deleteStorage = req.query.deleteStorage !== 'false';
    const output = await vmService.deleteVm(uuid, deleteStorage);
    if (deleteStorage) {
      await storageService.deleteVmDir(uuid);
    }
    // Cloud-init artefacts (seed.iso, domain.xml, per-VM cloud-init dir) are
    // always cleaned — they're VirtPilot-internal scaffolding, never user data.
    await deleteCloudInitArtifacts(uuid);
    await networkService.deallocateVmIps(uuid);
    await portForwardService.deletePortForwardsForVm(uuid);
    await vmMetaService.deleteVmMeta(uuid);
    await firewallService.deleteFirewallConfig(uuid);
    vmMetricsService.deleteVmMetrics(uuid);
    void logService.appendLog({ type: 'vm.delete', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.delete', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.post('/:uuid/start', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid } = req.params;
  const log = await logSubject(uuid);
  try {
    const output = await vmService.startVm(uuid);
    void logService.appendLog({ type: 'vm.start', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.start', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

// Accept `force` from either the query string (legacy) or the JSON body so
// callers don't have to know the difference. Treat the boolean `true` and
// the string `"true"` as equivalent.
function readForceFlag(req: { query: { force?: unknown }; body?: { force?: unknown } }): boolean {
  const q = req.query.force;
  const b = req.body?.force;
  return q === 'true' || q === true || b === true || b === 'true';
}

vmsRouter.post('/:uuid/stop', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid } = req.params;
  const force = readForceFlag(req);
  const log = await logSubject(uuid);
  try {
    const output = await vmService.stopVm(uuid, force);
    void logService.appendLog({ type: force ? 'vm.stop.force' : 'vm.stop', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: force ? 'vm.stop.force' : 'vm.stop', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.post('/:uuid/reboot', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid } = req.params;
  const force = readForceFlag(req);
  const log = await logSubject(uuid);
  try {
    const output = force ? await vmService.hardRebootVm(uuid) : await vmService.rebootVm(uuid);
    void logService.appendLog({ type: force ? 'vm.reboot.force' : 'vm.reboot', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: force ? 'vm.reboot.force' : 'vm.reboot', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

// Disks
vmsRouter.post('/:uuid/disks', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid } = req.params;
  const log = await logSubject(uuid);
  try {
    const { sizeGb, target } = req.body;
    const vm = await vmService.getVmInfo(uuid);
    const existingExtras = vm.disks.filter((d) => d.target.startsWith('vd') && d.target !== 'vda').length;
    const storageTrace: TraceEntry[] = [];
    const diskPath = await storageService.createBlankDisk(uuid, existingExtras + 1, sizeGb ?? 20, storageTrace);
    const assignedTarget = target ?? `vd${String.fromCharCode(98 + existingExtras)}`;
    const virshOutput = await vmService.attachDisk(uuid, diskPath, assignedTarget);
    const output = [formatTrace(storageTrace), virshOutput].filter(Boolean).join('\n\n');
    void logService.appendLog({ type: 'vm.disk.attach', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true, diskPath });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.disk.attach', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.delete('/:uuid/disks/:target', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid, target } = req.params;
  const log = await logSubject(uuid);
  try {
    const output = await vmService.detachDisk(uuid, target);
    void logService.appendLog({ type: 'vm.disk.detach', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.disk.detach', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

// CDROMs
vmsRouter.post('/:uuid/cdrom', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid } = req.params;
  const log = await logSubject(uuid);
  try {
    const { isoFilename, target } = req.body;
    const isoPath = path.join(config.isosDir, isoFilename);
    const output = await vmService.attachCdrom(uuid, isoPath, target ?? 'sdb');
    void logService.appendLog({ type: 'vm.cdrom.attach', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.cdrom.attach', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.delete('/:uuid/cdrom/:target', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid, target } = req.params;
  const log = await logSubject(uuid);
  try {
    const output = await vmService.detachCdrom(uuid, target);
    void logService.appendLog({ type: 'vm.cdrom.detach', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.cdrom.detach', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

// Boot Order
vmsRouter.get('/:uuid/boot-order', requireUuidParam, async (req, res) => {
  try {
    const bootOrder = await vmService.getBootOrder(req.params.uuid);
    res.json({ bootOrder });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.put('/:uuid/boot-order', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid } = req.params;
  const log = await logSubject(uuid);
  try {
    const { bootOrder } = req.body as { bootOrder: string[] };
    if (!Array.isArray(bootOrder)) return res.status(400).json({ error: 'bootOrder must be an array' });
    if (bootOrder.length > 0) {
      const vm = await vmService.getVmInfo(uuid);
      const validTargets = new Set(vm.disks.map((d) => d.target));
      const unknown = bootOrder.filter((t) => !validTargets.has(t));
      if (unknown.length > 0) {
        return res.status(400).json({
          error: `Unknown disk targets in bootOrder: ${unknown.join(', ')}. Valid targets are: ${[...validTargets].join(', ')}`,
        });
      }
    }
    const output = await vmService.setBootOrder(uuid, bootOrder);
    void logService.appendLog({ type: 'vm.boot-order.set', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.boot-order.set', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.post('/:uuid/boot-once', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid } = req.params;
  const log = await logSubject(uuid);
  try {
    const { device } = req.body as { device: 'cdrom' | 'hd' };
    if (!device) return res.status(400).json({ error: 'device is required' });
    const output = await vmService.startVmBootOnce(uuid, device);
    void logService.appendLog({ type: 'vm.boot-once', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.boot-once', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

// NICs
vmsRouter.post('/:uuid/nics', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid } = req.params;
  const log = await logSubject(uuid);
  try {
    const { networkId, model, staticIp, inboundKbps, outboundKbps } = req.body as {
      networkId: string;
      model?: string;
      staticIp?: string;
      inboundKbps?: number;
      outboundKbps?: number;
    };
    if (!networkId) return res.status(400).json({ error: 'networkId is required' });

    const network = await networkService.getNetwork(networkId);
    if (!network) return res.status(400).json({ error: `Network ${networkId} not found` });

    const mac = generateMac();

    let allocatedIp: string | undefined;
    if ((network.type === 'bridge' || network.type === 'existing-bridge') && network.ipMode === 'static') {
      if (!staticIp) return res.status(400).json({ error: `staticIp required for static network "${network.name}"` });
      await networkService.allocateSpecificIp(networkId, uuid, mac, staticIp);
      allocatedIp = staticIp;
    }

    const bandwidth = (inboundKbps && inboundKbps > 0) || (outboundKbps && outboundKbps > 0)
      ? { inboundKbps, outboundKbps }
      : undefined;
    const output = await vmService.attachNic(uuid, network.bridge, model ?? 'virtio', mac, bandwidth);

    const meta = await vmMetaService.getVmMeta(uuid);
    if (meta) {
      await vmMetaService.saveVmMeta({
        ...meta,
        networks: [...(meta.networks ?? []), { networkId, mac, ip: allocatedIp, isPrimary: false }],
      });
    }

    void logService.appendLog({ type: 'vm.nic.attach', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true, mac });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.nic.attach', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.delete('/:uuid/nics/:mac', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid, mac } = req.params;
  const log = await logSubject(uuid);
  try {
    const output = await vmService.detachNic(uuid, mac);

    const meta = await vmMetaService.getVmMeta(uuid);
    if (meta?.networks) {
      const alloc = meta.networks.find((n) => n.mac === mac);
      if (alloc?.ip) await networkService.deallocateByMac(mac);
      await vmMetaService.saveVmMeta({
        ...meta,
        networks: meta.networks.filter((n) => n.mac !== mac),
      });
    }

    void logService.appendLog({ type: 'vm.nic.detach', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.nic.detach', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.put('/:uuid/nics/:mac/bandwidth', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid, mac } = req.params;
  const log = await logSubject(uuid);
  try {
    const { inboundKbps, outboundKbps } = req.body as { inboundKbps?: number; outboundKbps?: number };
    const inb = typeof inboundKbps === 'number' && inboundKbps > 0 ? Math.floor(inboundKbps) : 0;
    const outb = typeof outboundKbps === 'number' && outboundKbps > 0 ? Math.floor(outboundKbps) : 0;
    const output = await vmService.setNicBandwidth(uuid, mac, { inboundKbps: inb, outboundKbps: outb });
    void logService.appendLog({ type: 'vm.nic.bandwidth', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true, inboundKbps: inb, outboundKbps: outb });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.nic.bandwidth', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

// Snapshots
vmsRouter.get('/:uuid/snapshots', requireUuidParam, async (req, res) => {
  try {
    const snapshots = await vmService.listSnapshots(req.params.uuid);
    res.json({ snapshots });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.post('/:uuid/snapshots', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid } = req.params;
  const log = await logSubject(uuid);
  try {
    const { name: snapshotName, description } = req.body as { name: string; description?: string };
    if (!snapshotName) return res.status(400).json({ error: 'name is required' });
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(snapshotName)) {
      return res.status(400).json({ error: 'Snapshot name may only contain letters, numbers, hyphens, and underscores' });
    }
    const output = await vmService.createSnapshot(uuid, snapshotName, description);
    void logService.appendLog({ type: 'vm.snapshot.create', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.snapshot.create', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.delete('/:uuid/snapshots/:snapshot', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid, snapshot } = req.params;
  const metadataOnly = req.query.metadataOnly === 'true';
  const log = await logSubject(uuid);
  try {
    const output = await vmService.deleteSnapshot(uuid, snapshot, { metadataOnly });
    void logService.appendLog({ type: 'vm.snapshot.delete', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.snapshot.delete', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.post('/:uuid/snapshots/:snapshot/revert', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid, snapshot } = req.params;
  const log = await logSubject(uuid);
  try {
    const output = await vmService.revertSnapshot(uuid, snapshot);
    void logService.appendLog({ type: 'vm.snapshot.revert', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.snapshot.revert', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.post('/:uuid/snapshots/:snapshot/to-template', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid, snapshot } = req.params;
  const log = await logSubject(uuid);
  try {
    const { templateName } = req.body as { templateName?: string };
    if (!templateName?.trim()) return res.status(400).json({ error: 'templateName is required' });
    const safeName = templateName.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
    const filename = `${safeName}.qcow2`;

    // Source template recorded at VM-create time is the authoritative answer —
    // unlike walking the qcow2 backing chain, it stays correct when external
    // snapshots have inserted overlay layers between the active disk and the
    // original template.
    let sourceTemplateFilename: string | undefined;
    try {
      const meta = await vmMetaService.getVmMeta(uuid);
      if (meta?.sourceTemplateFilename) {
        sourceTemplateFilename = meta.sourceTemplateFilename;
      } else {
        const disks = await vmService.getVmDisks(uuid);
        const primaryDisk = disks.find((d) => d.target === 'vda' && d.source);
        if (primaryDisk?.source) {
          const stdout = await run('qemu-img', ['info', '--output=json', primaryDisk.source]);
          const info = JSON.parse(stdout) as { 'backing-filename'?: string };
          const backingFile = info['backing-filename'];
          if (backingFile) {
            const candidate = path.basename(backingFile);
            if (candidate.match(/\.(qcow2|img)$/)) sourceTemplateFilename = candidate;
          }
        }
      }
    } catch { /* non-fatal — proceed without logo hint */ }

    const output = await vmService.exportSnapshotAsTemplate(uuid, snapshot, filename);
    await storageService.setTemplateDisplayName(filename, templateName.trim());
    void logService.appendLog({ type: 'vm.snapshot.export', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true, filename, sourceTemplateFilename });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.snapshot.export', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

// Firewall
vmsRouter.get('/:uuid/firewall', requireUuidParam, async (req, res) => {
  try {
    const cfg = await firewallService.getFirewallConfig(req.params.uuid);
    res.json(cfg);
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.put('/:uuid/firewall', requireUuidParam, async (req, res) => {
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
    await firewallService.saveFirewallConfig(req.params.uuid, cfg);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.post('/:uuid/firewall/apply', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid } = req.params;
  const log = await logSubject(uuid);
  try {
    let ip: string | null = null;
    const meta = await vmMetaService.getVmMeta(uuid);
    if (meta?.networks) {
      const primary = meta.networks.find((n) => n.isPrimary);
      ip = primary?.ip ?? null;
    }
    if (!ip) {
      try {
        const stdout = await virsh(['domifaddr', validateVmUuid(uuid), '--source', 'arp']);
        const match = stdout.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/\d+/);
        if (match) ip = match[1];
      } catch { /* VM not running */ }
    }
    if (!ip) return res.status(400).json({ error: 'Could not resolve VM IP — ensure the VM is running' });
    const cfg = await firewallService.getFirewallConfig(uuid);
    await firewallService.applyFirewallRules(uuid, ip, cfg);
    void logService.appendLog({ type: 'vm.firewall.apply', ...log, status: 'success', output: `Applied ${cfg.rules.length} rule(s) to ${ip}`, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.firewall.apply', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

// Autostart
vmsRouter.put('/:uuid/autostart', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid } = req.params;
  const log = await logSubject(uuid);
  try {
    const { enabled } = req.body as { enabled: boolean };
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
    const output = await vmService.setAutostart(uuid, enabled);
    void logService.appendLog({ type: 'vm.autostart.set', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.autostart.set', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

// Disk resize
vmsRouter.post('/:uuid/disks/:target/resize', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid, target } = req.params;
  const log = await logSubject(uuid);
  try {
    const { addGb } = req.body as { addGb: number };
    if (!addGb || addGb <= 0) return res.status(400).json({ error: 'addGb must be a positive number' });
    const output = await vmService.resizeDisk(uuid, target, addGb);
    void logService.appendLog({ type: 'vm.disk.resize', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.disk.resize', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

// Resource editing
vmsRouter.put('/:uuid/resources', requireUuidParam, async (req, res) => {
  const start = Date.now();
  const { uuid } = req.params;
  const log = await logSubject(uuid);
  try {
    const { cpus, memoryMb } = req.body as { cpus: number; memoryMb: number };
    if (!cpus || cpus < 1) return res.status(400).json({ error: 'cpus must be ≥ 1' });
    if (!memoryMb || memoryMb < 128) return res.status(400).json({ error: 'memoryMb must be ≥ 128' });
    const vm = await vmService.getVmInfo(uuid);
    if (vm.status !== 'stopped') return res.status(400).json({ error: 'VM must be stopped before editing resources' });
    const output = await vmService.updateVmResources(uuid, cpus, memoryMb);
    void logService.appendLog({ type: 'vm.resources.update', ...log, status: 'success', output, durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.resources.update', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

// Per-VM stats
vmsRouter.get('/:uuid/stats', requireUuidParam, async (req, res) => {
  try {
    const stats = await vmService.getVmStats(req.params.uuid);
    if (!stats) return res.status(503).json({ error: 'VM is not running or stats unavailable' });
    res.json(stats);
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// Per-VM persistent metrics history (SQLite-backed)
vmsRouter.get('/:uuid/metrics', requireUuidParam, (req, res) => {
  const range = req.query.range === '24h' ? '24h' : '1h';
  try {
    const history = vmMetricsService.getVmMetricsHistory(req.params.uuid, range);
    res.json({ range, history });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Device passthrough ───────────────────────────────────────────────────────

vmsRouter.post('/:uuid/devices', requireUuidParam, async (req, res) => {
  const { uuid } = req.params;
  const { deviceId } = req.body as { deviceId?: string };
  if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

  const start = Date.now();
  const trace: TraceEntry[] = [];
  const log = await logSubject(uuid);
  try {
    await deviceService.attachDevice(uuid, deviceId, trace);
    void logService.appendLog({ type: 'vm.device.attach', ...log, status: 'success', output: formatTrace(trace), durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.device.attach', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});

vmsRouter.delete('/:uuid/devices/:deviceId', requireUuidParam, async (req, res) => {
  const { uuid, deviceId } = req.params;
  const start = Date.now();
  const trace: TraceEntry[] = [];
  const log = await logSubject(uuid);
  try {
    await deviceService.detachDevice(uuid, deviceId, trace);
    void logService.appendLog({ type: 'vm.device.detach', ...log, status: 'success', output: formatTrace(trace), durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err: unknown) {
    void logService.appendLog({ type: 'vm.device.detach', ...log, status: 'error', output: String(err), durationMs: Date.now() - start });
    res.status(500).json({ error: String(err) });
  }
});
