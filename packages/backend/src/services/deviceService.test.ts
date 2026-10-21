import { describe, it, expect } from 'vitest';
import { entriesOf } from './deviceService.js';
import { parseHostdevs } from '../lib/hostdevXml.js';

// Measured on bp8: a USB device attached by IDs comes back from the running
// guest's definition with the bus and device number libvirt resolved.
describe('entriesOf', () => {
  it('treats the saved and the running copy of one USB device as one device', () => {
    const config = parseHostdevs(`<hostdev mode='subsystem' type='usb' managed='yes'>
      <source><vendor id='0x0b1f'/><product id='0x03e9'/></source></hostdev>`);
    const live = parseHostdevs(`<hostdev mode='subsystem' type='usb' managed='yes'>
      <source><vendor id='0x0b1f'/><product id='0x03e9'/><address bus='1' device='3'/></source>
      <alias name='hostdev0'/><address type='usb' bus='0' port='1'/></hostdev>`);
    const entries = entriesOf({ config, live });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: 'usb_0b1f_03e9', inConfig: true, inLive: true });
    expect(entries[0].liveXml).toContain("<alias name='hostdev0'/>");
  });

  it('keeps a device attached by address apart from one attached by IDs', () => {
    const config = parseHostdevs(`<hostdev mode='subsystem' type='usb'><source><vendor id='0x1050'/><product id='0x0407'/><address bus='1' device='4'/></source></hostdev>`);
    const entries = entriesOf({ config, live: config });
    expect(entries.map((e) => [e.key, e.inConfig, e.inLive])).toEqual([['usb_1050_0407_001_004', true, true]]);
  });

  it('marks a device only the running guest still has', () => {
    const live = parseHostdevs(`<hostdev mode='subsystem' type='pci' managed='yes'><source><address domain='0x0000' bus='0x18' slot='0x00' function='0x1'/></source></hostdev>`);
    expect(entriesOf({ config: [], live })).toMatchObject([{ key: 'pci_0000_18_00_1', inConfig: false, inLive: true }]);
  });
});
