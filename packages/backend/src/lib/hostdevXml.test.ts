import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  buildPciHostdevXml, buildUsbHostdevXml, domainFirmware, domainMemoryKib, hasPciHostdev, hostdevKey, HOSTDEV_KEY_RE,
  parseHostdevs, portableHostdevXml, stripBackingStores, stripHostdevs,
} from './hostdevXml.js';

// The <devices> of a real VM on bp8 (libvirt 10.0) with an X550 port passed
// through: libvirt adds the guest-side <address> after <source>.
const realDevices = fs.readFileSync(path.join(__dirname, '__fixtures__', 'domain-devices.xml'), 'utf8');

describe('parseHostdevs', () => {
  it('reads the host address, not the guest-side one', () => {
    const [h] = parseHostdevs(realDevices);
    expect(h).toMatchObject({ type: 'pci', address: '0000:18:00.1' });
    expect(hostdevKey(h)).toBe('pci_0000_18_00_1');
  });

  it('reads USB devices by IDs, with a bus and device when given', () => {
    const xml = `<devices>
      <hostdev mode='subsystem' type='usb' managed='yes'>
        <source><vendor id='0x1050'/><product id='0x0407'/><address bus='1' device='4'/></source>
      </hostdev>
      <hostdev mode='subsystem' type='usb'><source><vendor id='0x046d'/><product id='0xc52b'/></source></hostdev>
    </devices>`;
    const [a, b] = parseHostdevs(xml);
    expect(a).toMatchObject({ type: 'usb', vendorId: '1050', productId: '0407', bus: 1, device: 4 });
    expect(hostdevKey(a)).toBe('usb_1050_0407_001_004');
    expect(hostdevKey(b)).toBe('usb_046d_c52b');
    expect([a, b].every((h) => HOSTDEV_KEY_RE.test(hostdevKey(h)))).toBe(true);
  });

  it('skips capability-mode hostdevs (containers)', () => {
    expect(parseHostdevs("<hostdev mode='capabilities' type='storage'><source><block>/dev/sdf1</block></source></hostdev>")).toEqual([]);
  });

  it('round-trips what VirtPilot writes', () => {
    expect(parseHostdevs(buildPciHostdevXml('0000:3b:00.0'))[0]).toMatchObject({ type: 'pci', address: '0000:3b:00.0' });
    expect(parseHostdevs(buildPciHostdevXml('0001:af:1f.7'))[0]).toMatchObject({ address: '0001:af:1f.7' });
    expect(parseHostdevs(buildUsbHostdevXml('1050', '0407', { bus: 1, device: 4 }))[0]).toMatchObject({ bus: 1, device: 4 });
  });

  it('refuses anything that is not an address or an ID', () => {
    expect(() => buildPciHostdevXml("0000:3b:00.0'/><disk")).toThrow();
    expect(() => buildUsbHostdevXml('10500', '0407')).toThrow();
    expect(() => buildUsbHostdevXml('1050', '0407', { bus: 0, device: 4 })).toThrow();
  });
});

describe('stripHostdevs', () => {
  it('removes every passed-through device and counts them', () => {
    const { xml, removed } = stripHostdevs(realDevices + buildUsbHostdevXml('1050', '0407'));
    expect(removed).toBe(2);
    expect(xml).not.toContain('<hostdev');
    expect(hasPciHostdev(xml)).toBe(false);
    expect(hasPciHostdev(realDevices)).toBe(true);
  });
});

describe('domain facts', () => {
  it('reads memory in any unit as KiB', () => {
    expect(domainMemoryKib("<memory unit='KiB'>16777216</memory>")).toBe(16777216);
    expect(domainMemoryKib("<memory unit='GiB'>16</memory>")).toBe(16777216);
    expect(domainMemoryKib('<memory>2048</memory>')).toBe(2048);
  });

  it('tells UEFI from BIOS', () => {
    expect(domainFirmware("<os><loader readonly='yes' type='pflash'>/usr/share/OVMF/OVMF_CODE_4M.fd</loader></os>")).toBe('uefi');
    expect(domainFirmware("<os firmware='efi'><type>hvm</type></os>")).toBe('uefi');
    expect(domainFirmware('<os><type>hvm</type></os>')).toBe('bios');
  });
});

describe('stripBackingStores', () => {
  // After two disk-only snapshots libvirt caches the chain two levels deep. A single
  // lazy match stopped at the inner closing tag and left an orphan, which virsh define
  // rejected, so the AppArmor fix silently did nothing.
  it('removes a nested cache whole', () => {
    const xml = `<disk type='file' device='disk'>
      <source file='s2.qcow2'/>
      <backingStore type='file'>
        <format type='qcow2'/>
        <source file='s1.qcow2'/>
        <backingStore type='file'>
          <format type='qcow2'/>
          <source file='disk.qcow2'/>
          <backingStore/>
        </backingStore>
      </backingStore>
      <target dev='vda' bus='virtio'/>
    </disk>`;
    const out = stripBackingStores(xml);
    expect(out).not.toContain('backingStore');
    expect(out).toContain("<source file='s2.qcow2'/>");
    expect(out).toContain("<target dev='vda' bus='virtio'/>");
    expect(out.match(/<\/disk>/g)).toHaveLength(1);
  });

  it('leaves a definition without a cache alone', () => {
    expect(stripBackingStores(realDevices)).toBe(realDevices);
  });
});

describe('portableHostdevXml', () => {
  it('drops the alias and the guest slot, keeps the host address', () => {
    const [h] = parseHostdevs(`<hostdev mode='subsystem' type='pci' managed='yes'>
      <driver name='vfio'/>
      <source>
        <address domain='0x0000' bus='0x3b' slot='0x00' function='0x0'/>
      </source>
      <alias name='hostdev0'/>
      <address type='pci' domain='0x0000' bus='0x07' slot='0x00' function='0x0'/>
    </hostdev>`);
    const out = portableHostdevXml(h.xml);
    expect(out).not.toContain('alias');
    expect(out).not.toContain("bus='0x07'");
    expect(parseHostdevs(out)[0]).toMatchObject({ type: 'pci', address: '0000:3b:00.0' });
  });
});
