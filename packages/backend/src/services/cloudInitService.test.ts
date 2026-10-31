import { describe, it, expect } from 'vitest';
import { buildNetworkConfig, nicCloudInitFor } from './cloudInitService.js';
import type { Network } from './networkService.js';

const MAC = '52:54:00:ab:cd:ef';

const network = (over: Partial<Network>): Network => ({
  id: 'n', name: 'n', type: 'nat', cidr: '10.0.1.0/24', gateway: '10.0.1.1', dns: [], bridge: 'vp0', createdAt: '', ...over,
});
const vxlan = (over: Partial<Network> = {}) => network({
  type: 'vxlan', ipMode: 'dhcp', cidr: '10.0.2.0/24', gateway: '10.0.2.1', bridge: 'vp1', vni: 100, mtu: 1450, peers: [], ...over,
});

describe('a NIC on a NAT network', () => {
  it('stays as it was: no MTU, and the guest waits for it', () => {
    const nic = nicCloudInitFor(network({}), MAC, true);
    const yaml = buildNetworkConfig([nic]);
    expect(yaml).toContain('dhcp4: true');
    expect(yaml).not.toContain('mtu');
    expect(yaml).not.toContain('optional');
  });
});

describe('a NIC on a VXLAN', () => {
  it('fits its MTU and never holds up the guest\'s boot', () => {
    const yaml = buildNetworkConfig([nicCloudInitFor(vxlan(), MAC, false)]);
    expect(yaml).toContain('mtu: 1450');
    expect(yaml).toContain('optional: true');
    expect(yaml).toContain('dhcp4: true');
    expect(yaml).toContain('route-metric: 200');
  });

  it('asks for DHCP even when VirtPilot hands out nothing: a router VM may answer', () => {
    const yaml = buildNetworkConfig([nicCloudInitFor(vxlan({ ipMode: 'none', cidr: '', gateway: '' }), MAC, false)]);
    expect(yaml).toContain('dhcp4: true');
    expect(yaml).toContain('optional: true');
  });

  it('takes a static address with no gateway and no DNS', () => {
    const nic = nicCloudInitFor(vxlan({ ipMode: 'static', gateway: '' }), MAC, true, '10.0.2.9');
    expect(nic.ipConfig).toEqual({ mode: 'static', ip: '10.0.2.9', prefix: 24, gateway: '', dns: [] });
    const yaml = buildNetworkConfig([nic]);
    expect(yaml).toContain('"10.0.2.9/24"');
    expect(yaml).not.toContain('routes:');
    // An empty list here is a null to YAML, and cloud-init chokes on it.
    expect(yaml).not.toContain('nameservers');
    expect(yaml).toContain('mtu: 1450');
  });

  it('takes its default route from a gateway when it is the primary NIC and has one', () => {
    const yaml = buildNetworkConfig([nicCloudInitFor(vxlan({ ipMode: 'static', gateway: '10.0.2.254' }), MAC, true, '10.0.2.9')]);
    expect(yaml).toContain('via: "10.0.2.254"');
  });

  it('takes no route when it is not primary', () => {
    const yaml = buildNetworkConfig([nicCloudInitFor(vxlan({ ipMode: 'static', gateway: '10.0.2.254' }), MAC, false, '10.0.2.9')]);
    expect(yaml).not.toContain('routes:');
  });
});

describe('buildNetworkConfig', () => {
  it('refuses a junk MTU rather than writing it into the seed', () => {
    expect(() => buildNetworkConfig([{ mac: MAC, isPrimary: true, ipConfig: { mode: 'dhcp' }, mtu: Number('x') }])).toThrow(/MTU/);
  });

  it('still refuses a junk gateway', () => {
    expect(() => buildNetworkConfig([{ mac: MAC, isPrimary: true, ipConfig: { mode: 'static', ip: '10.0.0.2', prefix: 24, gateway: 'x', dns: [] } }])).toThrow(/gateway/);
  });
});
