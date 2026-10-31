import { describe, expect, it } from 'vitest';
import {
  HOST_CONFIG_HOLD_MS,
  holdForHostConfig,
  isManagedBridgeName,
  managedBridgeXml,
  parseDefaultRouteDevices,
  parseNetworkdState,
  planUplink,
  uplinkRefusal,
  type UplinkFacts,
} from './managedBridge.js';

const spare: UplinkFacts = { exists: true, master: null, up: false, hasAddress: false, defaultRoute: false, networkd: 'none' };

describe('isManagedBridgeName', () => {
  it('takes only the names VirtPilot gives out', () => {
    expect(isManagedBridgeName('vp0')).toBe(true);
    expect(isManagedBridgeName('vp12')).toBe(true);
  });

  it('leaves OS bridges and VXLAN bridges alone', () => {
    for (const name of ['br0', 'virbr0', 'vpbr100', 'vpx100', 'vp', 'vp1a', 'xvp1']) {
      expect(isManagedBridgeName(name)).toBe(false);
    }
  });
});

describe('managedBridgeXml', () => {
  const xml = managedBridgeXml({ libvirtName: 'virtpilot-1234abcd', bridge: 'vp3' });

  it('names the network and its bridge, with STP off', () => {
    expect(xml).toContain('<name>virtpilot-1234abcd</name>');
    expect(xml).toContain(`<bridge name='vp3' stp='off' delay='0'/>`);
  });

  it('gives the host no address and libvirt no DHCP, DNS or forwarding', () => {
    expect(xml).not.toMatch(/<ip|<dhcp|<forward|<dns/);
  });

  it('escapes what it is given', () => {
    expect(managedBridgeXml({ libvirtName: `a'<b`, bridge: `c'd` })).not.toMatch(/a'<b|c'd/);
  });
});

describe('uplinkRefusal', () => {
  it('lets a spare NIC through', () => {
    expect(uplinkRefusal('eno1', 'vp1', spare)).toBeNull();
  });

  it('refuses a NIC that is not there', () => {
    expect(uplinkRefusal('eno1', 'vp1', { ...spare, exists: false })).toMatch(/not on this host/);
  });

  it('never takes a NIC from another master', () => {
    expect(uplinkRefusal('eno1', 'vp1', { ...spare, master: 'br0' })).toMatch(/part of br0/);
    expect(uplinkRefusal('eno1', 'vp1', { ...spare, master: 'bond0' })).toMatch(/part of bond0/);
  });

  it('never takes a NIC the host may be reached through', () => {
    expect(uplinkRefusal('eno1', 'vp1', { ...spare, hasAddress: true })).toMatch(/IP address/);
    expect(uplinkRefusal('eno1', 'vp1', { ...spare, defaultRoute: true })).toMatch(/default route/);
  });

  it('keeps a NIC already on this bridge', () => {
    expect(uplinkRefusal('eno1', 'vp1', { ...spare, master: 'vp1' })).toBeNull();
  });

  it('does not keep one that has been given an address', () => {
    expect(uplinkRefusal('eno1', 'vp1', { ...spare, master: 'vp1', hasAddress: true })).toMatch(/IP address/);
  });

  it('does not take a NIC the host has claimed while networkd still manages it', () => {
    for (const networkd of ['configuring', 'finished'] as const) {
      expect(uplinkRefusal('eno1', 'vp1', { ...spare, networkd }, { claimed: true })).toMatch(/take it out of netplan/);
    }
  });

  it('takes a claimed NIC once networkd has let go of it', () => {
    expect(uplinkRefusal('eno1', 'vp1', spare, { claimed: true })).toBeNull();
  });

  it('takes a NIC networkd manages that the host never claimed', () => {
    expect(uplinkRefusal('eno1', 'vp1', { ...spare, networkd: 'finished' })).toBeNull();
  });
});

describe('planUplink', () => {
  it('attaches a spare NIC, then brings it up', () => {
    expect(planUplink('eno1', 'vp1', spare)).toEqual({
      refusal: null,
      steps: [['link', 'set', 'eno1', 'master', 'vp1'], ['link', 'set', 'eno1', 'up']],
      claimed: undefined,
    });
  });

  it('does not touch a link that is already up', () => {
    expect(planUplink('eno1', 'vp1', { ...spare, up: true }).steps).toEqual([['link', 'set', 'eno1', 'master', 'vp1']]);
  });

  it('brings up a NIC that is attached but down', () => {
    expect(planUplink('eno1', 'vp1', { ...spare, master: 'vp1' }).steps).toEqual([['link', 'set', 'eno1', 'up']]);
  });

  it('has nothing to do once it is attached and up', () => {
    expect(planUplink('eno1', 'vp1', { ...spare, master: 'vp1', up: true })).toEqual({ refusal: null, steps: [], claimed: undefined });
  });

  it('does nothing to a NIC it refuses, and remembers the host uses it', () => {
    for (const facts of [{ hasAddress: true }, { defaultRoute: true }]) {
      expect(planUplink('eno1', 'vp1', { ...spare, ...facts })).toMatchObject({ steps: [], claimed: true });
    }
  });

  it('lets go of a port that has been given an address', () => {
    expect(planUplink('eno1', 'vp1', { ...spare, master: 'vp1', up: true, hasAddress: true })).toMatchObject({
      steps: [['link', 'set', 'eno1', 'nomaster']],
      claimed: true,
    });
  });

  it('leaves a NIC on another bridge alone, and claims nothing', () => {
    expect(planUplink('eno1', 'vp1', { ...spare, master: 'br0' })).toMatchObject({ steps: [], claimed: undefined });
  });

  it('holds on to a claim while networkd manages the NIC, whatever its address', () => {
    expect(planUplink('eno1', 'vp1', { ...spare, networkd: 'configuring' }, { claimed: true })).toMatchObject({ steps: [], claimed: undefined });
  });

  it('drops the claim when networkd lets go, and takes the NIC', () => {
    expect(planUplink('eno1', 'vp1', { ...spare, up: true }, { claimed: true })).toEqual({
      refusal: null,
      steps: [['link', 'set', 'eno1', 'master', 'vp1']],
      claimed: false,
    });
  });
});

// As systemd 255 writes them, for each state a link was measured in.
describe('parseNetworkdState', () => {
  const link = (state: string) => `# This is private data. Do not parse.\nADMIN_STATE=${state}\nOPER_STATE=degraded\nCARRIER_STATE=carrier\n`;

  it('says configuring while networkd has more to do', () => {
    for (const state of ['pending', 'initialized', 'configuring']) expect(parseNetworkdState(link(state))).toBe('configuring');
  });

  it('says finished once it has done what it will', () => {
    for (const state of ['configured', 'failed', 'linger']) expect(parseNetworkdState(link(state))).toBe('finished');
  });

  it('says none for a link it leaves alone', () => {
    expect(parseNetworkdState(link('unmanaged'))).toBe('none');
  });

  it('says none with no state to read, as on a host without networkd', () => {
    expect(parseNetworkdState('')).toBe('none');
  });
});

describe('holdForHostConfig', () => {
  it('holds until the time is up, and not after', () => {
    expect(holdForHostConfig(1000, 1000)).toBe(true);
    expect(holdForHostConfig(1000, 1000 + HOST_CONFIG_HOLD_MS - 1)).toBe(true);
    expect(holdForHostConfig(1000, 1000 + HOST_CONFIG_HOLD_MS)).toBe(false);
  });
});

// Each sample is what iproute2 printed on Ubuntu 24.04, in a network namespace.
describe('parseDefaultRouteDevices', () => {
  it('reads no route', () => {
    expect(parseDefaultRouteDevices('[]')).toEqual([]);
  });

  it('reads a single route in either family', () => {
    expect(parseDefaultRouteDevices('[{"dst":"default","gateway":"192.0.2.1","dev":"d1","flags":[]}]')).toEqual(['d1']);
    expect(parseDefaultRouteDevices('[{"dst":"default","gateway":"2001:db8:1::1","dev":"d1","metric":1024,"flags":[],"pref":"medium"}]')).toEqual(['d1']);
  });

  it('reads every device of a multipath route', () => {
    const raw = '[{"dst":"default","flags":[],"nexthops":[{"gateway":"192.0.2.1","dev":"d1","weight":1,"flags":[]},{"gateway":"198.51.100.1","dev":"d2","weight":1,"flags":[]}]}]';
    expect(parseDefaultRouteDevices(raw)).toEqual(['d1', 'd2']);
  });

  it('names a device once, however many routes use it', () => {
    const raw = '[{"dst":"default","dev":"d1"},{"dst":"default","dev":"d1","metric":100}]';
    expect(parseDefaultRouteDevices(raw)).toEqual(['d1']);
  });
});
