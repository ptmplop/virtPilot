import { describe, it, expect } from 'vitest';
import { explainMissingNetwork, isNoSuchVm, mergeNicDefinitions, parseDiskBusesFromXml, parseDomainLists, parseInterfacesFromXml, parseNetInfoBridge, saysNoSuchVm, unplugNicsInXml, withBridgeSources } from './vmService.js';
import { NetworkError } from './networkService.js';

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

  it('leaves a NIC on a bridge alone', () => {
    expect(withBridgeSources([nic('bridge', 'vpbr100'), nic('bridge', 'br0')], networks)).toEqual([nic('bridge', 'vpbr100'), nic('bridge', 'br0')]);
  });

  // A device can't be called this: `virtpilot-<id>` is over the kernel's 15 characters, and a foreign
  // network with the name of a real device is left out of the list by osBridgeOwners.
  it('knows a running VM says bridge of a NIC on a libvirt network in bridge mode, and keeps it one row', () => {
    const owner = [{ bridge: 'br0', libvirtName: 'host-bridge' }];
    expect(withBridgeSources([nic('bridge', 'host-bridge')], owner)).toEqual([nic('bridge', 'br0')]);
    expect(mergeNicDefinitions(withBridgeSources([nic('bridge', 'host-bridge')], owner), withBridgeSources([nic('network', 'host-bridge')], owner)))
      .toEqual([{ ...nic('bridge', 'br0'), savedType: 'network' }]);
  });

  it('never takes a macvtap NIC for a bridge', () => {
    expect(withBridgeSources([nic('direct', 'macv')], [{ bridge: 'br0', libvirtName: 'macv' }])).toEqual([nic('direct', 'macv')]);
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

describe('parseNetInfoBridge', () => {
  it('reads the bridge of a libvirt network', () => {
    expect(parseNetInfoBridge('Name:           rig\nUUID:           x\nActive:         yes\nBridge:         rigos0\n')).toBe('rigos0');
  });
  it('finds none on a network in macvtap mode', () => {
    expect(parseNetInfoBridge('Name:           macv\nActive:         yes\nPersistent:     yes\n')).toBeNull();
  });
});

describe('parseInterfacesFromXml', () => {
  it('reads every NIC in the order the XML has them, however it is attached', () => {
    const xml = `<domain><devices>
      <disk type='file'><source file='/x'/><target dev='vda'/></disk>
      <interface type='network'><mac address='52:54:00:00:00:01'/><source network='virtpilot-1'/><model type='virtio'/></interface>
      <interface type='bridge'><mac address="52:54:00:00:00:02"/><source bridge="vp0"/><model type="e1000"/></interface>
      <interface type='direct'><mac address='52:54:00:00:00:03'/><source dev='eth0' mode='bridge'/></interface>
      <interface type='user'><mac address='52:54:00:00:00:04'/></interface>
    </devices></domain>`;
    expect(parseInterfacesFromXml(xml)).toEqual([
      { mac: '52:54:00:00:00:01', model: 'virtio', source: 'virtpilot-1' },
      { mac: '52:54:00:00:00:02', model: 'e1000', source: 'vp0' },
      { mac: '52:54:00:00:00:03', model: '-', source: 'eth0' },
      { mac: '52:54:00:00:00:04', model: '-', source: '-' },
    ]);
  });
  it('has nothing to say of a VM with no NICs', () => {
    expect(parseInterfacesFromXml('<domain><devices></devices></domain>')).toEqual([]);
  });
});

describe('saysNoSuchVm', () => {
  it('knows what virsh prints for a VM it has no record of', () => {
    expect(saysNoSuchVm("error: failed to get domain 'web-01'\n")).toBe(true);
    expect(saysNoSuchVm("\nerror: failed to get domain 'web-01'\nerror: Domain not found: no domain with matching name 'web-01'\n")).toBe(true);
  });

  it('never reads a libvirt that can\'t say as a VM that has gone', () => {
    expect(saysNoSuchVm('')).toBe(false);
    expect(saysNoSuchVm("error: failed to connect to the hypervisor\nerror: Failed to connect socket to '/run/libvirt/libvirt-sock': No such file or directory\n")).toBe(false);
    expect(saysNoSuchVm("error: failed to get domain 'web-01'\nerror: End of file while reading data: Input/output error\n")).toBe(false);
    expect(saysNoSuchVm('error: Disconnected from qemu:///system due to end of file')).toBe(false);
  });
});

describe('isNoSuchVm', () => {
  it('goes by what virsh printed, and a timeout printed nothing', () => {
    expect(isNoSuchVm({ stderr: "error: failed to get domain 'web-01'" })).toBe(true);
    expect(isNoSuchVm({ killed: true, stderr: '' })).toBe(false);
    expect(isNoSuchVm(new Error('libvirt could not list the NICs of web-01'))).toBe(false);
    expect(isNoSuchVm(new NetworkError('There is no VM web-01.', 404))).toBe(true);
  });
});

describe('parseDomainLists', () => {
  const table = (...rows: string[]) => [' Id   Name   State', '------------------', ...rows].join('\n');

  it('joins the two listings, running or not', () => {
    expect(parseDomainLists(table(' 2    db-01          running', ' -    build-runner   shut off', ' 5    held           paused'),
      '061280f2-abab-454b-b016-b02d42778de2 db-01\n111-222 build-runner\n333-444 held')).toEqual([
      { id: '061280f2-abab-454b-b016-b02d42778de2', name: 'db-01', status: 'running' },
      { id: '111-222', name: 'build-runner', status: 'stopped' },
      { id: '333-444', name: 'held', status: 'paused' },
    ]);
  });

  it('keeps names with spaces, however many, apart', () => {
    expect(parseDomainLists(table(' -    lab      shut off', ' -    lab  a   shut off', ' 7    lab  b   running', ' -    one two  shut off'),
      'u1 lab\nu2 lab  a\nu3 lab  b\nu4 one two')).toEqual([
      { id: 'u1', name: 'lab', status: 'stopped' },
      { id: 'u2', name: 'lab  a', status: 'stopped' },
      { id: 'u3', name: 'lab  b', status: 'running' },
      { id: 'u4', name: 'one two', status: 'stopped' },
    ]);
  });

  it('has nothing to say of a host with no VMs, whose second listing prints nothing', () => {
    expect(parseDomainLists(table(), null)).toEqual([]);
  });

  it('throws where a listing failed or the two don\'t add up, as a VM dropped here would pass a guard', () => {
    expect(() => parseDomainLists(null, 'u1 db-01')).toThrow('could not list');
    expect(() => parseDomainLists(table(' 2    db-01   running'), null)).toThrow('could not list');
    expect(() => parseDomainLists(table(' 2    db-01   running', ' -    b       shut off'), 'u1 db-01')).toThrow('could not list');
  });

  it('calls a state it doesn\'t know unknown, which counts as not stopped', () => {
    expect(parseDomainLists(table(' 3    a   in shutdown', ' 4    b   pmsuspended'), 'u1 a\nu2 b').map((v) => v.status)).toEqual(['unknown', 'unknown']);
  });
});

describe('parseInterfacesFromXml, a running VM on a libvirt network', () => {
  it('goes by the network, which is what is in the saved definition, and not its bridge', () => {
    const xml = `<interface type='bridge'><mac address='52:54:00:00:00:01'/><source network='lab' portid='x' bridge='virbr7'/><model type='virtio'/></interface>`;
    expect(parseInterfacesFromXml(xml)[0].source).toBe('lab');
  });
});

describe('unplugNicsInXml', () => {
  const xml = `<domainsnapshot><domain>
    <interface type='bridge'><mac address='52:54:00:00:00:01'/><source bridge='vp3'/><target dev='vnet4'/><model type='virtio'/><address type='pci' bus='0x01'/></interface>
    <interface type='network'><mac address='52:54:00:00:00:02'/><source network='lab' portid='x' bridge='vp4'/><model type='virtio'/></interface>
  </domain></domainsnapshot>`;

  it('leaves the guest its device, connected to nothing', () => {
    const out = unplugNicsInXml(xml, ['52:54:00:00:00:01']);
    expect(out).toContain("<interface type='ethernet'><mac address='52:54:00:00:00:01'/><model type='virtio'/><address type='pci' bus='0x01'/></interface>");
  });

  it('touches no other NIC', () => {
    expect(unplugNicsInXml(xml, ['52:54:00:00:00:01'])).toContain("<source network='lab' portid='x' bridge='vp4'/>");
  });

  it('does nothing with none to unplug', () => {
    expect(unplugNicsInXml(xml, [])).toBe(xml);
  });
});
