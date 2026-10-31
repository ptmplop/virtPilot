import { describe, it, expect } from 'vitest';
import {
  VNI_MAX,
  VxlanInputError,
  defaultVxlanMtu,
  dhcpRange,
  nextFreeVni,
  parseFdb,
  parsePeers,
  parseVni,
  parseVxlanLinks,
  parseVxlanMtu,
  parseVxlanPort,
  planTunnel,
  vniMatch,
  vxlanBridgeName,
  vxlanDeviceName,
  tunnelsListening,
  vxlanFirewallRestore,
  vxlanNetworkXml,
  type TunnelWanted,
  type VxlanLink,
} from './vxlan.js';

describe('parseVni', () => {
  it('takes the whole 24-bit range, as a number or as text from a form', () => {
    expect(parseVni(1)).toBe(1);
    expect(parseVni(VNI_MAX)).toBe(16777215);
    expect(parseVni(' 200 ')).toBe(200);
  });

  // The kernel accepts 0 (measured), but many switches treat it as "no VNI".
  it.each([0, -1, 16777216, 1.5, NaN, '', 'abc', '10; rm -rf /', '1e3', null, undefined, {}, [], true])(
    'refuses %j',
    (bad) => {
      expect(() => parseVni(bad)).toThrow(VxlanInputError);
    },
  );
});

describe('nextFreeVni', () => {
  it('starts at 100 on a host with none', () => {
    expect(nextFreeVni([])).toBe(100);
  });

  it('takes the lowest gap, so a deleted ID comes back', () => {
    expect(nextFreeVni([100, 101, 103])).toBe(102);
  });

  it('ignores IDs below where it starts', () => {
    expect(nextFreeVni([1, 2, 50])).toBe(100);
  });

  it('wraps round to the low IDs when the top is full', () => {
    expect(nextFreeVni([VNI_MAX], VNI_MAX)).toBe(1);
  });

  it('can start anywhere', () => {
    expect(nextFreeVni([1, 2, 3], 1)).toBe(4);
  });
});

describe('parsePeers', () => {
  it('reads text from a form or an array from the API', () => {
    expect(parsePeers('10.0.0.1, 10.0.0.2\n10.0.0.3 ')).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    expect(parsePeers(['192.0.2.7'])).toEqual(['192.0.2.7']);
    expect(parsePeers(undefined)).toEqual([]);
    expect(parsePeers('')).toEqual([]);
  });

  it('drops repeats and normalises leading zeros', () => {
    expect(parsePeers('010.000.000.001 10.0.0.1')).toEqual(['10.0.0.1']);
  });

  it('refuses an address on the VXLAN itself: the tunnel would run through itself', () => {
    expect(() => parsePeers('10.20.0.5', [], (ip) => ip.startsWith('10.20.0.'))).toThrow(/through itself/);
    expect(parsePeers('10.30.0.5', [], (ip) => ip.startsWith('10.20.0.'))).toEqual(['10.30.0.5']);
  });

  it('refuses this host, so a tunnel can never flood to itself', () => {
    expect(() => parsePeers('10.0.0.1', ['10.0.0.1'])).toThrow(/is this host/);
  });

  it.each(['0.0.0.0', '127.0.0.1', '224.0.0.1', '239.1.1.1', '255.255.255.255', '256.0.0.1', '::1', 'host.example', '10.0.0.1/24', '10.0.0.1;id'])(
    'refuses %s',
    (bad) => {
      expect(() => parsePeers(bad)).toThrow(VxlanInputError);
    },
  );

  it('refuses things that are not lists', () => {
    expect(() => parsePeers(7)).toThrow(VxlanInputError);
    expect(() => parsePeers([7])).toThrow(VxlanInputError);
  });

  it('caps the list: every broadcast frame is copied to each of them', () => {
    const many = Array.from({ length: 65 }, (_, i) => `10.0.1.${i + 1}`);
    expect(parsePeers(many.slice(0, 64))).toHaveLength(64);
    expect(() => parsePeers(many)).toThrow(/at most 64/);
  });
});

describe('MTU and port', () => {
  // A frame at the MTU with two VLAN tags, in its outer headers, must fit one packet
  // of the link: a guest's tagged traffic is never fragmented on the way between hosts.
  it('leaves room for two VLAN tags inside the outer packet', () => {
    const frame = defaultVxlanMtu(1500) + 14 + 2 * 4;
    expect(frame + 8 + 8 + 20).toBe(1500);
  });

  it('fits inside the link it runs over', () => {
    expect(defaultVxlanMtu(1500)).toBe(1442);
    expect(defaultVxlanMtu(1400)).toBe(1342);
  });

  it('stays at the Ethernet size on jumbo links: the far end may not have them', () => {
    expect(defaultVxlanMtu(9000)).toBe(1442);
  });

  it('assumes Ethernet when the link is unknown', () => {
    expect(defaultVxlanMtu(null)).toBe(1442);
  });

  it('takes no true for a 1', () => {
    expect(() => parseVxlanPort(true)).toThrow(VxlanInputError);
    expect(() => parseVxlanMtu(true)).toThrow(VxlanInputError);
    expect(() => parseVxlanPort('80a')).toThrow(VxlanInputError);
  });

  it('validates what is asked for', () => {
    expect(parseVxlanMtu(undefined)).toBeUndefined();
    expect(parseVxlanMtu('')).toBeUndefined();
    expect(parseVxlanMtu('1400')).toBe(1400);
    expect(() => parseVxlanMtu(100)).toThrow(VxlanInputError);
    expect(() => parseVxlanMtu(10000)).toThrow(VxlanInputError);
    expect(parseVxlanPort(undefined)).toBe(4789);
    expect(parseVxlanPort('8472')).toBe(8472);
    expect(() => parseVxlanPort(70000)).toThrow(VxlanInputError);
  });
});

describe('vxlanNetworkXml', () => {
  const base = { libvirtName: 'virtpilot-abcd1234', bridge: 'vp3', mtu: 1450 };

  it('never forwards off the network, and takes no part in naming', () => {
    const xml = vxlanNetworkXml(base);
    expect(xml).not.toContain('<forward');
    expect(xml).toContain("<dns enable='no'/>");
    expect(xml).toContain("<bridge name='vp3' stp='off' delay='0'/>");
    expect(xml).toContain("<mtu size='1450'/>");
  });

  it('has no address of the host when VirtPilot hands out none', () => {
    expect(vxlanNetworkXml(base)).not.toContain('<ip');
  });

  it('runs DHCP when asked', () => {
    const xml = vxlanNetworkXml({ ...base, dhcp: { address: '10.0.2.1', prefix: 24, start: '10.0.2.2', end: '10.0.2.254' } });
    expect(xml).toContain("<ip address='10.0.2.1' prefix='24'>");
    expect(xml).toContain("<range start='10.0.2.2' end='10.0.2.254'/>");
  });

  it('escapes what it is given', () => {
    expect(vxlanNetworkXml({ ...base, bridge: "x'/><evil" })).not.toContain('<evil');
  });
});

describe('dhcpRange', () => {
  it('skips the host when it holds the first address', () => {
    expect(dhcpRange('10.0.2.1', '10.0.2.254', '10.0.2.1')).toEqual({ start: '10.0.2.2', end: '10.0.2.254' });
  });

  it('skips the host when it holds the last address', () => {
    expect(dhcpRange('10.0.2.1', '10.0.2.2', '10.0.2.2')).toEqual({ start: '10.0.2.1', end: '10.0.2.1' });
  });

  it('steps over the octet boundary', () => {
    expect(dhcpRange('10.0.0.255', '10.0.3.254', '10.0.0.255').start).toBe('10.0.1.0');
  });

  it('leaves a host in the middle to dnsmasq, which never offers its own address', () => {
    expect(dhcpRange('10.0.2.1', '10.0.2.254', '10.0.2.50')).toEqual({ start: '10.0.2.1', end: '10.0.2.254' });
  });
});

describe('firewall rules', () => {
  it('matches the ID in the VXLAN header, past an IP header of any length', () => {
    expect(vniMatch(100)).toBe('0>>22&0x3C@12>>8=100');
  });

  it('allows the listed hosts on that VXLAN, then drops everyone else on it', () => {
    const restore = vxlanFirewallRestore([{ vni: 100, port: 4789, peers: ['192.0.2.1', '192.0.2.2'] }]);
    expect(restore.split('\n')).toEqual([
      '*filter',
      ':VP-VXLAN - [0:0]',
      '-A VP-VXLAN -s 192.0.2.1 -p udp -m udp --dport 4789 -m u32 --u32 "0>>22&0x3C@12>>8=100" -j ACCEPT',
      '-A VP-VXLAN -s 192.0.2.2 -p udp -m udp --dport 4789 -m u32 --u32 "0>>22&0x3C@12>>8=100" -j ACCEPT',
      '-A VP-VXLAN -p udp -m udp --dport 4789 -m u32 --u32 "0>>22&0x3C@12>>8=100" -j DROP',
      'COMMIT',
      '',
    ]);
  });

  it('has no rule for a VXLAN with no remote hosts: its device is down, so nothing listens', () => {
    const tunnels = [{ vni: 100, port: 4789, peers: [] }, { vni: 101, port: 4789, peers: ['192.0.2.1'] }];
    const restore = vxlanFirewallRestore(tunnels);
    expect(restore).not.toContain('=100"');
    expect(restore).toContain('=101"');
  });

  it('still guards a device that would not go down, with no remote hosts to allow', () => {
    const restore = vxlanFirewallRestore([{ vni: 100, port: 4789, peers: [], stuckOpen: true }]);
    expect(restore).toContain('--u32 "0>>22&0x3C@12>>8=100" -j DROP');
    expect(restore).not.toContain('ACCEPT');
    expect(tunnelsListening([{ vni: 100, port: 4789, peers: [] }])).toEqual([]);
  });

  it('never drops a port as a whole: other VXLAN software on the host is left alone', () => {
    const rules = vxlanFirewallRestore([{ vni: 100, port: 4789, peers: ['192.0.2.1'] }]).split('\n').filter((l) => l.includes('DROP'));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('--u32');
  });

  it('refuses a stored value that could smuggle a rule in', () => {
    expect(() => vxlanFirewallRestore([{ vni: 100, port: 4789, peers: ['1.2.3.4 -j ACCEPT\n-A INPUT'] }])).toThrow();
    expect(() => vxlanFirewallRestore([{ vni: 0, port: 4789, peers: ['1.2.3.4'] }])).toThrow();
  });
});

describe('parseVxlanLinks', () => {
  // Trimmed from `ip -d -s -j link show type vxlan`, iproute2 6.1.
  const sample = JSON.stringify([
    {
      ifname: 'vpx100', flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'], mtu: 1450, master: 'vp3',
      linkinfo: { info_kind: 'vxlan', info_data: { id: 100, port: 4789, learning: true } },
      stats64: { rx: { bytes: 2048 }, tx: { bytes: 4096 } },
    },
    { ifname: 'vpx200', flags: ['BROADCAST', 'MULTICAST'], mtu: 1450, linkinfo: { info_kind: 'vxlan', info_data: { id: 200, port: 4790 } } },
    { ifname: 'odd', flags: [], mtu: 1500, linkinfo: { info_kind: 'vxlan', info_data: {} } },
  ]);

  it('reads what the plan needs, and skips what it cannot place', () => {
    const links = parseVxlanLinks(sample);
    expect(links).toHaveLength(2);
    expect(links[0]).toEqual({ name: 'vpx100', vni: 100, port: 4789, mtu: 1450, master: 'vp3', up: true, rxBytes: 2048, txBytes: 4096 });
    expect(links[1]).toMatchObject({ name: 'vpx200', vni: 200, port: 4790, up: false, rxBytes: 0 });
    expect(links[1].master).toBeUndefined();
  });

  it('survives anything else', () => {
    expect(parseVxlanLinks('')).toEqual([]);
    expect(parseVxlanLinks('not json')).toEqual([]);
    expect(parseVxlanLinks('{}')).toEqual([]);
  });
});

describe('parseFdb', () => {
  // `bridge -j fdb show dev vpx100` with one flood entry, one learned machine and the bridge's own.
  const sample = JSON.stringify([
    { mac: 'ee:99:6b:c3:06:b0', vlan: 1, flags: [], master: 'vp3', state: 'permanent' },
    { mac: 'ee:99:6b:c3:06:b0', flags: [], master: 'vp3', state: 'permanent' },
    { mac: '00:00:00:00:00:00', dst: '192.0.2.1', flags: ['self'], state: 'permanent' },
    { mac: '52:54:00:aa:bb:cc', dst: '192.0.2.1', flags: ['self'], state: '' },
    { mac: '52:54:00:aa:bb:cd', dst: '192.0.2.1', flags: ['self'], state: '' },
    { mac: '00:00:00:00:00:00', dst: '192.0.2.2', flags: ['self'], state: 'permanent' },
  ]);

  it('tells the remote hosts from the machines learned behind them', () => {
    const view = parseFdb(sample);
    expect(view.floodPeers).toEqual(['192.0.2.1', '192.0.2.2']);
    expect(view.learned.get('192.0.2.1')).toBe(2);
    expect(view.learned.has('192.0.2.2')).toBe(false);
  });

  it('survives anything else', () => {
    expect(parseFdb('').floodPeers).toEqual([]);
    expect(parseFdb('nope').learned.size).toBe(0);
  });
});

describe('planTunnel', () => {
  const want = (over: Partial<TunnelWanted> = {}): TunnelWanted => ({
    vni: 100, port: 4789, mtu: 1450, bridge: 'vp3', peers: [], allowUp: true, ...over,
  });
  const have = (over: Partial<VxlanLink> = {}): VxlanLink => ({
    name: 'vpx100', vni: 100, port: 4789, mtu: 1450, master: 'vp3', up: false, rxBytes: 0, txBytes: 0, ...over,
  });
  const lines = (plan: { steps: Array<{ tool: string; args: string[] }> }) => plan.steps.map((s) => `${s.tool} ${s.args.join(' ')}`);

  it('names the device and bridge after the ID, within the kernel\'s 15 characters', () => {
    expect(vxlanDeviceName(16777215)).toBe('vpx16777215');
    expect(vxlanBridgeName(16777215)).toBe('vpbr16777215');
    expect(vxlanBridgeName(16777215).length).toBeLessThanOrEqual(15);
  });

  it('builds a VXLAN with no remote hosts and leaves it down, so nothing listens', () => {
    const plan = planTunnel(want(), undefined, []);
    expect(lines(plan)).toEqual([
      'ip link add vpx100 type vxlan id 100 dstport 4789',
      'ip link set vpx100 mtu 1450',
      'ip link set vpx100 master vp3',
    ]);
  });

  it('never pins a source address: the kernel picks it per remote host', () => {
    const plan = planTunnel(want({ peers: ['192.0.2.1'] }), undefined, []);
    expect(lines(plan).join('\n')).not.toContain('local');
  });

  it('brings a tunnel up only after everything else is in place', () => {
    const steps = lines(planTunnel(want({ peers: ['192.0.2.1'] }), undefined, []));
    expect(steps[steps.length - 1]).toBe('ip link set vpx100 up');
    expect(steps).toContain('bridge fdb append 00:00:00:00:00:00 dev vpx100 dst 192.0.2.1');
  });

  it('does nothing when the kernel already has it right', () => {
    expect(lines(planTunnel(want(), have(), []))).toEqual([]);
    expect(lines(planTunnel(want({ peers: ['192.0.2.1'] }), have({ up: true }), ['192.0.2.1']))).toEqual([]);
  });

  it('syncs remote hosts both ways', () => {
    const steps = lines(planTunnel(want({ peers: ['192.0.2.2'] }), have({ up: true }), ['192.0.2.1']));
    expect(steps).toEqual([
      'bridge fdb del 00:00:00:00:00:00 dev vpx100 dst 192.0.2.1',
      'bridge fdb append 00:00:00:00:00:00 dev vpx100 dst 192.0.2.2',
    ]);
  });

  it('closes the tunnel first when the last remote host goes', () => {
    const steps = lines(planTunnel(want(), have({ up: true }), ['192.0.2.1']));
    expect(steps).toEqual([
      'ip link set vpx100 down',
      'bridge fdb del 00:00:00:00:00:00 dev vpx100 dst 192.0.2.1',
    ]);
  });

  it('takes a running tunnel down when its firewall rules are gone (fails closed)', () => {
    const steps = lines(planTunnel(want({ peers: ['192.0.2.1'], allowUp: false }), have({ up: true }), ['192.0.2.1']));
    expect(steps).toEqual(['ip link set vpx100 down']);
  });

  it('never brings one up without its firewall rules', () => {
    const steps = lines(planTunnel(want({ peers: ['192.0.2.1'], allowUp: false }), undefined, []));
    expect(steps.join('\n')).not.toContain(' up');
  });

  it('stays down while its bridge is missing, then reattaches', () => {
    const missing = lines(planTunnel(want({ peers: ['192.0.2.1'], bridge: null }), have({ up: true, master: undefined }), ['192.0.2.1']));
    expect(missing).toEqual(['ip link set vpx100 down']);
    const back = lines(planTunnel(want({ peers: ['192.0.2.1'] }), have({ up: false, master: undefined }), ['192.0.2.1']));
    expect(back).toEqual(['ip link set vpx100 master vp3', 'ip link set vpx100 up']);
  });

  it('puts the MTU back if it drifted', () => {
    expect(lines(planTunnel(want(), have({ mtu: 1500 }), []))).toEqual(['ip link set vpx100 mtu 1450']);
  });

  it('touches nothing when the name belongs to something else', () => {
    const plan = planTunnel(want(), have({ vni: 999 }), []);
    expect(plan.steps).toEqual([]);
    expect(plan.conflict).toMatch(/is VXLAN ID 999/);
    expect(planTunnel(want(), have({ port: 8472 }), []).conflict).toMatch(/port 8472/);
  });
});
