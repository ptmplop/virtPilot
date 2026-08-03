import { describe, it, expect } from 'vitest';
import { deriveDomainXml, toHostname } from './vmDeriveService.js';

// A realistic inactive dump: UEFI with NVRAM, two disks, a cloud-init seed on
// sda, a shared ISO on sdb, a NIC, and the seclabel/backingStore/alias cruft
// libvirt accumulates.
const SOURCE_XML = `<domain type='kvm'>
  <name>qa-src</name>
  <uuid>3633a961-f385-4494-8df1-237787710c4f</uuid>
  <os>
    <type arch='x86_64' machine='q35'>hvm</type>
    <loader readonly='yes' type='pflash'>/usr/share/OVMF/OVMF_CODE_4M.fd</loader>
    <nvram template='/usr/share/OVMF/OVMF_VARS_4M.fd'>/var/lib/virtpilot/vms/3633a961-f385-4494-8df1-237787710c4f/3633a961-f385-4494-8df1-237787710c4f-nvram.fd</nvram>
  </os>
  <devices>
    <disk type='file' device='disk'>
      <source file='/var/lib/virtpilot/vms/3633a961-f385-4494-8df1-237787710c4f/disk.qcow2'/>
      <backingStore type='file'>
        <source file='/var/lib/virtpilot/templates/alpine-3.21.qcow2'/>
      </backingStore>
      <target dev='vda' bus='virtio'/>
      <alias name='virtio-disk0'/>
    </disk>
    <disk type='file' device='disk'>
      <source file='/var/lib/virtpilot/vms/3633a961-f385-4494-8df1-237787710c4f/extra-disk-1.qcow2'/>
      <target dev='vdb' bus='virtio'/>
    </disk>
    <disk type='file' device='cdrom'>
      <source file='/var/lib/virtpilot/cloud-init/3633a961-f385-4494-8df1-237787710c4f-seed.iso'/>
      <target dev='sda' bus='sata'/>
      <readonly/>
    </disk>
    <disk type='file' device='cdrom'>
      <source file='/var/lib/virtpilot/isos/tools.iso'/>
      <target dev='sdb' bus='sata'/>
      <readonly/>
    </disk>
    <interface type='bridge'>
      <mac address='52:54:00:aa:bb:cc'/>
      <source bridge='vp0'/>
      <target dev='vnet3'/>
      <model type='virtio'/>
    </interface>
    <graphics type='vnc' port='5901' autoport='no' listen='127.0.0.1'/>
    <seclabel type='dynamic' model='apparmor' relabel='yes'>
      <label>libvirt-3633a961</label>
    </seclabel>
  </devices>
</domain>`;

const NEW_UUID = '9b3db5ff-2c6c-4588-9256-64fe25654997';

function derive(over: Partial<Parameters<typeof deriveDomainXml>[0]> = {}) {
  return deriveDomainXml({
    sourceXml: SOURCE_XML,
    newUuid: NEW_UUID,
    newName: 'qa-clone',
    diskPathByTarget: new Map([
      ['vda', `/var/lib/virtpilot/vms/${NEW_UUID}/disk.qcow2`],
      ['vdb', `/var/lib/virtpilot/vms/${NEW_UUID}/extra-disk-1.qcow2`],
    ]),
    nicMacs: [{ oldMac: '52:54:00:aa:bb:cc', newMac: '52:54:00:11:22:33' }],
    nvramPath: `/var/lib/virtpilot/vms/${NEW_UUID}/${NEW_UUID}-nvram.fd`,
    cloudInitIsoPath: `/var/lib/virtpilot/cloud-init/${NEW_UUID}-seed.iso`,
    ...over,
  });
}

describe('deriveDomainXml', () => {
  // The single assertion that matters most: nothing may still point at the
  // machine we copied from, or the two VMs fight over the same files.
  it('leaves no reference to the source VM anywhere', () => {
    expect(derive()).not.toContain('3633a961-f385-4494-8df1-237787710c4f');
  });

  it('re-keys name and uuid', () => {
    const xml = derive();
    expect(xml).toContain('<name>qa-clone</name>');
    expect(xml).toContain(`<uuid>${NEW_UUID}</uuid>`);
    expect(xml.match(/<name>/g)).toHaveLength(1);
  });

  it('repoints every data disk at the new VM, by target', () => {
    const xml = derive();
    expect(xml).toContain(`<source file="/var/lib/virtpilot/vms/${NEW_UUID}/disk.qcow2"/>`);
    expect(xml).toContain(`<source file="/var/lib/virtpilot/vms/${NEW_UUID}/extra-disk-1.qcow2"/>`);
  });

  it('gives the NIC a fresh MAC and drops the host tap device name', () => {
    const xml = derive();
    expect(xml).toContain('<mac address="52:54:00:11:22:33"/>');
    expect(xml).not.toContain('52:54:00:aa:bb:cc');
    // Two domains both claiming vnet3 collide at start time.
    expect(xml).not.toContain('vnet3');
  });

  it('moves NVRAM to the new VM so UEFI vars are not shared', () => {
    expect(derive()).toContain(`<nvram template='/usr/share/OVMF/OVMF_VARS_4M.fd'>/var/lib/virtpilot/vms/${NEW_UUID}/${NEW_UUID}-nvram.fd</nvram>`);
  });

  it('frees the VNC port so both VMs can run at once', () => {
    const xml = derive();
    expect(xml).toContain('port="-1"');
    expect(xml).toContain('autoport="yes"');
    expect(xml).not.toContain("port='5901'");
  });

  it('swaps the inherited cloud-init seed for the new VM own', () => {
    const xml = derive();
    expect(xml).toContain(`<source file="/var/lib/virtpilot/cloud-init/${NEW_UUID}-seed.iso"/>`);
  });

  it('ejects the inherited seed when no new one was generated', () => {
    const xml = derive({ cloudInitIsoPath: null });
    expect(xml).not.toContain('seed.iso');
  });

  // A shared ISO in a storage dir is read-only and safe for both VMs, so the
  // operator's setup is preserved rather than silently ejected.
  it('keeps a shared ISO attached', () => {
    expect(derive()).toContain('<source file=\'/var/lib/virtpilot/isos/tools.iso\'/>');
  });

  it('strips cached backing chains and security labels libvirt will regenerate', () => {
    const xml = derive();
    expect(xml).not.toContain('<backingStore');
    expect(xml).not.toContain('<seclabel');
    expect(xml).not.toContain('<alias');
  });

  it('escapes a hostile new name', () => {
    const xml = derive({ newName: 'x</name><name>evil' });
    expect(xml).toContain('&lt;/name&gt;');
    expect(xml.match(/<name>/g)).toHaveLength(1);
  });

  it('leaves a disk alone when no new path was supplied for its target', () => {
    const xml = derive({ diskPathByTarget: new Map([['vda', '/new/disk.qcow2']]) });
    expect(xml).toContain('<source file="/new/disk.qcow2"/>');
    // vdb keeps whatever it had rather than being silently blanked.
    expect(xml).toContain('extra-disk-1.qcow2');
  });

  it('is idempotent enough to re-derive from its own output', () => {
    const once = derive();
    const twice = deriveDomainXml({
      sourceXml: once,
      newUuid: NEW_UUID,
      newName: 'qa-clone',
      diskPathByTarget: new Map(),
      nicMacs: [],
      cloudInitIsoPath: null,
    });
    expect(twice).toContain('<name>qa-clone</name>');
    expect(twice.match(/<uuid>/g)).toHaveLength(1);
  });
});

describe('toHostname', () => {
  it('passes a valid hostname through', () => {
    expect(toHostname('web01')).toBe('web01');
    expect(toHostname('web.example.com')).toBe('web.example.com');
  });

  // VM names allow characters hostnames do not, and cloud-init rejects a bad
  // one outright — so cloning `web_01` must not fail on a technicality.
  it('coerces characters a hostname cannot carry', () => {
    expect(toHostname('web_01')).toBe('web-01');
    expect(toHostname('_build01')).toBe('build01');
    expect(toHostname('vm--name--')).toBe('vm--name');
  });

  it('falls back rather than returning something empty', () => {
    expect(toHostname('___')).toBe('vm');
    expect(toHostname('...')).toBe('vm');
  });

  it('bounds each label to 63 characters', () => {
    expect(toHostname('a'.repeat(100)).length).toBe(63);
  });
});
