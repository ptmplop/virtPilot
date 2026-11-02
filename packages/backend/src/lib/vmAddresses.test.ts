import { describe, it, expect } from 'vitest';
import { parseArpingReply, parseDhcpLeases, parseDomIfAddr, parseNeighbours, pickVmIp } from './vmAddresses.js';

// `virsh domifaddr <vm> --source agent` on an Ubuntu guest with two NICs.
const AGENT = ` Name       MAC address          Protocol     Address
-------------------------------------------------------------------------------
 lo         00:00:00:00:00:00    ipv4         127.0.0.1/8
 -          -                    ipv6         ::1/128
 eth0       52:54:00:AA:00:01    ipv4         10.0.1.23/24
 -          -                    ipv4         10.0.1.24/24
 -          -                    ipv6         fe80::5054:ff:feaa:1/64
 eth1       52:54:00:aa:00:02    ipv4         10.0.2.7/24
`;

// `virsh domifaddr <vm> --source arp`: the same layout, hosts the host has spoken to.
const ARP = ` Name       MAC address          Protocol     Address
-------------------------------------------------------------------------------
 vnet3      52:54:00:aa:00:01    ipv4         10.0.1.23/0
`;

// `virsh net-dhcp-leases`: the address is the fifth column, hostname and client ID may be absent.
const LEASES = ` Expiry Time           MAC address         Protocol   IP address      Hostname   Client ID or DUID
-----------------------------------------------------------------------------------------------------
 2026-10-31 10:00:00   52:54:00:aa:00:02   ipv4       10.0.2.7/24     vx-a       ff:56:50:4d:98:00
 2026-10-31 10:01:00   52:54:00:aa:00:03   ipv4       10.0.2.8/24     -          -
`;

describe('parseDomIfAddr', () => {
  it('skips loopback and IPv6, and carries the MAC over to a NIC\'s second address', () => {
    expect(parseDomIfAddr(AGENT)).toEqual([
      { mac: '52:54:00:aa:00:01', ip: '10.0.1.23' },
      { mac: '52:54:00:aa:00:01', ip: '10.0.1.24' },
      { mac: '52:54:00:aa:00:02', ip: '10.0.2.7' },
    ]);
  });

  it('reads the ARP layout too', () => {
    expect(parseDomIfAddr(ARP)).toEqual([{ mac: '52:54:00:aa:00:01', ip: '10.0.1.23' }]);
  });

  it('finds nothing in an empty table', () => {
    expect(parseDomIfAddr('')).toEqual([]);
    expect(parseDomIfAddr(' Name MAC address Protocol Address\n-----\n')).toEqual([]);
  });
});

describe('parseDhcpLeases', () => {
  it('maps each MAC to its address', () => {
    const leases = parseDhcpLeases(LEASES);
    expect(leases.get('52:54:00:aa:00:02')).toBe('10.0.2.7');
    expect(leases.get('52:54:00:aa:00:03')).toBe('10.0.2.8');
    expect(leases.size).toBe(2);
  });

  it('finds nothing in an empty table', () => {
    expect(parseDhcpLeases('').size).toBe(0);
  });
});

describe('pickVmIp', () => {
  const addresses = parseDomIfAddr(AGENT);

  // A VM with a NAT uplink and a VXLAN NIC used to get whichever printed first.
  it('prefers the primary NIC, wherever it comes in the list', () => {
    expect(pickVmIp(addresses, '52:54:00:aa:00:02')).toBe('10.0.2.7');
    expect(pickVmIp(addresses, '52:54:00:AA:00:02')).toBe('10.0.2.7');
  });

  it('falls back to the first address when the primary has none yet', () => {
    expect(pickVmIp(addresses, '52:54:00:aa:00:99')).toBe('10.0.1.23');
    expect(pickVmIp(addresses)).toBe('10.0.1.23');
  });

  it('says so when there is nothing', () => {
    expect(pickVmIp([], '52:54:00:aa:00:02')).toBeNull();
  });
});

describe('parseNeighbours', () => {
  it('takes what was heard from lately, and not what has gone quiet or never answered', () => {
    const out = [
      '10.0.0.5 lladdr 52:54:00:AA:00:01 REACHABLE',
      '10.0.0.6 lladdr 52:54:00:aa:00:02 STALE',
      '10.0.0.7  FAILED',
      '10.0.0.8  INCOMPLETE',
      '10.0.0.9 lladdr 52:54:00:aa:00:03 router DELAY',
      '10.0.0.10 lladdr 52:54:00:aa:00:04 PROBE',
      '10.0.0.11 lladdr 52:54:00:aa:00:05 PERMANENT',
    ].join('\n');
    expect(parseNeighbours(out)).toEqual([
      { ip: '10.0.0.5', mac: '52:54:00:aa:00:01' },
      { ip: '10.0.0.9', mac: '52:54:00:aa:00:03' },
      { ip: '10.0.0.10', mac: '52:54:00:aa:00:04' },
      { ip: '10.0.0.11', mac: '52:54:00:aa:00:05' },
    ]);
  });

  it('has nothing to say of an empty table', () => {
    expect(parseNeighbours('')).toEqual([]);
  });
});

describe('parseNeighbours with stale entries', () => {
  const table = [
    '10.0.0.5 lladdr 52:54:00:00:00:05 REACHABLE',
    '10.0.0.6 lladdr 52:54:00:00:00:06 STALE',
    '10.0.0.7 FAILED',
  ].join('\n');

  it('leaves them out unless asked', () => {
    expect(parseNeighbours(table).map((n) => n.ip)).toEqual(['10.0.0.5']);
  });

  it('keeps them when asked, and still no entry with no MAC', () => {
    expect(parseNeighbours(table, { stale: true }).map((n) => n.ip)).toEqual(['10.0.0.5', '10.0.0.6']);
  });
});

describe('parseArpingReply', () => {
  const held = 'ARPING 10.77.0.9 from 0.0.0.0 rigarp0\nUnicast reply from 10.77.0.9 [9A:E6:6F:23:B5:93]  0.597ms\nSent 1 probes (1 broadcast(s))\nReceived 1 response(s)\n';

  it('names the MAC that answered', () => {
    expect(parseArpingReply(held, '10.77.0.9')).toBe('9a:e6:6f:23:b5:93');
  });

  it('says nobody when nobody did', () => {
    expect(parseArpingReply('ARPING 10.77.0.10 from 0.0.0.0 rigarp0\nSent 1 probes (1 broadcast(s))\nReceived 0 response(s)\n', '10.77.0.10')).toBeNull();
  });

  it('does not take a reply about another address', () => {
    expect(parseArpingReply(held, '10.77.0.10')).toBeNull();
  });

  it('does not take the other arping package\'s output, which it would read differently', () => {
    expect(parseArpingReply('ARPING 10.77.0.9\n60 bytes from 9a:e6:6f:23:b5:93 (10.77.0.9): index=0 time=1.1 msec\n', '10.77.0.9')).toBeNull();
  });
});
