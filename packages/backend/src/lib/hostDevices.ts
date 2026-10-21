// What can be passed through on this host, and why the rest can't.
//
// Pure functions over a HostFacts snapshot (lib/hostFacts.ts) plus who uses
// what. The rules, in order:
//   1. A PCI device travels with its whole IOMMU group: VFIO refuses a group
//      while any other endpoint in it is still bound to a host driver.
//      Bridges are exempt (the kernel allows them by header type).
//   2. Chipset and CPU plumbing (uncore registers, IOAPICs, SMBus, the LPC
//      bridge...) is never offered, and a group that would drag one of the
//      host's essential functions along is not offered either.
//   3. Anything the host is visibly using is not offered: the controller of a
//      mounted disk, a NIC carrying an address or a bridge, a card drawing an
//      enabled screen. Each hidden device keeps its reason, so the UI can say
//      why something is missing instead of just not listing it.

import type { HostFacts, PciFacts, UsbFacts } from './hostFacts.js';

export type DeviceKind = 'gpu' | 'network' | 'storage' | 'usb-controller' | 'audio' | 'accelerator' | 'other' | 'usb';

/** The order kinds are listed in, and which device names a group. */
export const KIND_ORDER: DeviceKind[] = ['gpu', 'network', 'storage', 'usb-controller', 'accelerator', 'audio', 'other', 'usb'];

export type HiddenCategory = 'host' | 'chipset' | 'bridge' | 'hub';

export interface HiddenDevice {
  id: string;
  type: 'pci' | 'usb';
  name: string;
  vendor: string;
  address: string;
  category: HiddenCategory;
  reason: string;
}

export interface DeviceNote {
  tone: 'info' | 'warn';
  text: string;
}

export interface GroupMember {
  address: string;
  name: string;
  kindLabel: string;
  driver?: string;
}

export interface VmRef {
  uuid: string;
  name: string;
  running: boolean;
}

export interface PassthroughDevice {
  /** 'pci_0000_3b_00_0' (the group's lead device) or 'usb_1-8.2' (the port). */
  id: string;
  type: 'pci' | 'usb';
  kind: DeviceKind;
  kindLabel: string;
  name: string;
  vendor: string;
  /** '0000:3b:00.0', or 'Bus 001 Device 004' for USB. */
  address: string;
  vendorId: string;
  productId: string;
  driver?: string;
  iommuGroup?: number;
  numaNode?: number;
  /** Other endpoints in the IOMMU group that have to come along. */
  members: GroupMember[];
  /** Short plain facts: memory window, reset support, virtual functions. */
  facts: string[];
  notes: DeviceNote[];
  /** VMs whose configuration includes this device. More than one is a conflict to show. */
  usedBy: VmRef[];
  kept: boolean;
  /** SR-IOV: how many virtual functions the card can have, and has now. */
  sriov?: { total: number; current: number };
  /** For a virtual function: the card it belongs to. */
  vfOf?: string;
  /** The largest memory window, in bytes. Big ones need UEFI guests. */
  largestBar?: number;
  /** USB: attach by bus/device number because an identical device is also plugged in. */
  byAddress?: boolean;
}

export type CheckState = 'ok' | 'off' | 'warn' | 'na';

export interface HostCheck {
  key: 'cpu' | 'iommu' | 'irq' | 'vfio';
  label: string;
  state: CheckState;
  /** What is true now, in a few words. */
  value: string;
  /** What to do about it, when anything. */
  fix?: string;
}

export interface PassthroughHost {
  /** PCI passthrough can work on this host. */
  pciReady: boolean;
  /** USB passthrough can work on this host. */
  usbReady: boolean;
  checks: HostCheck[];
  /** One sentence for the first thing in the way, when anything is. */
  blocker?: string;
}

export interface Inventory {
  host: PassthroughHost;
  devices: PassthroughDevice[];
  hidden: HiddenDevice[];
}

export interface UsbAssignment extends VmRef {
  /** Set when the VM's hostdev names one device by its bus and device number. */
  bus?: number;
  device?: number;
}

export interface AssignmentIndex {
  /** PCI address → VMs whose configuration includes it. */
  pci: Map<string, VmRef[]>;
  /** 'vvvv:pppp' → VMs whose configuration includes a USB device with those IDs. */
  usb: Map<string, UsbAssignment[]>;
}

const CHIPSET_VENDORS = new Set(['8086', '1022', '1d94']); // Intel, AMD, Hygon

export function pciId(address: string): string {
  return `pci_${address.replace(/[:.]/g, '_')}`;
}

export function addressFromPciId(id: string): string | null {
  const m = id.match(/^pci_([0-9a-f]{4})_([0-9a-f]{2})_([0-9a-f]{2})_([0-7])$/);
  return m ? `${m[1]}:${m[2]}:${m[3]}.${m[4]}` : null;
}

export function usbId(port: string): string {
  return `usb_${port}`;
}

export function portFromUsbId(id: string): string | null {
  const m = id.match(/^usb_(\d{1,3}-\d{1,3}(?:\.\d{1,3}){0,6})$/);
  return m ? m[1] : null;
}

export function usbKey(vendorId: string, productId: string): string {
  return `${vendorId.toLowerCase()}:${productId.toLowerCase()}`;
}

// ─── Classification ───────────────────────────────────────────────────────────

type Classified =
  | { offer: true; kind: DeviceKind; label: string }
  | { offer: false; category: 'chipset' | 'bridge'; label: string };

/**
 * What a PCI function is, and whether it is ever worth offering. `label` is
 * the plain name used in the UI ("Network card"), never the raw class string.
 */
export function classifyPci(d: Pick<PciFacts, 'classCode' | 'vendorId' | 'memoryBars' | 'isBridge'>): Classified {
  const cls = d.classCode.slice(0, 2);
  const sub = d.classCode.slice(2, 4);
  const chipsetVendor = CHIPSET_VENDORS.has(d.vendorId);
  const noBars = d.memoryBars.length === 0;
  const offer = (kind: DeviceKind, label: string): Classified => ({ offer: true, kind, label });
  const chipset = (label: string): Classified => ({ offer: false, category: 'chipset', label });

  if (d.isBridge || cls === '06') return { offer: false, category: 'bridge', label: 'Bridge' };

  switch (cls) {
    case '00':
      return sub === '01' ? offer('gpu', 'Graphics card') : chipset('Unclassified device');
    case '01': {
      const labels: Record<string, string> = {
        '00': 'SCSI controller', '01': 'IDE controller', '04': 'RAID controller', '05': 'ATA controller',
        '06': 'SATA controller', '07': 'SAS controller', '08': 'NVMe drive', '09': 'UFS controller',
      };
      return offer('storage', labels[sub] ?? 'Storage controller');
    }
    case '02':
      return offer('network', sub === '07' ? 'InfiniBand card' : 'Network card');
    case '03':
      return offer('gpu', sub === '02' ? 'GPU' : sub === '80' ? 'Display controller' : 'Graphics card');
    case '04':
      if (sub === '01' || sub === '03') return offer('audio', 'Audio device');
      return offer('other', sub === '00' ? 'Video capture card' : 'Multimedia device');
    case '05':
      return chipset('Memory controller');
    case '07':
      if (sub === '80' && chipsetVendor) return chipset('Management engine interface');
      return offer('other', sub === '00' ? 'Serial card' : sub === '01' ? 'Parallel port card' : sub === '03' ? 'Modem' : 'Communication card');
    case '08':
      // System peripherals. The CPU and chipset ship dozens (IOAPICs, uncore,
      // RAS, DMA engines); another vendor's is a real device on a card.
      if (chipsetVendor || noBars || sub === '00' || sub === '06') return chipset('System peripheral');
      return offer('other', sub === '01' ? 'DMA controller' : sub === '05' ? 'SD card reader' : 'System device');
    case '09':
      return offer('other', 'Input controller');
    case '0b':
      return sub === '40' ? offer('accelerator', 'Co-processor') : chipset('Processor function');
    case '0c':
      switch (sub) {
        case '03': return offer('usb-controller', 'USB controller');
        case '00': return offer('other', 'FireWire controller');
        case '04': return offer('storage', 'Fibre Channel card');
        case '06': return offer('network', 'InfiniBand card');
        case '09': return offer('other', 'CAN bus controller');
        case '05': return chipset('SMBus controller');
        case '07': return chipset('IPMI interface');
        default: return chipsetVendor ? chipset('Serial bus controller') : offer('other', 'Serial bus controller');
      }
    case '0d':
      return offer('network', 'Wireless card');
    case '10':
      return chipsetVendor && d.vendorId === '1022' ? chipset('Platform security processor') : offer('accelerator', 'Crypto accelerator');
    case '11':
      if (sub === '01' || chipsetVendor || noBars) return chipset('Signal processing function');
      return offer('other', 'Signal processing card');
    case '12':
      return offer('accelerator', 'Accelerator');
    case '40':
      return offer('accelerator', 'Co-processor');
    case '13':
    case 'ff':
      return chipset('Platform function');
    default:
      return noBars ? chipset('Platform function') : offer('other', 'PCI device');
  }
}

/**
 * Chipset functions the host can't do without. A group containing one of
 * these with a driver bound is never offered, whatever else is in it: taking
 * the LPC bridge or the SPI flash controller away from a running host is not
 * a passthrough, it is a crash.
 */
function isEssentialChipset(d: PciFacts): boolean {
  if (!d.driver) return false;
  const c = d.classCode.slice(0, 4);
  return c === '0601' || c === '0600' || c === '0c05' || c === '0c07' || c === '0580' || c === '0800' || c === '0806'
    || (c === '0c80' && CHIPSET_VENDORS.has(d.vendorId));
}

const ESSENTIAL_WORDS: Record<string, string> = {
  '0600': 'host bridge', '0601': 'LPC bridge', '0c05': 'SMBus controller', '0c07': 'IPMI interface',
  '0c80': 'SPI flash controller', '0580': 'power management controller', '0800': 'interrupt controller', '0806': 'IOMMU',
};

const TOOL_DRIVERS = new Set(['vfio-pci', 'pci-stub']);

/** The mount points worth naming for a disk, '/' first. /tmp and /var/tmp only ever add noise: under
 *  the service's PrivateTmp they are bind mounts of the root filesystem, not mounts of their own. */
export function mountSummary(mounts: string[]): string[] {
  const unique = [...new Set(mounts)];
  const meaningful = unique.filter((m) => m !== '/tmp' && m !== '/var/tmp');
  return (meaningful.length ? meaningful : unique).sort((a, b) => a.length - b.length || a.localeCompare(b));
}

// ─── Words ────────────────────────────────────────────────────────────────────

/** "NVIDIA Corporation" → "NVIDIA", "Advanced Micro Devices, Inc. [AMD/ATI]" → "AMD": the name people use. */
export function shortVendor(name: string | undefined): string | undefined {
  if (!name) return name;
  if (/^Advanced Micro Devices/.test(name)) return 'AMD';
  let v = name.trim();
  for (;;) {
    const next = v.replace(/,?\s+(?:Corporation|Corp\.|Technologies|Technology|Inc\.|Co\., Ltd\.|Ltd\.|Limited|GmbH)$/, '').trim();
    if (next === v) return v;
    v = next;
  }
}

/** Strip vendor boilerplate lspci keeps: "Intel Corporation" stays, "[3DNAND, Beta Rock Controller]" goes. */
export function cleanName(name: string | undefined, fallback: string): string {
  if (!name) return fallback;
  return name.replace(/\s+\[(?:[^\]]*,[^\]]*)\]$/, '').trim() || fallback;
}

export function formatBarSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${Number.isInteger(v) ? v : v.toFixed(1)} ${units[i]}`;
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function shortAddress(address: string): string {
  return address.startsWith('0000:') ? address.slice(5) : address;
}

// ─── Host readiness ───────────────────────────────────────────────────────────

const OFF_FLAG_RE = /(?:^|\s)(intel_iommu=off|amd_iommu=off|iommu=off)(?=\s|$)/;

export function evaluateHost(f: HostFacts): PassthroughHost {
  const intel = f.cpu.vendor === 'intel';
  const amd = f.cpu.vendor === 'amd';
  const vtx = intel ? 'Intel Virtualization Technology (VT-x)' : amd ? 'SVM Mode (AMD-V)' : 'hardware virtualisation';
  const vtd = intel ? 'Intel VT for Directed I/O (VT-d)' : amd ? 'IOMMU (AMD-Vi)' : 'the IOMMU';
  const journal = f.journal.join('\n');
  const checks: HostCheck[] = [];

  // Hardware virtualisation. Passthrough needs KVM; software emulation can't map a device.
  const cpuFlag = f.cpu.vmx || f.cpu.svm;
  if (f.kvm) {
    checks.push({ key: 'cpu', label: 'Hardware virtualisation', state: 'ok', value: intel ? 'On (Intel VT-x)' : amd ? 'On (AMD-V)' : 'On' });
  } else if (cpuFlag) {
    checks.push({
      key: 'cpu', label: 'Hardware virtualisation', state: 'off', value: 'Supported, but KVM is not loaded',
      fix: `Load the KVM module (modprobe ${intel ? 'kvm_intel' : amd ? 'kvm_amd' : 'kvm'}) or restart the host.`,
    });
  } else if (/(?:VMX|SVM).*disabled by BIOS|disabled by BIOS.*(?:VMX|SVM)|kvm: disabled by bios/i.test(journal)) {
    checks.push({
      key: 'cpu', label: 'Hardware virtualisation', state: 'off', value: 'Off in the firmware settings',
      fix: `Turn on ${vtx} in the firmware (BIOS/UEFI) setup, then restart the host.`,
    });
  } else {
    checks.push({
      key: 'cpu', label: 'Hardware virtualisation', state: 'off', value: 'Off, or not available on this processor',
      fix: `Look for ${vtx} in the firmware (BIOS/UEFI) setup and turn it on, then restart the host.`,
    });
  }

  // IOMMU: present in the firmware tables, then switched on by the kernel.
  const table = f.acpi.dmar || f.acpi.ivrs;
  const offFlag = f.cmdline.match(OFF_FLAG_RE)?.[1];
  if (f.iommuGroups > 0) {
    checks.push({
      key: 'iommu', label: 'IOMMU', state: 'ok',
      value: `On (${f.acpi.ivrs && !f.acpi.dmar ? 'AMD-Vi' : f.acpi.dmar ? 'Intel VT-d' : 'active'}), ${f.iommuGroups} isolation group${f.iommuGroups === 1 ? '' : 's'}`,
    });
  } else if (!table) {
    checks.push({
      key: 'iommu', label: 'IOMMU', state: 'off', value: 'Off in the firmware settings',
      fix: `Turn on ${vtd} in the firmware (BIOS/UEFI) setup, then restart the host.`,
    });
  } else if (offFlag) {
    checks.push({
      key: 'iommu', label: 'IOMMU', state: 'off', value: `Switched off on the kernel command line (${offFlag})`,
      fix: `Remove ${offFlag} from GRUB_CMDLINE_LINUX in /etc/default/grub, run update-grub, then restart the host.`,
    });
  } else {
    const flag = f.acpi.ivrs && !f.acpi.dmar ? 'amd_iommu=on' : 'intel_iommu=on';
    checks.push({
      key: 'iommu', label: 'IOMMU', state: 'off', value: 'Present but not switched on',
      fix: `Add ${flag} to GRUB_CMDLINE_LINUX in /etc/default/grub, run update-grub, then restart the host.`,
    });
  }

  const iommuOk = f.iommuGroups > 0;
  if (!iommuOk) {
    checks.push({ key: 'irq', label: 'Interrupt remapping', state: 'na', value: 'Needs the IOMMU first' });
  } else if (f.irqRemapping) {
    checks.push({ key: 'irq', label: 'Interrupt remapping', state: 'ok', value: 'On' });
  } else if (f.allowUnsafeInterrupts) {
    checks.push({
      key: 'irq', label: 'Interrupt remapping', state: 'warn', value: 'Off, allowed without it',
      fix: 'vfio_iommu_type1 has allow_unsafe_interrupts set, so a guest could forge interrupts. Turn interrupt remapping on in the firmware if it has the option.',
    });
  } else {
    checks.push({
      key: 'irq', label: 'Interrupt remapping', state: 'off', value: 'Off',
      fix: 'VFIO refuses devices without it. Look for interrupt remapping (or x2APIC) in the firmware setup.',
    });
  }

  checks.push(f.vfioPci === 'missing'
    ? { key: 'vfio', label: 'VFIO driver', state: 'off', value: 'vfio-pci is not installed', fix: 'Install the kernel modules package for this kernel (linux-modules-extra-' + f.kernel + ').' }
    : { key: 'vfio', label: 'VFIO driver', state: 'ok', value: f.vfioPci === 'loaded' ? 'Loaded' : f.vfioPci === 'available' ? 'Available' : 'Loads when a VM needs it' });

  const pciReady = checks.every((c) => c.state === 'ok' || c.state === 'warn' || c.state === 'na') && f.kvm && iommuOk;
  const first = checks.find((c) => c.state === 'off');
  return {
    pciReady,
    usbReady: true,
    checks,
    blocker: first ? `${first.label}: ${first.value.charAt(0).toLowerCase()}${first.value.slice(1)}.` : undefined,
  };
}

// ─── Host use ─────────────────────────────────────────────────────────────────

interface HostUse {
  /** PCI address → why the host needs it. */
  pci: Map<string, string>;
  /** USB port → why the host needs it. */
  usb: Map<string, string>;
}

export function findHostUse(f: HostFacts): HostUse {
  const pci = new Map<string, string>();
  const usb = new Map<string, string>();
  const add = (map: Map<string, string>, key: string | undefined, reason: string) => {
    if (key && !map.has(key)) map.set(key, reason);
  };

  for (const b of f.block) {
    if (!b.uses.length) continue;
    // A multipath namespace reaches the host through every one of its controllers.
    for (const c of (b.controllers ?? []).filter((c) => c !== b.pci)) {
      add(pci, c, `Holds the host's disk ${b.name} (${b.uses[0]})`);
    }
    const mounts = mountSummary(b.uses.filter((u) => u.startsWith('mounted at ')).map((u) => u.slice('mounted at '.length).replace(/ \(through .*\)$/, '')));
    const detail = mounts.length ? listWords(mounts.slice(0, 3)) : b.uses[0];
    if (b.usbPort) {
      add(usb, b.usbPort, `Holds the host's disk ${b.name} (${detail})`);
      // Taking the whole USB controller would take the disk with it.
      add(pci, b.pci, `The host's USB disk ${b.name} is plugged into it (${detail})`);
    } else {
      add(pci, b.pci, `Holds the host's disk ${b.name} (${detail})`);
    }
  }

  for (const n of f.net) {
    const own = n.addresses[0];
    const upper = n.upperAddresses[0];
    let reason: string | undefined;
    if (own) reason = `Carries the host's network (${n.name}, ${own.split('/')[0]})`;
    else if (upper) reason = `Carries the host's network (${n.name} under ${n.uppers[0]}, ${upper.split('/')[0]})`;
    else if (n.feedsBridge && n.feedsBridge !== n.name) reason = `Connects the bridge ${n.feedsBridge} that VMs use (${n.name})`;
    if (!reason) continue;
    if (n.usbPort) {
      add(usb, n.usbPort, reason);
      add(pci, n.pci, `The host's USB network adapter ${n.name} is plugged into it`);
    } else {
      add(pci, n.pci, reason);
    }
  }

  for (const d of f.drm) {
    const screen = d.connectors.find((c) => c.connected && c.enabled);
    if (screen) add(pci, d.pci, `Draws the host's screen (${screen.name})`);
  }

  return { pci, usb };
}

// ─── Inventory ────────────────────────────────────────────────────────────────

function rankOf(kind: DeviceKind): number {
  const i = KIND_ORDER.indexOf(kind);
  return i < 0 ? KIND_ORDER.length : i;
}

/**
 * What a device is called. A GPU goes by the product its owner knows, the part
 * lspci puts in brackets after the chip ("AD104GL [L4]" is an NVIDIA L4, as
 * nvidia-smi says); anything else keeps lspci's name, whose brackets hold a mode
 * ("SATA Controller [AHCI mode]").
 */
export function pciName(d: Pick<PciFacts, 'deviceName' | 'vendorName' | 'vendorId' | 'deviceId' | 'classCode'>): string {
  const name = cleanName(d.deviceName, `Device ${d.vendorId}:${d.deviceId}`);
  const product = d.classCode.startsWith('03') ? name.match(/^(.+?)\s+\[([^\]]+)\]$/) : null;
  if (product) return `${shortVendor(d.vendorName) ?? ''} ${product[2]}`.trim();
  return name;
}

/** The chip behind a GPU's product name ("AD104GL"), worth one fact. */
export function gpuChip(d: Pick<PciFacts, 'deviceName' | 'classCode'>): string | undefined {
  if (!d.classCode.startsWith('03')) return undefined;
  return cleanName(d.deviceName, '').match(/^(.+?)\s+\[([^\]]+)\]$/)?.[1];
}

export function pciVendor(d: Pick<PciFacts, 'vendorName' | 'vendorId'>): string {
  return shortVendor(d.vendorName) ?? `Vendor ${d.vendorId}`;
}

/** Endpoints grouped by IOMMU group (VFIO's unit of ownership); a device with no group stands alone. */
export function groupEndpoints(pci: PciFacts[]): Map<string, PciFacts[]> {
  const groups = new Map<string, PciFacts[]>();
  for (const d of pci) {
    if (d.isBridge) continue;
    const key = d.iommuGroup !== undefined ? `g${d.iommuGroup}` : `a${d.address}`;
    const list = groups.get(key) ?? [];
    list.push(d);
    groups.set(key, list);
  }
  return groups;
}

function chipsetReason(d: PciFacts, label: string): string {
  return CHIPSET_VENDORS.has(d.vendorId) ? `${label}, part of the chipset or processor` : `${label}, nothing a VM can use`;
}

// Host display drivers. Detaching one is the moment a GPU passthrough most
// often goes wrong, so it is worth a sentence; a NIC or HBA driver letting go
// is unremarkable.
const DISPLAY_DRIVERS = new Set(['nvidia', 'nouveau', 'amdgpu', 'radeon', 'i915', 'xe']);

export interface InventoryInput {
  facts: HostFacts;
  assignments: AssignmentIndex;
  kept?: Set<string>;
}

export function buildInventory({ facts, assignments, kept = new Set() }: InventoryInput): Inventory {
  const host = evaluateHost(facts);
  const use = findHostUse(facts);
  const devices: PassthroughDevice[] = [];
  const hidden: HiddenDevice[] = [];
  const multiNuma = new Set(facts.pci.map((d) => d.numaNode).filter((n) => n !== undefined)).size > 1;
  const hide = (d: PciFacts, category: HiddenCategory, reason: string) => hidden.push({
    id: pciId(d.address), type: 'pci', name: pciName(d), vendor: pciVendor(d), address: d.address, category, reason,
  });

  // ── PCI ──
  for (const d of facts.pci) {
    if (d.isBridge) hide(d, 'bridge', 'Bridge: connects other PCI devices');
  }

  for (const members of groupEndpoints(facts.pci).values()) {
    const classified = members.map((d) => ({ d, c: classifyPci(d) }));
    const offerable = classified.filter((x): x is { d: PciFacts; c: Extract<Classified, { offer: true }> } => x.c.offer);

    if (!offerable.length) {
      for (const { d, c } of classified) hide(d, c.offer ? 'chipset' : c.category, chipsetReason(d, c.label));
      continue;
    }

    // The host's own needs, anywhere in the group, rule the whole group out.
    const hostNeed = members.map((d) => ({ d, why: use.pci.get(d.address) })).find((x) => x.why);
    const essential = members.find((d) => isEssentialChipset(d));
    const blocked = hostNeed
      ? { d: hostNeed.d, why: hostNeed.why! }
      : essential ? { d: essential, why: `It is the chipset's ${ESSENTIAL_WORDS[essential.classCode.slice(0, 4)] ?? 'own function'}, which the host needs` } : undefined;

    offerable.sort((a, b) => rankOf(a.c.kind) - rankOf(b.c.kind) || a.d.address.localeCompare(b.d.address));
    const lead = offerable[0];

    if (blocked) {
      for (const { d, c } of classified) {
        if (d === blocked.d) hide(d, 'host', blocked.why);
        else if (c.offer) hide(d, 'host', `Shares an isolation group with ${pciName(blocked.d)} (${shortAddress(blocked.d.address)}). ${blocked.why}.`);
        else hide(d, c.category, chipsetReason(d, c.label));
      }
      continue;
    }

    // Everything else in the group with a host driver has to come along (VFIO
    // refuses the group otherwise), and so do other real devices: a group has
    // one owner, so they would be unusable by anyone else anyway. Driverless
    // chipset functions don't stand in the way and stay where they are.
    const travelling = members.filter((m) => m !== lead.d
      && (offerable.some((o) => o.d === m) || (m.driver !== undefined && !TOOL_DRIVERS.has(m.driver))));
    for (const { d, c } of classified) {
      if (d !== lead.d && !c.offer && !travelling.includes(d)) hide(d, c.category, chipsetReason(d, c.label));
    }

    const d = lead.d;
    const kind = lead.c.kind;
    const deviceFacts: string[] = [];
    const notes: DeviceNote[] = [];
    const largestBar = d.memoryBars.length ? Math.max(...d.memoryBars) : undefined;
    const computeCard = kind === 'gpu' || kind === 'accelerator';
    const chip = gpuChip(d);
    if (chip) deviceFacts.push(chip);
    if (computeCard && largestBar && largestBar >= 1024 ** 3) deviceFacts.push(`${formatBarSize(largestBar)} memory window`);
    if (computeCard && d.resetMethods?.length) deviceFacts.push('Resets cleanly');
    if (multiNuma && d.numaNode !== undefined) deviceFacts.push(`NUMA node ${d.numaNode}`);
    // A GPU's SR-IOV functions need the vendor's own host driver to be useful; a NIC's work as they are.
    const sriov = !computeCard && d.sriovTotalVfs ? { total: d.sriovTotalVfs, current: d.sriovNumVfs ?? 0 } : undefined;
    if (sriov) deviceFacts.push(`Up to ${sriov.total} virtual functions`);
    if (d.physfn) deviceFacts.push(`Virtual function of ${shortAddress(d.physfn)}`);

    if (d.resetMethods && d.resetMethods.length === 0) {
      notes.push({ tone: 'warn', text: 'The kernel has no way to reset this card, so it may only work once per host restart.' });
    }
    if (d.bootVga) {
      notes.push({ tone: 'warn', text: "The firmware draws the host's boot screen on this card. The host has no local screen while a VM uses it." });
    }
    if (d.sriovNumVfs && d.sriovNumVfs > 0) {
      notes.push({ tone: 'warn', text: `It has ${d.sriovNumVfs} virtual function${d.sriovNumVfs === 1 ? '' : 's'} switched on. Passing the whole card through removes them.` });
    }
    if (d.driver && DISPLAY_DRIVERS.has(d.driver)) {
      notes.push({ tone: 'info', text: `The host's ${d.driver} driver lets go of it while a VM uses it, and takes it back when the VM stops.` });
    }
    if (travelling.length) {
      const names = travelling.map((m) => `${pciName(m)} (${shortAddress(m.address)})`);
      notes.push({ tone: 'info', text: `Brings ${listWords(names)} with it: they share an isolation group, so they go to the same VM.` });
    }
    const usbHere = facts.usb.filter((u) => u.controller && members.some((m) => m.address === u.controller)
      && !/^usb\d+$/.test(u.port) && u.deviceClass !== '09');
    if (usbHere.length) {
      const names = [...new Set(usbHere.map((u) => u.product ?? `${u.vendorId}:${u.productId}`))].slice(0, 4);
      notes.push({ tone: 'warn', text: `The host loses what is plugged into it while a VM uses it: ${listWords(names)}.` });
    }

    devices.push({
      id: pciId(d.address),
      type: 'pci',
      kind,
      kindLabel: lead.c.label,
      name: pciName(d),
      vendor: pciVendor(d),
      address: d.address,
      vendorId: d.vendorId,
      productId: d.deviceId,
      driver: d.driver,
      iommuGroup: d.iommuGroup,
      numaNode: d.numaNode,
      members: travelling.map((m) => ({ address: m.address, name: pciName(m), kindLabel: classifyPci(m).label, driver: m.driver })),
      facts: deviceFacts,
      notes,
      usedBy: dedupeVms(members.flatMap((m) => assignments.pci.get(m.address) ?? [])),
      kept: kept.has(d.address),
      sriov,
      vfOf: d.physfn,
      largestBar,
    });
  }

  // ── USB ──
  const idCounts = new Map<string, number>();
  for (const u of facts.usb) idCounts.set(usbKey(u.vendorId, u.productId), (idCounts.get(usbKey(u.vendorId, u.productId)) ?? 0) + 1);
  for (const u of facts.usb) {
    const name = u.product ?? `Device ${u.vendorId}:${u.productId}`;
    const vendor = u.manufacturer ?? `Vendor ${u.vendorId}`;
    const address = `Bus ${String(u.busnum).padStart(3, '0')} Device ${String(u.devnum).padStart(3, '0')}`;
    const isRoot = /^usb\d+$/.test(u.port);
    const isHub = u.deviceClass === '09' || (u.interfaceClasses.length > 0 && u.interfaceClasses.every((c) => c === '09'));
    if (isRoot || isHub) {
      hidden.push({ id: usbId(u.port), type: 'usb', name, vendor, address, category: 'hub', reason: isRoot ? 'Root hub of a USB controller' : 'USB hub: plug the device behind it in instead' });
      continue;
    }
    const why = use.usb.get(u.port);
    if (why) {
      hidden.push({ id: usbId(u.port), type: 'usb', name, vendor, address, category: 'host', reason: why });
      continue;
    }
    const key = usbKey(u.vendorId, u.productId);
    const twin = (idCounts.get(key) ?? 0) > 1;
    devices.push({
      id: usbId(u.port),
      type: 'usb',
      kind: 'usb',
      kindLabel: usbLabel(u),
      name,
      vendor,
      address,
      vendorId: u.vendorId,
      productId: u.productId,
      members: [],
      facts: [],
      notes: twin
        ? [{ tone: 'warn', text: 'An identical device is plugged in too, so this one is attached by its bus and device number. If it is unplugged, attach it again.' }]
        : [],
      // A hostdev pinned to a bus and device claims only that device; one by IDs alone claims every twin.
      usedBy: dedupeVms((assignments.usb.get(key) ?? [])
        .filter((a) => a.bus === undefined || a.device === undefined || (a.bus === u.busnum && a.device === u.devnum))
        .map(({ uuid, name: n, running }) => ({ uuid, name: n, running }))),
      kept: false,
      byAddress: twin,
    });
  }

  // Addresses are fixed-width lowercase hex ('0000:5e:00.0') or zero-padded
  // ('Bus 001 Device 003'), so plain string order is numeric order.
  const byAddressText = (a: { address: string }, b: { address: string }) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  devices.sort((a, b) => rankOf(a.kind) - rankOf(b.kind) || byAddressText(a, b));
  hidden.sort(byAddressText);
  return { host, devices, hidden };
}

function usbLabel(u: UsbFacts): string {
  const cls = u.deviceClass !== '00' ? u.deviceClass : u.interfaceClasses[0];
  switch (cls) {
    case '01': return 'USB audio device';
    case '02': case '0a': return 'USB modem';
    case '03': return 'USB input device';
    case '06': return 'USB camera';
    case '07': return 'USB printer';
    case '08': return 'USB drive';
    case '0b': return 'USB smart card reader';
    case '0e': return 'USB video device';
    case 'e0': return 'USB wireless adapter';
    default: return 'USB device';
  }
}

function dedupeVms(list: VmRef[]): VmRef[] {
  const seen = new Map<string, VmRef>();
  for (const v of list) seen.set(v.uuid, v);
  return [...seen.values()];
}
