// Reading and writing the <hostdev> elements of a libvirt domain.
//
// The VM's own definition is the source of truth for what it has been given:
// a device that has since left the host still appears here (and must still
// be detachable), and a running VM's live definition can differ from the one
// it will boot with next.

export interface PciHostdev {
  type: 'pci';
  /** Host address, '0000:3b:00.0'. */
  address: string;
  /** The element as it appears in the definition, for an exact detach. */
  xml: string;
}

export interface UsbHostdev {
  type: 'usb';
  vendorId?: string;
  productId?: string;
  bus?: number;
  device?: number;
  xml: string;
}

export type Hostdev = PciHostdev | UsbHostdev;

const HOSTDEV_RE = /<hostdev\b[^>]*>[\s\S]*?<\/hostdev>/g;

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}=(['"])(.*?)\\1`))?.[2];
}

function hexNum(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = v.startsWith('0x') ? parseInt(v, 16) : parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function hex4(v: string | undefined): string | undefined {
  const n = hexNum(v);
  return n === undefined ? undefined : n.toString(16).padStart(4, '0');
}

export function formatPciAddress(domain: number, bus: number, slot: number, fn: number): string {
  return `${domain.toString(16).padStart(4, '0')}:${bus.toString(16).padStart(2, '0')}:${slot.toString(16).padStart(2, '0')}.${fn.toString(16)}`;
}

/** Every subsystem <hostdev> (PCI and USB) in a domain definition. */
export function parseHostdevs(domainXml: string): Hostdev[] {
  const out: Hostdev[] = [];
  for (const m of domainXml.matchAll(HOSTDEV_RE)) {
    const block = m[0];
    const open = block.match(/^<hostdev\b[^>]*>/)?.[0] ?? '';
    if (attr(open, 'mode') !== 'subsystem') continue;
    const source = block.match(/<source\b[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? '';
    const type = attr(open, 'type');
    if (type === 'pci') {
      const tag = source.match(/<address\b[^>]*\/?>/)?.[0];
      if (!tag) continue;
      const domain = hexNum(attr(tag, 'domain')) ?? 0;
      const bus = hexNum(attr(tag, 'bus'));
      const slot = hexNum(attr(tag, 'slot'));
      const fn = hexNum(attr(tag, 'function'));
      if (bus === undefined || slot === undefined || fn === undefined) continue;
      out.push({ type: 'pci', address: formatPciAddress(domain, bus, slot, fn), xml: block });
    } else if (type === 'usb') {
      const vendorTag = source.match(/<vendor\b[^>]*\/?>/)?.[0];
      const productTag = source.match(/<product\b[^>]*\/?>/)?.[0];
      const addressTag = source.match(/<address\b[^>]*\/?>/)?.[0];
      out.push({
        type: 'usb',
        vendorId: vendorTag ? hex4(attr(vendorTag, 'id')) : undefined,
        productId: productTag ? hex4(attr(productTag, 'id')) : undefined,
        bus: addressTag ? hexNum(attr(addressTag, 'bus')) : undefined,
        device: addressTag ? hexNum(attr(addressTag, 'device')) : undefined,
        xml: block,
      });
    }
  }
  return out;
}

/**
 * A stable name for one hostdev, used in URLs to detach it:
 * 'pci_0000_3b_00_0', 'usb_046d_c52b', or 'usb_046d_c52b_001_004' when the
 * device was attached by its bus and device number.
 */
export function hostdevKey(h: Hostdev): string {
  if (h.type === 'pci') return `pci_${h.address.replace(/[:.]/g, '_')}`;
  const ids = `usb_${h.vendorId ?? '0000'}_${h.productId ?? '0000'}`;
  return h.bus !== undefined && h.device !== undefined
    ? `${ids}_${String(h.bus).padStart(3, '0')}_${String(h.device).padStart(3, '0')}`
    : ids;
}

export const HOSTDEV_KEY_RE = /^(?:pci_[0-9a-f]{4}_[0-9a-f]{2}_[0-9a-f]{2}_[0-7]|usb_[0-9a-f]{4}_[0-9a-f]{4}(?:_\d{3}_\d{3})?)$/;

const PCI_ADDRESS_RE = /^([0-9a-f]{4}):([0-9a-f]{2}):([0-9a-f]{2})\.([0-7])$/;
const HEX4_RE = /^[0-9a-f]{4}$/;

export function buildPciHostdevXml(address: string): string {
  const m = address.match(PCI_ADDRESS_RE);
  if (!m) throw new Error(`Invalid PCI address: ${address}`);
  // managed='yes': libvirt moves the device to vfio-pci when the VM starts and
  // gives it back to the host driver when the VM stops.
  return `<hostdev mode='subsystem' type='pci' managed='yes'>
  <driver name='vfio'/>
  <source>
    <address domain='0x${m[1]}' bus='0x${m[2]}' slot='0x${m[3]}' function='0x${parseInt(m[4], 10).toString(16)}'/>
  </source>
</hostdev>`;
}

export function buildUsbHostdevXml(vendorId: string, productId: string, at?: { bus: number; device: number }): string {
  if (!HEX4_RE.test(vendorId) || !HEX4_RE.test(productId)) throw new Error('Invalid USB vendor or product ID');
  if (at && (!Number.isInteger(at.bus) || !Number.isInteger(at.device) || at.bus < 1 || at.device < 1 || at.bus > 999 || at.device > 999)) {
    throw new Error('Invalid USB bus or device number');
  }
  // Matching by vendor and product survives the device being unplugged and
  // plugged back in; the bus/device pair is only added when an identical
  // device is also plugged in and libvirt could not otherwise tell them apart.
  const address = at ? `\n    <address bus='${at.bus}' device='${at.device}'/>` : '';
  return `<hostdev mode='subsystem' type='usb' managed='yes'>
  <source>
    <vendor id='0x${vendorId}'/>
    <product id='0x${productId}'/>${address}
  </source>
</hostdev>`;
}

/**
 * Remove every passed-through device from a definition. A clone or a VM
 * restored from a backup describes a different machine; handing it the
 * original's GPU would leave two VMs claiming one card.
 */
export function stripHostdevs(domainXml: string): { xml: string; removed: number } {
  let removed = 0;
  const xml = domainXml.replace(/[ \t]*<hostdev\b[^>]*>[\s\S]*?<\/hostdev>\n?/g, () => {
    removed++;
    return '';
  });
  return { xml, removed };
}

export function hasPciHostdev(domainXml: string): boolean {
  return parseHostdevs(domainXml).some((h) => h.type === 'pci');
}

/** Guest memory in KiB, from <memory> (the most the guest can be given). */
export function domainMemoryKib(domainXml: string): number | undefined {
  const m = domainXml.match(/<memory\b([^>]*)>(\d+)<\/memory>/);
  if (!m) return undefined;
  const unit = (attr(m[1], 'unit') ?? 'KiB').toLowerCase();
  const n = parseInt(m[2], 10);
  const factor: Record<string, number> = {
    b: 1 / 1024, bytes: 1 / 1024, kib: 1, k: 1, kb: 1000 / 1024, mib: 1024, m: 1024, mb: 1000 ** 2 / 1024,
    gib: 1024 ** 2, g: 1024 ** 2, gb: 1000 ** 3 / 1024, tib: 1024 ** 3, t: 1024 ** 3, tb: 1000 ** 4 / 1024,
  };
  return Math.round(n * (factor[unit] ?? 1));
}

/** The firmware a definition boots with. */
export function domainFirmware(domainXml: string): 'uefi' | 'bios' {
  return /<loader\b[^>]*type=['"]pflash['"]/.test(domainXml) || /<os\b[^>]*firmware=['"]efi['"]/.test(domainXml) ? 'uefi' : 'bios';
}

/**
 * Drop libvirt's cached backing chain from a definition, at any depth. The
 * chain nests one <backingStore> inside another, so a single lazy match would
 * stop at the innermost closing tag and leave an orphan behind; peel from the
 * inside out until none is left.
 */
export function stripBackingStores(domainXml: string): string {
  let xml = domainXml;
  for (let i = 0; i < 64; i++) {
    const next = xml
      .replace(/[ \t]*<backingStore\b[^>]*\/>\n?/g, '')
      .replace(/[ \t]*<backingStore\b[^>]*>(?:(?!<backingStore\b)[\s\S])*?<\/backingStore>\n?/g, '');
    if (next === xml) return xml;
    xml = next;
  }
  return xml;
}

/**
 * A hostdev element as it can go into another definition: without libvirt's
 * alias (a saved definition refuses one not prefixed "ua-") or the guest-side
 * address (the slot may be taken there), so libvirt places it afresh. The host
 * address inside <source> stays.
 */
export function portableHostdevXml(block: string): string {
  const source = block.match(/<source\b[\s\S]*?<\/source>/)?.[0] ?? '';
  const outside = block.replace(source, '\u0000SOURCE\u0000')
    .replace(/[ \t]*<alias\b[^>]*\/>\n?/g, '')
    .replace(/[ \t]*<address\b[^>]*\/>\n?/g, '');
  return outside.replace('\u0000SOURCE\u0000', source);
}
