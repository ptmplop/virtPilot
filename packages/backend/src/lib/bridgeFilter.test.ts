import { describe, it, expect } from 'vitest';
import { chainsFor, parseFilterState, portsScript, removeVmScript, ruleToNft, tableScript, vmChainsScript } from './bridgeFilter.js';
import type { FirewallConfig, FirewallRule } from '../services/firewallService.js';

const rule = (over: Partial<FirewallRule> = {}): FirewallRule => ({ id: 'r', direction: 'inbound', protocol: 'tcp', action: 'allow', ...over });
const cfg = (over: Partial<FirewallConfig> = {}): FirewallConfig => ({ rules: [], defaultInbound: 'drop', defaultOutbound: 'allow', ...over });

describe('ruleToNft', () => {
  it('a port, with an allow that only falls through', () => {
    expect(ruleToNft(rule({ portRange: '22' }))).toBe('tcp dport 22 return');
  });

  it('a list and ranges, either way of writing one', () => {
    expect(ruleToNft(rule({ portRange: '80,443,8000-8100,9000:9100', action: 'drop' }))).toBe('tcp dport { 80, 443, 8000-8100, 9000-9100 } drop');
  });

  it('a whole protocol, with no port', () => {
    expect(ruleToNft(rule({ protocol: 'udp' }))).toBe('meta l4proto udp return');
  });

  it('a source on an inbound rule, a destination on an outbound one', () => {
    expect(ruleToNft(rule({ source: '10.0.0.0/24', portRange: '22' }))).toBe('ip saddr 10.0.0.0/24 tcp dport 22 return');
    expect(ruleToNft(rule({ direction: 'outbound', destination: '1.2.3.4', portRange: '25', action: 'drop' }))).toBe('ip daddr 1.2.3.4 tcp dport 25 drop');
  });

  it('the other side of a rule does not apply, as in FORWARD', () => {
    expect(ruleToNft(rule({ source: '10.0.0.0/24', direction: 'outbound', portRange: '22' }))).toBe('tcp dport 22 return');
  });

  it('ICMP by type, with a code, and all of it on both families', () => {
    expect(ruleToNft(rule({ protocol: 'icmp', icmpType: '8' }))).toBe('icmp type 8 return');
    expect(ruleToNft(rule({ protocol: 'icmp', icmpType: '3/4' }))).toBe('icmp type 3 icmp code 4 return');
    expect(ruleToNft(rule({ protocol: 'icmp' }))).toBe('meta l4proto { icmp, ipv6-icmp } return');
    expect(ruleToNft(rule({ protocol: 'icmp', source: '10.0.0.1' }))).toBe('ip saddr 10.0.0.1 ip protocol icmp return');
  });

  it('everything, which is the way to let a guest-tagged frame through', () => {
    expect(ruleToNft(rule({ protocol: 'all' }))).toBe('return');
  });

  it('refuses what validation would', () => {
    expect(() => ruleToNft(rule({ source: '10.0.0.1; drop' }))).toThrow();
    expect(() => ruleToNft(rule({ portRange: '22 ; flush ruleset' }))).toThrow();
  });
});

describe('vmChainsScript', () => {
  const script = (over: Partial<FirewallConfig> = {}) => vmChainsScript('abcd1234', cfg(over), 0x2a).join('\n');

  it('replaces each chain whole', () => {
    expect(script()).toMatch(/add chain bridge virtpilot vp-in-abcd1234\nflush chain bridge virtpilot vp-in-abcd1234/);
    expect(script()).toMatch(/add chain bridge virtpilot vp-out-abcd1234\nflush chain bridge virtpilot vp-out-abcd1234/);
  });

  it('a default of drop ends in drop, and of allow in nothing but marking what it lets in', () => {
    const lines = vmChainsScript('abcd1234', cfg(), 0x2a);
    expect(lines.filter((l) => l.endsWith('vp-in-abcd1234 drop'))).toHaveLength(1);
    expect(lines.filter((l) => l.endsWith('vp-out-abcd1234 drop'))).toHaveLength(0);
    expect(vmChainsScript('abcd1234', cfg({ defaultInbound: 'allow' }), 0x2a).at(-1 - vmChainsScript('abcd1234', cfg({ defaultInbound: 'allow' }), 0x2a).filter((l) => l.includes('vp-out-')).length)).toMatch(/vp-in-abcd1234 ct mark set ct mark & 0xffff0000 \| 0x0000002a$/);
  });

  it('what a NIC needs comes first, and rules before the default', () => {
    const lines = vmChainsScript('abcd1234', cfg({ rules: [rule({ portRange: '22' })] }), 0x2a).filter((l) => l.includes('add rule') && l.includes('vp-in-'));
    expect(lines[0]).toContain('ether type != { ip, ip6, 8021q, 8021ad } return');
    expect(lines.at(-2)).toContain('tcp dport 22 ct mark set ct mark & 0xffff0000 | 0x0000002a return');
    expect(lines.at(-1)).toMatch(/ drop$/);
  });

  it('DHCP each way, in its own direction only, a few frames a second, and out only by broadcast', () => {
    expect(script()).toMatch(/vp-in-abcd1234 udp sport 67 udp dport 68 meta length <= 1100 limit rate 10\/second burst 20 packets return/);
    expect(script()).toMatch(/vp-out-abcd1234 ether daddr ff:ff:ff:ff:ff:ff udp sport 68 udp dport 67 meta length <= 1100 limit rate 10\/second burst 20 packets return/);
    expect(script()).not.toMatch(/vp-in-abcd1234 udp sport 68/);
  });

  it('a fragment after the first passes only on a connection this VM started or let in', () => {
    expect(script()).toMatch(/vp-in-abcd1234 ip frag-off & 0x1fff != 0 ct mark & 0xffff0000 == 0x002a0000 return/);
    expect(script()).toMatch(/vp-in-abcd1234 ip frag-off & 0x1fff != 0 ct mark & 0x0000ffff == 0x0000002a return/);
    expect(script()).not.toMatch(/frag-off & 0x1fff != 0 return/);
  });

  it('DHCP is small, or it is not let through', () => {
    expect(script()).toMatch(/udp sport 67 udp dport 68 meta length <= 1100 limit/);
  });

  it('ICMP errors about a connection it let in, as path MTU discovery needs', () => {
    expect(script({ allowEstablishedInbound: true })).toMatch(/vp-in-abcd1234 ct state related ct mark & 0x0000ffff == 0x0000002a return/);
  });

  const tracked = (over: Partial<FirewallConfig> = {}) => vmChainsScript('abcd1234', cfg({ allowEstablishedInbound: true, allowEstablishedOutbound: true, rules: [rule({ portRange: '22' })], ...over }), 0x2a).join('\n');

  it('established coming in: only what this VM started, by the top half of the mark', () => {
    expect(tracked()).toMatch(/vp-in-abcd1234 ct state established,related ct mark & 0xffff0000 == 0x002a0000 return/);
  });

  it('established going out: only what this VM let in, by the bottom half', () => {
    expect(tracked()).toMatch(/vp-out-abcd1234 ct state established,related ct mark & 0x0000ffff == 0x0000002a return/);
  });

  it('a connection it starts is marked as its own, before its rules', () => {
    const lines = vmChainsScript('abcd1234', cfg({ rules: [rule({ direction: 'outbound', portRange: '25', action: 'drop' })] }), 0x2a).filter((l) => l.includes('vp-out-'));
    const mark = lines.findIndex((l) => l.includes('ct state new ct mark set ct mark & 0x0000ffff | 0x002a0000'));
    expect(mark).toBeGreaterThan(-1);
    expect(mark).toBeLessThan(lines.findIndex((l) => l.includes('dport 25 drop')));
  });

  it('an allow marks what it lets in, and so does a default of allow', () => {
    expect(tracked()).toMatch(/vp-in-abcd1234 tcp dport 22 ct mark set ct mark & 0xffff0000 \| 0x0000002a return/);
    expect(tracked({ defaultInbound: 'allow' })).toMatch(/vp-in-abcd1234 ct mark set ct mark & 0xffff0000 \| 0x0000002a$/m);
  });

  it('no mark to go by is refused', () => {
    expect(() => vmChainsScript('abcd1234', cfg(), 0)).toThrow();
  });
});

describe('tableScript', () => {
  it('the host\'s own traffic, either way, is left to the host', () => {
    const lines = tableScript(['10.0.0.1', '192.0.2.5']).join('\n');
    expect(lines).toContain('add element bridge virtpilot host_v4 { 10.0.0.1, 192.0.2.5 }');
    expect(lines).toMatch(/output ip saddr @host_v4 accept\n.*output oifname vmap @to_vm/);
    expect(lines).toMatch(/input ip daddr @host_v4 accept\n.*input iifname vmap @from_vm/);
    expect(lines).not.toContain('ip6 saddr');
    expect(lines).not.toContain('ip6 daddr');
  });

  it('refuses an address that is not one', () => {
    expect(() => tableScript(['10.0.0.1 } ; flush ruleset'])).toThrow();
  });
});

describe('portsScript', () => {
  it('takes a tap off whoever had it, then gives it to this VM', () => {
    const lines = portsScript('abcd1234', ['vnet5']);
    expect(lines[0]).toBe('destroy element bridge virtpilot to_vm { "vnet5" }');
    expect(lines).toContain('add element bridge virtpilot to_vm { "vnet5" : jump vp-in-abcd1234 }');
    expect(lines).toContain('add element bridge virtpilot from_vm { "vnet5" : jump vp-out-abcd1234 }');
  });

  it('refuses a name that is not one', () => {
    expect(() => portsScript('abcd1234', ['vnet5" } ; flush ruleset'])).toThrow();
  });

  it('a chain name must be a VM id', () => {
    expect(() => chainsFor('nope')).toThrow();
  });
});

describe('removeVmScript', () => {
  it('its taps go ahead of its chains', () => {
    const lines = removeVmScript('abcd1234', ['vnet5']);
    expect(lines.findIndex((l) => l.includes('destroy element'))).toBeLessThan(lines.findIndex((l) => l.includes('delete chain')));
  });
});

describe('parseFilterState', () => {
  it('reads the taps and chains of a real listing', () => {
    const state = parseFilterState(JSON.stringify({ nftables: [
      { metainfo: {} },
      { table: { family: 'bridge', name: 'virtpilot' } },
      { chain: { family: 'bridge', table: 'virtpilot', name: 'vp-in-abcd1234' } },
      { map: { name: 'to_vm', elem: [['vnet5', { jump: { target: 'vp-in-abcd1234' } }]] } },
      { map: { name: 'from_vm', elem: [['vnet5', { jump: { target: 'vp-out-abcd1234' } }]] } },
    ] }));
    expect([...state.ports]).toEqual([['vnet5', 'abcd1234']]);
    expect(state.chains.has('vp-in-abcd1234')).toBe(true);
  });

  it('nothing listed, or nothing readable, is an empty table', () => {
    expect(parseFilterState('').ports.size).toBe(0);
    expect(parseFilterState(JSON.stringify({ nftables: [{ map: { name: 'to_vm' } }] })).ports.size).toBe(0);
  });
});
