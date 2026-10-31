import { describe, it, expect } from 'vitest';
import { parseDhcpLeases, parseDomIfAddr, pickVmIp } from './vmAddresses.js';

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
