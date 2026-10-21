// Reads the facts passthrough needs straight off the host: sysfs, procfs and a
// handful of one-shot tools (lspci, lsblk, ip, journalctl).
//
// This replaces one `virsh nodedev-dumpxml` per PCI function. A two-socket
// server has 200+ of them, nearly all chipset plumbing, and sysfs already holds
// everything libvirt would have told us plus what it doesn't (reset methods,
// BAR sizes, which disk or address a device carries for the host).
//
// Every read is allowed to fail: a missing file means "the kernel doesn't say",
// never a 500. The decisions made from these facts live in lib/hostDevices.ts.

import fs from 'fs/promises';
import path from 'path';
import { runSafe } from './safeExec.js';
import type { BlockFacts, DrmFacts, HostFacts, NetFacts, PciFacts, UsbFacts } from '../lib/hostFacts.js';

const PCI_ADDR_RE = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/;
const USB_PORT_RE = /^\d+-[\d.]+$/;
const USB_DEVICE_RE = /^(?:usb\d+|\d+-[\d.]+)$/;

async function readText(p: string): Promise<string | undefined> {
  try {
    return (await fs.readFile(p, 'utf8')).trim();
  } catch {
    return undefined;
  }
}

async function linkBase(p: string): Promise<string | undefined> {
  try {
    return path.basename(await fs.readlink(p));
  } catch {
    return undefined;
  }
}

async function realPath(p: string): Promise<string | undefined> {
  try {
    return await fs.realpath(p);
  } catch {
    return undefined;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listDir(p: string): Promise<string[]> {
  try {
    return await fs.readdir(p);
  } catch {
    return [];
  }
}

function hexId(v: string | undefined, width: number): string | undefined {
  if (!v) return undefined;
  const s = v.replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]+$/.test(s) ? s.padStart(width, '0') : undefined;
}

function intOrUndefined(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** The PCI device closest to the leaf of a sysfs device path. */
export function pciFromSysPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const parts = p.split('/').filter((x) => PCI_ADDR_RE.test(x));
  return parts[parts.length - 1];
}

/** The USB port closest to the leaf of a sysfs device path ('1-8.2'). */
export function usbPortFromSysPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const parts = p.split('/').filter((x) => USB_PORT_RE.test(x));
  return parts[parts.length - 1];
}

/** Memory BAR sizes from a PCI `resource` file (one "start end flags" line per resource). */
export function parseBarSizes(resource: string | undefined): number[] {
  if (!resource) return [];
  const sizes: number[] = [];
  const lines = resource.split('\n').slice(0, 6); // 0-5 are the BARs; 6 is the expansion ROM
  for (const line of lines) {
    const [startHex, endHex, flagsHex] = line.trim().split(/\s+/);
    if (!startHex || !endHex || !flagsHex) continue;
    try {
      const start = BigInt(startHex);
      const end = BigInt(endHex);
      const flags = BigInt(flagsHex);
      // IORESOURCE_MEM; I/O port BARs are tiny and never what limits a guest
      if ((flags & 0x200n) === 0n || end === 0n) continue;
      sizes.push(Number(end - start + 1n));
    } catch { /* malformed line */ }
  }
  return sizes;
}

/** `lspci -D -vmm -nn` → address → vendor and device names. */
export function parseLspciNames(out: string): Map<string, { vendorName?: string; deviceName?: string }> {
  const names = new Map<string, { vendorName?: string; deviceName?: string }>();
  for (const block of out.split(/\n\s*\n/)) {
    const field = (key: string) => block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
    const slot = field('Slot');
    if (!slot) continue;
    // "NVIDIA Corporation [10de]" → "NVIDIA Corporation"
    const strip = (v: string | undefined) => v?.replace(/\s*\[[0-9a-fA-F]{4}\]$/, '').trim() || undefined;
    names.set(slot.toLowerCase(), { vendorName: strip(field('Vendor')), deviceName: strip(field('Device')) });
  }
  return names;
}

async function scanPci(): Promise<PciFacts[]> {
  const base = '/sys/bus/pci/devices';
  const addresses = (await listDir(base)).filter((n) => PCI_ADDR_RE.test(n)).sort();
  const lspci = await runSafe('lspci', ['-D', '-vmm', '-nn'], { timeout: 15_000 });
  const names = lspci ? parseLspciNames(lspci) : new Map();

  return Promise.all(addresses.map(async (address): Promise<PciFacts> => {
    const dir = path.join(base, address);
    const [cls, vendor, device, subVendor, subDevice, driver, group, bootVga, reset, total, num, physfn, numa, resource, override, real] =
      await Promise.all([
        readText(path.join(dir, 'class')),
        readText(path.join(dir, 'vendor')),
        readText(path.join(dir, 'device')),
        readText(path.join(dir, 'subsystem_vendor')),
        readText(path.join(dir, 'subsystem_device')),
        linkBase(path.join(dir, 'driver')),
        linkBase(path.join(dir, 'iommu_group')),
        readText(path.join(dir, 'boot_vga')),
        readText(path.join(dir, 'reset_method')),
        readText(path.join(dir, 'sriov_totalvfs')),
        readText(path.join(dir, 'sriov_numvfs')),
        linkBase(path.join(dir, 'physfn')),
        readText(path.join(dir, 'numa_node')),
        readText(path.join(dir, 'resource')),
        readText(path.join(dir, 'driver_override')),
        realPath(dir),
      ]);

    // Header type (config offset 0x0e, low 7 bits): 1 = PCI-to-PCI bridge, 2 = CardBus bridge.
    // The first 64 bytes of config space are readable without privileges.
    let headerType: number | undefined;
    try {
      const config = await fs.readFile(path.join(dir, 'config'));
      if (config.length > 0x0e) headerType = config[0x0e] & 0x7f;
    } catch { /* unreadable */ }

    const classCode = hexId(cls, 6) ?? '000000';
    const chain = (real ?? '').split('/').filter((x) => PCI_ADDR_RE.test(x));
    const numaNode = intOrUndefined(numa);
    const name = names.get(address);

    return {
      address,
      classCode,
      vendorId: hexId(vendor, 4) ?? '0000',
      deviceId: hexId(device, 4) ?? '0000',
      subsystemVendorId: hexId(subVendor, 4),
      subsystemDeviceId: hexId(subDevice, 4),
      vendorName: name?.vendorName,
      deviceName: name?.deviceName,
      driver,
      iommuGroup: intOrUndefined(group),
      bootVga: bootVga === undefined ? undefined : bootVga === '1',
      resetMethods: reset === undefined ? undefined : reset.split(/\s+/).filter(Boolean),
      sriovTotalVfs: intOrUndefined(total),
      sriovNumVfs: intOrUndefined(num),
      physfn: physfn && PCI_ADDR_RE.test(physfn) ? physfn : undefined,
      numaNode: numaNode !== undefined && numaNode >= 0 ? numaNode : undefined,
      memoryBars: parseBarSizes(resource),
      driverOverride: override && override !== '(null)' ? override : undefined,
      headerType,
      // What VFIO exempts from group checks: bridges by header type, not by class. An LPC or host
      // bridge (class 06, header type 0) still counts as an endpoint.
      isBridge: headerType === undefined ? classCode.startsWith('0604') : headerType === 1 || headerType === 2,
      parent: chain.length >= 2 ? chain[chain.length - 2] : undefined,
    };
  }));
}

async function scanUsb(): Promise<UsbFacts[]> {
  const base = '/sys/bus/usb/devices';
  const entries = await listDir(base);
  const devices = entries.filter((n) => USB_DEVICE_RE.test(n)).sort();
  return Promise.all(devices.map(async (port): Promise<UsbFacts> => {
    const dir = path.join(base, port);
    const [busnum, devnum, vendor, product, devClass, manufacturer, productName, real] = await Promise.all([
      readText(path.join(dir, 'busnum')),
      readText(path.join(dir, 'devnum')),
      readText(path.join(dir, 'idVendor')),
      readText(path.join(dir, 'idProduct')),
      readText(path.join(dir, 'bDeviceClass')),
      readText(path.join(dir, 'manufacturer')),
      readText(path.join(dir, 'product')),
      realPath(dir),
    ]);
    const ifaces = entries.filter((n) => n.startsWith(`${port}:`));
    const ifaceFacts = await Promise.all(ifaces.map(async (i) => ({
      cls: hexId(await readText(path.join(base, i, 'bInterfaceClass')), 2),
      driver: await linkBase(path.join(base, i, 'driver')),
    })));
    return {
      port,
      busnum: intOrUndefined(busnum) ?? 0,
      devnum: intOrUndefined(devnum) ?? 0,
      vendorId: hexId(vendor, 4) ?? '0000',
      productId: hexId(product, 4) ?? '0000',
      deviceClass: hexId(devClass, 2) ?? '00',
      interfaceClasses: ifaceFacts.map((f) => f.cls).filter((c): c is string => !!c),
      interfaceDrivers: ifaceFacts.map((f) => f.driver).filter((d): d is string => !!d),
      manufacturer: manufacturer || undefined,
      product: productName || undefined,
      controller: pciFromSysPath(real),
    };
  }));
}

interface LsblkNode {
  name?: string;
  kname?: string;
  type?: string;
  fstype?: string | null;
  mountpoints?: (string | null)[];
  children?: LsblkNode[];
}

/** Words for what the host does with a disk, from its `lsblk -J` subtree. Empty: nothing. */
export function describeBlockUses(disk: LsblkNode): string[] {
  const uses: string[] = [];
  const walk = (node: LsblkNode, via?: string) => {
    for (const mp of node.mountpoints ?? []) {
      if (!mp) continue;
      const where = mp === '[SWAP]' ? 'swap' : `mounted at ${mp}`;
      uses.push(via ? `${where} (through ${via})` : where);
    }
    if (node.fstype === 'zfs_member') uses.push('part of a ZFS pool');
    for (const child of node.children ?? []) {
      // Partitions are the disk itself; anything else (LVM, RAID, encryption) is a layer on top.
      const layer = child.type && child.type !== 'part' ? `${child.type.toUpperCase()} ${child.name ?? child.kname}` : via;
      if (child.type && child.type !== 'part' && !(child.mountpoints ?? []).some(Boolean) && !(child.children ?? []).length) {
        uses.push(`holds ${layer}`);
      }
      walk(child, layer);
    }
  };
  walk(disk);
  return [...new Set(uses)];
}

async function scanBlock(): Promise<BlockFacts[]> {
  const names = (await listDir('/sys/block')).filter((n) => !/^(loop|ram|zram|dm-|md|nbd)/.test(n));
  const lsblkOut = await runSafe('lsblk', ['-J', '-o', 'NAME,KNAME,TYPE,FSTYPE,MOUNTPOINTS'], { timeout: 10_000 });
  let tree: LsblkNode[] = [];
  try {
    tree = lsblkOut ? ((JSON.parse(lsblkOut) as { blockdevices?: LsblkNode[] }).blockdevices ?? []) : [];
  } catch { /* unparseable: treat every disk as unknown use below */ }

  return Promise.all(names.map(async (name): Promise<BlockFacts> => {
    const real = await realPath(path.join('/sys/block', name));
    const node = tree.find((n) => (n.kname ?? n.name) === name);
    // No lsblk answer at all: assume the disk is in use. Passing through a disk the
    // host needs is the one mistake this module exists to prevent.
    const uses = node ? describeBlockUses(node) : lsblkOut === null ? ['in use (could not check)'] : [];
    // Native NVMe multipath (Ubuntu's default) puts a multi-controller drive's
    // namespace under /sys/devices/virtual/nvme-subsystem/, a path with no PCI
    // address in it. Its controllers are the nvmeN links beside it.
    let controllers: string[] = [];
    if (real?.includes('/nvme-subsystem/')) {
      const subsys = path.dirname(real);
      const links = (await listDir(subsys)).filter((n) => /^nvme\d+$/.test(n));
      controllers = (await Promise.all(links.map(async (l) => pciFromSysPath(await realPath(path.join(subsys, l))))))
        .filter((p): p is string => !!p);
    }
    const pci = pciFromSysPath(real) ?? controllers[0];
    return { name, pci, usbPort: usbPortFromSysPath(real), uses, controllers: controllers.length ? controllers : pci ? [pci] : [] };
  }));
}

interface IpAddrEntry {
  ifname?: string;
  addr_info?: { family?: string; local?: string; prefixlen?: number; scope?: string }[];
}

async function scanNet(): Promise<NetFacts[]> {
  const names = (await listDir('/sys/class/net')).filter((n) => n !== 'lo');
  const ipOut = await runSafe('ip', ['-j', 'addr', 'show'], { timeout: 10_000 });
  const addrs = new Map<string, string[]>();
  try {
    for (const e of (ipOut ? JSON.parse(ipOut) : []) as IpAddrEntry[]) {
      if (!e.ifname) continue;
      const list = (e.addr_info ?? [])
        .filter((a) => a.local && a.scope !== 'link' && a.scope !== 'host')
        .map((a) => `${a.local}/${a.prefixlen}`);
      addrs.set(e.ifname, list);
    }
  } catch { /* leave empty */ }

  const uppersOf = async (dev: string): Promise<string[]> => {
    const dir = path.join('/sys/class/net', dev);
    const master = await linkBase(path.join(dir, 'master'));
    const uppers = (await listDir(dir)).filter((n) => n.startsWith('upper_')).map((n) => n.slice('upper_'.length));
    return [...new Set([...(master ? [master] : []), ...uppers])];
  };

  return Promise.all(names.map(async (name): Promise<NetFacts> => {
    const real = await realPath(path.join('/sys/class/net', name, 'device'));
    // Follow the stack upwards: a NIC under a bond under a bridge carries the bridge's address.
    const seen = new Set<string>([name]);
    const queue = await uppersOf(name);
    const uppers: string[] = [];
    while (queue.length) {
      const u = queue.shift()!;
      if (seen.has(u)) continue;
      seen.add(u);
      uppers.push(u);
      queue.push(...(await uppersOf(u)));
    }
    let feedsBridge: string | undefined;
    for (const dev of [name, ...uppers]) {
      if (await exists(path.join('/sys/class/net', dev, 'bridge'))) { feedsBridge = dev; break; }
    }
    return {
      name,
      pci: pciFromSysPath(real),
      usbPort: usbPortFromSysPath(real),
      addresses: addrs.get(name) ?? [],
      uppers,
      upperAddresses: uppers.flatMap((u) => addrs.get(u) ?? []),
      feedsBridge,
    };
  }));
}

async function scanDrm(): Promise<DrmFacts[]> {
  const entries = await listDir('/sys/class/drm');
  const cards = entries.filter((n) => /^card\d+$/.test(n));
  return Promise.all(cards.map(async (card): Promise<DrmFacts> => {
    const real = await realPath(path.join('/sys/class/drm', card, 'device'));
    const connectors = await Promise.all(entries.filter((n) => n.startsWith(`${card}-`)).map(async (c) => ({
      name: c.slice(card.length + 1),
      connected: (await readText(path.join('/sys/class/drm', c, 'status'))) === 'connected',
      enabled: (await readText(path.join('/sys/class/drm', c, 'enabled'))) === 'enabled',
    })));
    return { card, pci: pciFromSysPath(real), connectors };
  }));
}

async function readCpu(): Promise<HostFacts['cpu']> {
  const raw = (await readText('/proc/cpuinfo')) ?? '';
  const first = raw.split(/\n\s*\n/)[0] ?? '';
  const vendorRaw = first.match(/^vendor_id\s*:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const flags = new Set((first.match(/^flags\s*:\s*(.+)$/m)?.[1] ?? '').split(/\s+/));
  return {
    vendor: vendorRaw === 'GenuineIntel' ? 'intel' : vendorRaw === 'AuthenticAMD' || vendorRaw === 'HygonGenuine' ? 'amd' : 'other',
    model: first.match(/^model name\s*:\s*(.+)$/m)?.[1]?.trim() ?? 'Unknown',
    vmx: flags.has('vmx'),
    svm: flags.has('svm'),
  };
}

async function readVfioPci(kernel: string): Promise<HostFacts['vfioPci']> {
  if (await exists('/sys/module/vfio_pci')) return 'loaded';
  // virtpilot.service runs with ProtectKernelModules, which turns /lib/modules
  // into an empty, unreadable directory: from in here a module that isn't
  // loaded can't be told from one that isn't installed. Say "unknown", never
  // "missing" (libvirt loads vfio-pci itself, and the installer loads it at boot).
  const root = await listDir(path.join('/lib/modules', kernel));
  if (!root.length) return 'unknown';
  const dir = path.join('/lib/modules', kernel, 'kernel/drivers/vfio/pci');
  if ((await listDir(dir)).some((f) => f.startsWith('vfio-pci.ko'))) return 'available';
  const builtin = (await readText(path.join('/lib/modules', kernel, 'modules.builtin'))) ?? '';
  return /\/vfio-pci\.ko$/m.test(builtin) ? 'loaded' : 'missing';
}

/** allow_unsafe_interrupts, from the loaded module, or else from what would set it when it loads. */
async function readAllowUnsafe(cmdline: string): Promise<boolean> {
  const live = await readText('/sys/module/vfio_iommu_type1/parameters/allow_unsafe_interrupts');
  if (live !== undefined) return live === 'Y';
  if (/(?:^|\s)vfio_iommu_type1\.allow_unsafe_interrupts=(?:1|y|Y)(?=\s|$)/.test(cmdline)) return true;
  for (const f of await listDir('/etc/modprobe.d')) {
    if (!f.endsWith('.conf')) continue;
    const text = (await readText(path.join('/etc/modprobe.d', f))) ?? '';
    if (/^\s*options\s+vfio_iommu_type1\b.*\ballow_unsafe_interrupts=(?:1|y|Y)\b/m.test(text)) return true;
  }
  return false;
}

async function readZfsArcReclaimableKb(): Promise<number> {
  const stats = await readText('/proc/spl/kstat/zfs/arcstats');
  if (!stats) return 0;
  const field = (k: string) => Number(stats.match(new RegExp(`^${k}\\s+\\d+\\s+(\\d+)`, 'm'))?.[1] ?? 0);
  return Math.max(0, Math.floor((field('size') - field('c_min')) / 1024));
}

async function readJournal(): Promise<string[]> {
  // The service runs in the systemd-journal group, so this needs no sudo.
  const out = await runSafe('journalctl', [
    '-k', '-b', '-o', 'cat', '--no-pager', '-q',
    '-g', 'VMX|SVM|DMAR|AMD-Vi|IOMMU|remapping|vfio',
  ], { timeout: 10_000 });
  if (!out) return [];
  return out.split('\n').map((l) => l.trim()).filter(Boolean).slice(-60);
}

export async function scanHost(): Promise<HostFacts> {
  const kernel = (await readText('/proc/sys/kernel/osrelease')) ?? 'unknown';
  const cmdline = (await readText('/proc/cmdline')) ?? '';
  const [cpu, kvm, dmar, ivrs, groups, interrupts, unsafe, vfioPci, journal, meminfo, arc, pci, usb, block, net, drm] =
    await Promise.all([
      readCpu(),
      exists('/dev/kvm'),
      exists('/sys/firmware/acpi/tables/DMAR'),
      exists('/sys/firmware/acpi/tables/IVRS'),
      listDir('/sys/kernel/iommu_groups'),
      readText('/proc/interrupts'),
      readAllowUnsafe(cmdline),
      readVfioPci(kernel),
      readJournal(),
      readText('/proc/meminfo'),
      readZfsArcReclaimableKb(),
      scanPci(),
      scanUsb(),
      scanBlock(),
      scanNet(),
      scanDrm(),
    ]);
  return {
    kernel,
    cpu,
    kvm,
    acpi: { dmar, ivrs },
    iommuGroups: groups.length,
    cmdline,
    journal,
    irqRemapping: /\bIR-(?:PCI|IO-APIC)/.test(interrupts ?? ''),
    allowUnsafeInterrupts: unsafe,
    vfioPci,
    pci,
    usb,
    block,
    net,
    drm,
    memAvailableKb: parseInt(meminfo?.match(/^MemAvailable:\s+(\d+)/m)?.[1] ?? '0', 10),
    hugepagesFreeKb: parseInt(meminfo?.match(/^HugePages_Free:\s+(\d+)/m)?.[1] ?? '0', 10)
      * parseInt(meminfo?.match(/^Hugepagesize:\s+(\d+)/m)?.[1] ?? '0', 10),
    zfsArcReclaimableKb: arc,
  };
}

// Several callers in one request (the list, an attach's checks) share one scan.
let cached: { at: number; facts: Promise<HostFacts> } | null = null;
const CACHE_MS = 3_000;

/** After anything that changes drivers or devices: the next read scans again. */
export function invalidateHostFacts(): void {
  cached = null;
}

export function getHostFacts(force = false): Promise<HostFacts> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.facts;
  const facts = scanHost();
  cached = { at: Date.now(), facts };
  facts.catch(() => { if (cached?.facts === facts) cached = null; });
  return facts;
}
