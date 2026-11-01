import { describe, it, expect } from 'vitest';
import { explainMissingNetwork, mergeNicDefinitions, parseDiskBusesFromXml, withBridgeSources } from './vmService.js';

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

describe('withBridgeSources', () => {
  const networks = [{ bridge: 'vpbr100', libvirtName: 'virtpilot-6adce98d' }, { bridge: 'br0' }];
  const nic = (type: string, source: string) => ({ mac: '52:54:00:00:00:01', model: 'virtio', target: '-', type, source });

  it('gives a NIC attached by the network\'s name its bridge, and keeps how it is attached', () => {
    expect(withBridgeSources([nic('network', 'virtpilot-6adce98d')], networks)).toEqual([nic('network', 'vpbr100')]);
  });

  it('leaves a NIC on a bridge alone, even one called what a libvirt network is called', () => {
    expect(withBridgeSources([nic('bridge', 'vpbr100'), nic('bridge', 'virtpilot-6adce98d')], networks))
      .toEqual([nic('bridge', 'vpbr100'), nic('bridge', 'virtpilot-6adce98d')]);
  });

  it('keeps the name of a libvirt network VirtPilot doesn\'t know', () => {
    expect(withBridgeSources([nic('network', 'default')], networks)).toEqual([nic('network', 'default')]);
  });

  it('matches on the libvirt name, not the bridge', () => {
    expect(withBridgeSources([nic('network', 'br0')], networks)).toEqual([nic('network', 'br0')]);
  });

  it('does not touch the list it was given', () => {
    const given = [nic('network', 'virtpilot-6adce98d')];
    withBridgeSources(given, networks);
    expect(given[0].source).toBe('virtpilot-6adce98d');
  });
});

describe('mergeNicDefinitions', () => {
  const nic = (mac: string, target: string) => ({ mac, model: 'virtio', target, type: 'bridge', source: 'vp0' });

  it('leaves a NIC in both as it was, with its tap', () => {
    expect(mergeNicDefinitions([nic('52:54:00:00:00:01', 'vnet0')], [nic('52:54:00:00:00:01', '-')]))
      .toEqual([nic('52:54:00:00:00:01', 'vnet0')]);
  });

  it('finds a NIC saved for the next boot, which the live listing hides', () => {
    expect(mergeNicDefinitions([nic('52:54:00:00:00:01', 'vnet0')], [nic('52:54:00:00:00:01', '-'), nic('52:54:00:00:00:02', '-')]))
      .toEqual([nic('52:54:00:00:00:01', 'vnet0'), { ...nic('52:54:00:00:00:02', '-'), onlyIn: 'saved' }]);
  });

  it('marks a NIC plugged in only until the next boot', () => {
    expect(mergeNicDefinitions([nic('52:54:00:00:00:01', 'vnet0')], []))
      .toEqual([{ ...nic('52:54:00:00:00:01', 'vnet0'), onlyIn: 'live' }]);
  });

  it('matches MACs whatever their case', () => {
    expect(mergeNicDefinitions([nic('52:54:00:AA:00:01', 'vnet0')], [nic('52:54:00:aa:00:01', '-')]))
      .toEqual([nic('52:54:00:AA:00:01', 'vnet0')]);
  });

  it('keeps both when the saved definition has the MAC on another network', () => {
    const live = nic('52:54:00:00:00:01', 'vnet0');
    const saved = { ...nic('52:54:00:00:00:01', '-'), source: 'vp1' };
    expect(mergeNicDefinitions([live], [saved])).toEqual([{ ...live, onlyIn: 'live' }, { ...saved, onlyIn: 'saved' }]);
  });

  it('keeps one NIC when a running VM calls it something else, as on a libvirt network in bridge mode', () => {
    const live = nic('52:54:00:00:00:01', 'vnet0');
    const saved = { ...nic('52:54:00:00:00:01', '-'), type: 'network' };
    expect(mergeNicDefinitions([live], [saved])).toEqual([{ ...live, savedType: 'network' }]);
  });

  it('has nothing to mark on a stopped VM, whose two listings agree', () => {
    const both = [nic('52:54:00:00:00:01', '-'), nic('52:54:00:00:00:02', '-')];
    expect(mergeNicDefinitions(both, both)).toEqual(both);
  });
});

describe('explainMissingNetwork', () => {
  const networks = [{ bridge: 'vpbr100', libvirtName: 'virtpilot-6adce98d' }, { bridge: 'br0' }];

  it('names the bridge of a NIC on a bridge that has gone', () => {
    expect(explainMissingNetwork("error: Cannot get interface MTU on 'vp2': No such device", networks))
      .toBe('This VM has a NIC on vp2, and that network is not running on this host. Check it on the Networks page, or remove the NIC.');
  });

  it('says the same of a NIC attached by the name of a network VirtPilot knows', () => {
    const said = 'This VM has a NIC on vpbr100, and that network is not running on this host. Check it on the Networks page, or remove the NIC.';
    expect(explainMissingNetwork("error: Requested operation is not valid: network 'virtpilot-6adce98d' is not active", networks)).toBe(said);
    expect(explainMissingNetwork("error: Network not found: no network with matching name 'virtpilot-6adce98d'", networks)).toBe(said);
  });

  it('points at virsh, not the Networks page, for a stopped network VirtPilot doesn\'t know', () => {
    const said = explainMissingNetwork("error: Requested operation is not valid: network 'default' is not active", networks);
    expect(said).toContain('virsh net-start default');
    expect(said).not.toContain('Networks page');
  });

  it('says a network VirtPilot doesn\'t know has gone, when it has', () => {
    const said = explainMissingNetwork("error: Network not found: no network with matching name 'lab'", networks);
    expect(said).toContain('lab, which no longer exists');
    expect(said).not.toContain('Networks page');
  });

  it('has nothing to say about any other failure', () => {
    expect(explainMissingNetwork('error: internal error: qemu unexpectedly closed the monitor', networks)).toBeNull();
  });
});
