import { describe, it, expect } from 'vitest';
import { buildDomainXml, generateMac } from './xmlBuilder.js';

const base = {
  uuid: '3633a961-f385-4494-8df1-237787710c4f',
  name: 'qa-vm',
  cpus: 2,
  memoryMb: 1024,
  diskPath: '/var/lib/virtpilot/vms/x/disk.qcow2',
  cloudInitIsoPath: '/var/lib/virtpilot/cloud-init/x-seed.iso',
  nics: [{ bridge: 'vp0', mac: '52:54:00:ab:cd:ef', model: 'virtio' }],
  // Pin so output doesn't depend on whether the test box has /dev/kvm.
  useKvm: false,
};

describe('buildDomainXml', () => {
  it('emits the identity and devices it was given', () => {
    const xml = buildDomainXml(base);
    expect(xml).toContain('<name>qa-vm</name>');
    expect(xml).toContain(`<uuid>${base.uuid}</uuid>`);
    expect(xml).toContain('<vcpu placement="static">2</vcpu>');
    expect(xml).toContain('<memory unit="KiB">1048576</memory>');
    expect(xml).toContain(`<source file="${base.diskPath}"/>`);
    expect(xml).toContain('<mac address="52:54:00:ab:cd:ef"/>');
    expect(xml).toContain('<source bridge="vp0"/>');
    expect(xml).toContain('<domain type="qemu">');
  });

  // 2.6.0: nicModel reached the generated XML unescaped, so a crafted value
  // could close the attribute and append devices — an extra <disk> pointing at
  // a host block device, say — into a domain that virsh define then persisted.
  it('escapes a NIC model that tries to break out of its attribute', () => {
    const xml = buildDomainXml({
      ...base,
      nics: [{
        bridge: 'vp0',
        mac: '52:54:00:ab:cd:ef',
        model: 'virtio"/><disk type="block" device="disk"><source dev="/dev/sda"/></disk><model type="virtio',
      }],
    });
    expect(xml).not.toContain('<source dev="/dev/sda"/>');
    expect(xml).toContain('&quot;');
    // Exactly the disks the builder is supposed to emit: one disk, two cdroms.
    expect(xml.match(/<disk /g)).toHaveLength(3);
  });

  it('escapes a bridge name and a disk path containing XML metacharacters', () => {
    const xml = buildDomainXml({
      ...base,
      diskPath: '/mnt/a&b/disk.qcow2',
      nics: [{ bridge: 'vp0"/><x/>', mac: '52:54:00:ab:cd:ef' }],
    });
    expect(xml).toContain('/mnt/a&amp;b/disk.qcow2');
    expect(xml).not.toContain('<x/>');
  });

  it('escapes the VM name', () => {
    const xml = buildDomainXml({ ...base, name: 'vm</name><name>evil' });
    expect(xml).toContain('&lt;/name&gt;');
    expect(xml.match(/<name>/g)).toHaveLength(1);
  });

  // Callers only truthiness-check these, so a NaN could reach the sink and be
  // spliced into XML that virsh define persists.
  it('coerces a non-finite cpu or memory rather than emitting NaN', () => {
    const xml = buildDomainXml({ ...base, cpus: NaN as unknown as number, memoryMb: NaN as unknown as number });
    expect(xml).not.toContain('NaN');
    expect(xml).toContain('<vcpu placement="static">1</vcpu>');
  });

  it('attaches the install ISO and a cdrom boot entry for an ISO install', () => {
    const xml = buildDomainXml({
      ...base,
      cloudInitIsoPath: undefined,
      installIsoPath: '/var/lib/virtpilot/isos/qa.iso',
    });
    expect(xml).toContain('<source file="/var/lib/virtpilot/isos/qa.iso"/>');
    expect(xml).toContain('<boot dev="cdrom"/>');
  });

  it('includes the guest-agent channel every VM relies on', () => {
    expect(buildDomainXml(base)).toContain('org.qemu.guest_agent.0');
  });

  it('adds a TPM only when asked', () => {
    expect(buildDomainXml(base)).not.toContain('<tpm');
    expect(buildDomainXml({ ...base, vtpm: true })).toContain('<tpm model="tpm-tis">');
  });
});

describe('generateMac', () => {
  it('uses the QEMU OUI and is well-formed', () => {
    for (let i = 0; i < 50; i++) {
      const mac = generateMac();
      expect(mac).toMatch(/^52:54:00:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}$/);
    }
  });

  it('does not collide across a reasonable sample', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateMac()));
    // 24 bits of entropy: a handful of collisions in 500 would be unremarkable,
    // but anything close to a constant generator would not be.
    expect(seen.size).toBeGreaterThan(490);
  });
});
