import { describe, it, expect } from 'vitest';
import { parseDiskBusesFromXml } from './vmService.js';

// `virsh domblklist --details` prints "Type Device Target Source", and its Type is the
// source kind (file/block/network) — the Disks tab used to show "file" as every
// disk's bus. The bus lives on each disk's <target> in the domain XML.
const DOMAIN_XML = `<domain type='kvm'>
  <name>qa-vm</name>
  <devices>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='/var/lib/virtpilot/vms/x/disk.qcow2'/>
      <backingStore type='file'>
        <source file='/var/lib/virtpilot/templates/alpine.qcow2'/>
      </backingStore>
      <target dev='vda' bus='virtio'/>
      <boot order='1'/>
    </disk>
    <disk type='block' device='disk'>
      <source dev='/dev/vg0/data'/>
      <target bus="scsi" dev="sdc"/>
    </disk>
    <disk type='file' device='cdrom'>
      <source file='/var/lib/virtpilot/cloud-init/x-seed.iso'/>
      <target dev='sda' bus='sata'/>
      <readonly/>
    </disk>
    <disk type='file' device='cdrom'>
      <target dev='sdb' bus='sata'/>
      <readonly/>
    </disk>
    <interface type='bridge'>
      <target dev='vnet3'/>
      <model type='virtio'/>
    </interface>
  </devices>
</domain>`;

describe('parseDiskBusesFromXml', () => {
  it('reads each disk bus by target, in either attribute order', () => {
    const buses = parseDiskBusesFromXml(DOMAIN_XML);
    expect(buses.get('vda')).toBe('virtio');
    expect(buses.get('sdc')).toBe('scsi');
    expect(buses.get('sda')).toBe('sata');
    expect(buses.get('sdb')).toBe('sata');
  });

  it('ignores targets outside <disk> (an interface tap device is not a disk)', () => {
    const buses = parseDiskBusesFromXml(DOMAIN_XML);
    expect(buses.has('vnet3')).toBe(false);
    expect(buses.size).toBe(4);
  });

  it('skips a disk whose target has no bus rather than inventing one', () => {
    const xml = `<domain><devices><disk type='file' device='disk'><target dev='vdb'/></disk></devices></domain>`;
    expect(parseDiskBusesFromXml(xml).has('vdb')).toBe(false);
  });
});
