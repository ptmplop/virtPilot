// Builds a brand-new VM out of an existing one.
//
// Two callers, one mechanism:
//   • cloneVm            — copies a live (or stopped) VM's disks
//   • createVmFromBackup — materialises a backup's disks, flattening any
//                          incremental chain on the way out
//
// Both end up doing the same thing: take a domain XML that describes a working
// machine, re-key everything that must be unique on a host (UUID, name, MAC
// addresses, NVRAM path, disk paths), regenerate cloud-init so the guest comes
// up with its own identity, and hand the result to `virsh define`.

import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import * as vmService from './vmService.js';
import * as storageService from './storageService.js';
import * as networkService from './networkService.js';
import * as vmMetaService from './vmMetaService.js';
import * as backupService from './backupService.js';
import { copyVmDisks } from './diskCopyService.js';
import { buildCloudInitIso, getHostSshPublicKey, type NicCloudInit } from './cloudInitService.js';
import { generateMac } from './xmlBuilder.js';
import { type TraceEntry, formatTrace } from './traceService.js';
import { validateVmName, validateVmUuid, validateMac, escapeXml } from '../lib/validate.js';

// ─── Domain XML derivation ────────────────────────────────────────────────────

export interface DerivedNic {
  oldMac: string;
  newMac: string;
}

export interface DeriveDomainXmlOptions {
  sourceXml: string;
  newUuid: string;
  newName: string;
  /** libvirt disk target (`vda`) -> absolute path of the new VM's image. */
  diskPathByTarget: Map<string, string>;
  nicMacs: DerivedNic[];
  /** Where the new VM's UEFI variables live. Omit for a BIOS domain. */
  nvramPath?: string;
  /** Freshly generated seed to attach, or null to eject the inherited one. */
  cloudInitIsoPath: string | null;
}

// Matches a <source .../> element in either self-closing or container form.
// libvirt emits the latter when the source carries a <seclabel> child.
const SOURCE_ELEMENT = /<source\b[^>]*(?:\/>|>[\s\S]*?<\/source>)/;

/**
 * Rewrites a domain XML so it describes a *different* machine.
 *
 * Everything a host enforces uniqueness on has to change, or the define will be
 * rejected (name, UUID) or the two VMs will fight at runtime (MAC addresses,
 * NVRAM, VNC port, tap device names).
 */
export function deriveDomainXml(opts: DeriveDomainXmlOptions): string {
  let xml = opts.sourceXml;

  // The cached backing chain describes the *source's* images. The new VM's
  // disks are standalone copies, so carrying it over hands libvirt a chain the
  // file does not have — the same stale-cache condition that makes qemu refuse
  // to open a disk with `Failed to get "write" lock`. Drop it and let libvirt
  // re-probe from the images.
  xml = xml.replace(/[ \t]*<backingStore\b[^>]*(?:\/>|>[\s\S]*?<\/backingStore>)\n?/g, '');
  // Security labels and device aliases belong to the domain that generated
  // them. libvirt rejects a user-supplied alias that isn't `ua-`-prefixed, and
  // regenerates both for a new domain anyway.
  xml = xml.replace(/[ \t]*<seclabel\b[^>]*(?:\/>|>[\s\S]*?<\/seclabel>)\n?/g, '');
  xml = xml.replace(/[ \t]*<alias\s+name=['"][^'"]*['"]\s*\/>\n?/g, '');
  // Tap device names are per-host, and two domains claiming `vnet0` collide.
  xml = xml.replace(/[ \t]*<target\s+dev=['"]vnet\d+['"]\s*\/>\n?/g, '');

  xml = xml.replace(/<name>[^<]*<\/name>/, () => `<name>${escapeXml(opts.newName)}</name>`);
  xml = xml.replace(/<uuid>[^<]*<\/uuid>/, () => `<uuid>${escapeXml(opts.newUuid)}</uuid>`);

  if (opts.nvramPath) {
    xml = xml.replace(
      /(<nvram\b[^>]*>)[^<]*(<\/nvram>)/,
      (_m, open: string, close: string) => `${open}${escapeXml(opts.nvramPath!)}${close}`,
    );
  }

  // A fixed VNC port would clash with the source VM the moment both run.
  xml = xml.replace(/<graphics\b[^>]*>/g, (tag) => {
    let out = tag.replace(/\bport=['"][^'"]*['"]/, 'port="-1"');
    out = /\bautoport=/.test(out)
      ? out.replace(/\bautoport=['"][^'"]*['"]/, 'autoport="yes"')
      : out.replace(/^<graphics\b/, '<graphics autoport="yes"');
    return out;
  });

  xml = xml.replace(/<mac\s+address=['"]([^'"]+)['"]\s*\/>/g, (whole, mac: string) => {
    const mapped = opts.nicMacs.find((n) => n.oldMac.toLowerCase() === mac.toLowerCase());
    return mapped ? `<mac address="${escapeXml(mapped.newMac)}"/>` : whole;
  });

  xml = xml.replace(/<disk\b[^>]*>[\s\S]*?<\/disk>/g, (block) => {
    const target = block.match(/<target\s+dev=['"]([^'"]+)['"]/)?.[1];
    const isCdrom = /^<disk\b[^>]*device=['"]cdrom['"]/.test(block);

    if (isCdrom) {
      const currentSource = block.match(/<source\s+file=['"]([^'"]+)['"]/)?.[1];
      const isInheritedSeed = !!currentSource && currentSource.startsWith(config.cloudInitDir + path.sep);
      if (isInheritedSeed) {
        // Pointing the new VM at the source's seed would leave it depending on
        // a file that disappears when the source VM is deleted.
        return opts.cloudInitIsoPath
          ? block.replace(SOURCE_ELEMENT, `<source file="${escapeXml(opts.cloudInitIsoPath)}"/>`)
          : block.replace(SOURCE_ELEMENT, '');
      }
      // Any other CD is a shared, read-only ISO in a storage dir — both VMs can
      // reference it safely, so the operator's setup is preserved.
      return block;
    }

    if (!target) return block;
    const newPath = opts.diskPathByTarget.get(target);
    if (!newPath) return block;
    return block.replace(SOURCE_ELEMENT, `<source file="${escapeXml(newPath)}"/>`);
  });

  return xml;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * VM names accept characters hostnames do not (`_`, leading digits are fine but
 * leading/trailing dots and hyphens are not). Coerce rather than reject, so
 * cloning `web_01` doesn't fail on a technicality.
 */
export function toHostname(name: string): string {
  const labels = name
    .split('.')
    .map((l) => l.replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+/, '').replace(/-+$/, '').slice(0, 63))
    .filter(Boolean);
  return labels.length > 0 ? labels.join('.') : 'vm';
}

function usesUefi(xml: string): boolean {
  return /<nvram\b/.test(xml);
}

interface DerivedNetworking {
  nicMacs: DerivedNic[];
  cloudInitNics: NicCloudInit[];
  metaNetworks: vmMetaService.VmNetworkAlloc[];
  warnings: string[];
}

/**
 * Gives every NIC a fresh MAC, and a fresh IP where the source held a static
 * allocation — two machines sharing either would take each other off the
 * network.
 */
async function deriveNetworking(
  sourceNics: Array<{ mac: string }>,
  sourceMeta: vmMetaService.VmMeta | null,
  newUuid: string,
): Promise<DerivedNetworking> {
  const nicMacs: DerivedNic[] = [];
  const cloudInitNics: NicCloudInit[] = [];
  const metaNetworks: vmMetaService.VmNetworkAlloc[] = [];
  const warnings: string[] = [];

  for (const [index, nic] of sourceNics.entries()) {
    const oldMac = validateMac(nic.mac);
    const newMac = generateMac();
    nicMacs.push({ oldMac, newMac });

    const alloc = sourceMeta?.networks?.find((n) => n.mac.toLowerCase() === oldMac.toLowerCase());
    const isPrimary = alloc?.isPrimary ?? index === 0;
    const network = alloc?.networkId ? await networkService.getNetwork(alloc.networkId) : null;

    const needsStatic =
      !!network &&
      (network.type === 'bridge' || network.type === 'existing-bridge') &&
      network.ipMode === 'static';

    if (needsStatic && alloc) {
      const status = await networkService.getNetworkIpStatus(alloc.networkId);
      const free = status.find((s) => !s.allocated && s.ip !== network!.gateway);
      if (!free) {
        throw new Error(
          `Network "${network!.name}" has no free IP addresses left - free one before creating another VM on it`,
        );
      }
      await networkService.allocateSpecificIp(alloc.networkId, newUuid, newMac, free.ip);
      const { prefix } = networkService.parseCidr(network!.cidr);
      cloudInitNics.push({
        mac: newMac,
        isPrimary,
        ipConfig: { mode: 'static', ip: free.ip, prefix, gateway: network!.gateway, dns: network!.dns },
      });
      metaNetworks.push({ networkId: alloc.networkId, mac: newMac, ip: free.ip, isPrimary });
      if (alloc.ip && alloc.ip !== free.ip) {
        warnings.push(`NIC ${index + 1} was given ${free.ip} (the source VM keeps ${alloc.ip}).`);
      }
    } else {
      cloudInitNics.push({ mac: newMac, isPrimary, ipConfig: { mode: 'dhcp' } });
      if (alloc?.networkId) metaNetworks.push({ networkId: alloc.networkId, mac: newMac, isPrimary });
    }
  }

  // cloud-init's default route comes off the primary NIC; without exactly one,
  // the guest can come up with no gateway at all.
  if (cloudInitNics.length > 0 && !cloudInitNics.some((n) => n.isPrimary)) {
    cloudInitNics[0].isPrimary = true;
    if (metaNetworks[0]) metaNetworks[0].isPrimary = true;
  }

  return { nicMacs, cloudInitNics, metaNetworks, warnings };
}

// ─── Core provisioning ────────────────────────────────────────────────────────

export interface DiskPlacement {
  target: string;
  filename: string;
  destPath: string;
}

interface ProvisionOptions {
  sourceXml: string;
  /** Disks to give the new VM, keyed by the source's libvirt target. */
  disks: Array<{ target: string; filename: string }>;
  /** Writes the images. Called once with every resolved destination path. */
  copyDisks: (placements: DiskPlacement[]) => Promise<void>;
  sourceNics: Array<{ mac: string }>;
  sourceMeta: vmMetaService.VmMeta | null;
  newName: string;
  storageDirId?: string;
  /** Rebuild the cloud-init seed so the guest takes on the new identity. */
  regenerateCloudInit: boolean;
  passwordOverride?: string;
  sourceTemplateFilename?: string;
}

export interface ProvisionResult {
  uuid: string;
  name: string;
  output: string;
  warnings: string[];
}

async function provisionDerivedVm(opts: ProvisionOptions): Promise<ProvisionResult> {
  const newName = validateVmName(opts.newName);

  // libvirt enforces name uniqueness; catch it here rather than half-way
  // through, once disks have already been written.
  const nameTaken = await vmService.getVmInfo(newName).then(() => true).catch(() => false);
  if (nameTaken) throw new Error(`A VM named "${newName}" already exists`);

  if (opts.disks.length === 0) throw new Error('The source has no disks to copy');

  const uuid = randomUUID();
  const trace: TraceEntry[] = [];
  const warnings: string[] = [];

  try {
    await storageService.ensureDirs();
    await storageService.ensureSystemVmDir(uuid);

    // ── Disks ───────────────────────────────────────────────────────────────
    const placements: DiskPlacement[] = [];
    for (const disk of opts.disks) {
      const destPath = await storageService.prepareVmDiskPath(uuid, disk.filename, opts.storageDirId);
      placements.push({ target: disk.target, filename: disk.filename, destPath });
    }
    await opts.copyDisks(placements);

    // ── Networking ──────────────────────────────────────────────────────────
    const net = await deriveNetworking(opts.sourceNics, opts.sourceMeta, uuid);
    warnings.push(...net.warnings);

    // ── cloud-init ──────────────────────────────────────────────────────────
    // The seed's instance-id is the VM UUID, so a new UUID makes cloud-init
    // treat the guest as a new instance and re-apply hostname, network config
    // and credentials on first boot. That is what stops a clone coming up as a
    // second copy of the original.
    let cloudInitIsoPath: string | null = null;
    const meta = opts.sourceMeta;
    const canRegenerate = opts.regenerateCloudInit && !!meta?.username;
    if (opts.regenerateCloudInit && !meta?.username) {
      warnings.push('The source has no cloud-init credentials recorded, so no new seed was generated - the guest keeps its original hostname and login.');
    }
    if (canRegenerate) {
      const hostPubKey = await getHostSshPublicKey();
      const sshKeys = hostPubKey ? [hostPubKey] : [];
      cloudInitIsoPath = await buildCloudInitIso(
        uuid,
        {
          hostname: toHostname(newName),
          username: meta!.username,
          password: opts.passwordOverride ?? meta!.password,
          sshKeys,
          nics: net.cloudInitNics,
        },
        trace,
      );
    }

    // ── Domain XML ──────────────────────────────────────────────────────────
    const nvramPath = usesUefi(opts.sourceXml)
      ? path.join(storageService.getSystemVmDir(uuid), `${uuid}-nvram.fd`)
      : undefined;

    const domainXml = deriveDomainXml({
      sourceXml: opts.sourceXml,
      newUuid: uuid,
      newName,
      diskPathByTarget: new Map(placements.map((p) => [p.target, p.destPath])),
      nicMacs: net.nicMacs,
      nvramPath,
      cloudInitIsoPath,
    });

    const xmlPath = path.join(config.cloudInitDir, `${uuid}-domain.xml`);
    await fs.writeFile(xmlPath, domainXml, 'utf8');
    await vmService.defineVm(xmlPath, trace);

    await storageService.writeVmNameMarker(uuid, newName);
    await vmMetaService.saveVmMeta({
      uuid,
      name: newName,
      username: meta?.username ?? '',
      password: opts.passwordOverride ?? meta?.password ?? '',
      networks: net.metaNetworks,
      createdAt: new Date().toISOString(),
      ...(opts.sourceTemplateFilename ? { sourceTemplateFilename: opts.sourceTemplateFilename } : {}),
    });

    return { uuid, name: newName, output: formatTrace(trace), warnings };
  } catch (err) {
    // Roll back everything this call created. Without it a failure half-way
    // leaves multi-GB disks and an IP allocation attached to a VM that libvirt
    // never learned about.
    await rollbackPartialVm(uuid);
    throw err;
  }
}

async function rollbackPartialVm(uuid: string): Promise<void> {
  try {
    await vmService.deleteVm(uuid, false);
  } catch { /* never defined — nothing to undefine */ }
  await storageService.deleteVmDir(uuid).catch(() => {});
  await networkService.deallocateVmIps(uuid).catch(() => {});
  await vmMetaService.deleteVmMeta(uuid).catch(() => {});
  const seed = path.join(config.cloudInitDir, `${uuid}-seed.iso`);
  const domainXml = path.join(config.cloudInitDir, `${uuid}-domain.xml`);
  await Promise.all([
    fs.rm(path.join(config.cloudInitDir, uuid), { recursive: true, force: true }).catch(() => {}),
    fs.unlink(seed).catch(() => {}),
    fs.unlink(domainXml).catch(() => {}),
  ]);
}

// ─── Clone ────────────────────────────────────────────────────────────────────

export interface CloneVmOptions {
  sourceUuid: string;
  newName: string;
  storageDirId?: string;
  /** Give the clone its own hostname, credentials and IP. On by default. */
  regenerateCloudInit?: boolean;
  /** Set a different guest password on the clone. */
  password?: string;
}

// Two clones of the same running VM would each try to take their own snapshot
// or block job against it, and libvirt allows only one at a time.
const clonesInProgress = new Set<string>();

export function getClonesInProgress(): string[] {
  return [...clonesInProgress];
}

export async function cloneVm(opts: CloneVmOptions): Promise<ProvisionResult & { consistency: string }> {
  const sourceUuid = validateVmUuid(opts.sourceUuid);
  if (clonesInProgress.has(sourceUuid)) {
    throw new Error('A clone of this VM is already running - wait for it to finish');
  }
  clonesInProgress.add(sourceUuid);
  try {
    return await cloneVmInner(sourceUuid, opts);
  } finally {
    clonesInProgress.delete(sourceUuid);
  }
}

async function cloneVmInner(
  sourceUuid: string,
  opts: CloneVmOptions,
): Promise<ProvisionResult & { consistency: string }> {
  const source = await vmService.getVmInfo(sourceUuid);
  const sourceXml = await vmService.getVmXml(sourceUuid);
  const sourceMeta = await vmMetaService.getVmMeta(sourceUuid);
  const running = source.status === 'running';

  const copyable = source.disks.filter((d) => d.type === 'disk' && d.source);
  if (copyable.length === 0) throw new Error('The source VM has no disks to clone');

  const basenames = copyable.map((d) => path.basename(d.source));
  const duplicate = basenames.find((n, i) => basenames.indexOf(n) !== i);
  if (duplicate) {
    throw new Error(`Two of the source VM's disks are both named "${duplicate}" - cannot clone until one is renamed`);
  }
  const excludeTargets = source.disks.filter((d) => !copyable.includes(d)).map((d) => d.target);

  let consistency = 'offline';

  const result = await provisionDerivedVm({
    sourceXml,
    disks: copyable.map((d) => ({ target: d.target, filename: path.basename(d.source) })),
    copyDisks: async (placements) => {
      const copy = await copyVmDisks({
        vmUuid: sourceUuid,
        vmName: source.name,
        running,
        disks: placements.map((p) => ({
          target: p.target,
          sourcePath: copyable.find((d) => d.target === p.target)!.source,
          destPath: p.destPath,
        })),
        excludeTargets,
        // Cloning must never leave a checkpoint (and its dirty bitmap) behind on
        // the source VM — that is the backup engine's business, not this one's.
        snapshotLabel: `vpclone-${Date.now().toString(36)}`,
      });
      consistency = running ? (copy.consistent ? 'app-consistent' : 'crash-consistent') : 'offline';
    },
    sourceNics: source.nics,
    sourceMeta,
    newName: opts.newName,
    storageDirId: opts.storageDirId,
    regenerateCloudInit: opts.regenerateCloudInit ?? true,
    passwordOverride: opts.password,
    sourceTemplateFilename: sourceMeta?.sourceTemplateFilename,
  });

  return { ...result, consistency };
}

// ─── Restore into a new VM ────────────────────────────────────────────────────

export interface RestoreAsNewVmOptions {
  sourceVmUuid: string;
  backupId: string;
  newName: string;
  storageDirId?: string;
  regenerateCloudInit?: boolean;
  password?: string;
}

/**
 * Rebuilds a complete VM from a backup rather than overwriting an existing
 * one's disks — the path that turns backups into "recover the machine I
 * deleted" instead of only "roll this machine back".
 */
export async function createVmFromBackup(
  opts: RestoreAsNewVmOptions,
): Promise<ProvisionResult & { sourceVmName: string }> {
  const sourceVmUuid = validateVmUuid(opts.sourceVmUuid);
  const { manifest, bdir } = await backupService.openBackupForRestore(sourceVmUuid, opts.backupId);

  if (!manifest.libvirtXml) {
    throw new Error('This backup predates full-VM restore - its manifest has no domain definition to rebuild from');
  }
  if (manifest.disks.length === 0) throw new Error('Backup contains no disks');

  const sourceMeta = backupService.decodeMetaFromManifest(manifest.vmMeta);

  const result = await provisionDerivedVm({
    sourceXml: manifest.libvirtXml,
    disks: manifest.disks.map((d) => ({
      target: d.target,
      filename: backupService.assertSafeBackupDiskFilename(d.filename),
    })),
    copyDisks: async (placements) => {
      for (const p of placements) {
        // Flattens the incremental chain — the new VM gets one standalone image.
        await backupService.materialiseBackupDisk(path.join(bdir, p.filename), p.destPath);
      }
    },
    sourceNics: manifest.nics ?? [],
    sourceMeta,
    newName: opts.newName,
    storageDirId: opts.storageDirId,
    regenerateCloudInit: opts.regenerateCloudInit ?? true,
    passwordOverride: opts.password,
    sourceTemplateFilename: sourceMeta?.sourceTemplateFilename,
  });

  return { ...result, sourceVmName: manifest.vmName };
}
