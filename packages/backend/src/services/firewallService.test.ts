import { describe, it, expect } from 'vitest';
import { validateFirewallConfig, tokeniseIptablesRule, type FirewallConfig, type FirewallRule } from './firewallService.js';
import { ValidationError } from '../lib/validate.js';

const rule = (over: Partial<FirewallRule> = {}): FirewallRule => ({
  id: 'r1',
  direction: 'inbound',
  protocol: 'tcp',
  portRange: '22',
  action: 'allow',
  ...over,
});

const cfg = (rules: FirewallRule[], over: Partial<FirewallConfig> = {}): FirewallConfig => ({
  rules,
  defaultInbound: 'drop',
  defaultOutbound: 'allow',
  ...over,
});

describe('validateFirewallConfig', () => {
  it('accepts a realistic rule set', () => {
    expect(() => validateFirewallConfig(cfg([
      rule(),
      rule({ id: 'r2', protocol: 'icmp', portRange: undefined, icmpType: '8' }),
      rule({ id: 'r3', direction: 'outbound', protocol: 'all', portRange: undefined, action: 'drop' }),
      rule({ id: 'r4', portRange: '80,443,8000-8100', source: '10.0.1.0/24' }),
    ]))).not.toThrow();
  });

  it('accepts an empty rule set', () => {
    expect(() => validateFirewallConfig(cfg([]))).not.toThrow();
  });

  // Before validation moved to save time, each of these saved with a 200 and
  // only blew up at apply — after the operator had left the page believing the
  // policy was in force.
  it.each([
    ['a port above the maximum', rule({ portRange: '99999' })],
    ['a reversed range', rule({ portRange: '90-10' })],
    ['ports on icmp', rule({ protocol: 'icmp', portRange: '22' })],
    ['ports on protocol "all"', rule({ protocol: 'all', portRange: '22' })],
    ['an unknown direction', rule({ direction: 'sideways' as FirewallRule['direction'] })],
    ['an unknown action', rule({ action: 'maybe' as FirewallRule['action'] })],
    ['an unknown protocol', rule({ protocol: 'sctp' as FirewallRule['protocol'] })],
    ['a malformed source', rule({ source: '999.1.1.1' })],
    ['a malformed destination', rule({ destination: 'not-an-ip' })],
    ['a malformed icmp type', rule({ protocol: 'icmp', portRange: undefined, icmpType: 'echo' })],
  ])('rejects %s', (_label, r) => {
    expect(() => validateFirewallConfig(cfg([r]))).toThrow(ValidationError);
  });

  it.each(['defaultInbound', 'defaultOutbound'] as const)('rejects an invalid %s', (key) => {
    expect(() => validateFirewallConfig(cfg([], { [key]: 'perhaps' } as Partial<FirewallConfig>)))
      .toThrow(ValidationError);
  });

  it('names the offending rule so the operator can find it', () => {
    try {
      validateFirewallConfig(cfg([rule(), rule({ id: 'r2', portRange: '99999', description: 'web' })]));
      throw new Error('should have thrown');
    } catch (err) {
      expect(String(err)).toMatch(/rule 2/);
      expect(String(err)).toMatch(/web/);
    }
  });

  it('treats an empty optional field as absent rather than invalid', () => {
    expect(() => validateFirewallConfig(cfg([
      rule({ portRange: '', source: '', destination: '', icmpType: '' }),
    ]))).not.toThrow();
  });
});

describe('tokeniseIptablesRule', () => {
  it('splits a plain rule', () => {
    expect(tokeniseIptablesRule('-A FORWARD -d 10.0.1.2/32 -j ACCEPT'))
      .toEqual(['-A', 'FORWARD', '-d', '10.0.1.2/32', '-j', 'ACCEPT']);
  });

  // Comments come back quoted from `iptables -S`, and the reconciler has to
  // reproduce the exact argv to delete a rule again.
  it('keeps a quoted comment as one token, unquoted', () => {
    const tokens = tokeniseIptablesRule(
      '-A PREROUTING -p tcp -m comment --comment "virtpilot-abc 123" -j DNAT',
    );
    expect(tokens).toContain('virtpilot-abc 123');
    expect(tokens).not.toContain('"virtpilot-abc');
  });

  it('unescapes an escaped quote inside a comment', () => {
    expect(tokeniseIptablesRule('--comment "say \\"hi\\""')).toEqual(['--comment', 'say "hi"']);
  });

  it('returns nothing for an empty line', () => {
    expect(tokeniseIptablesRule('')).toEqual([]);
  });

  it('round-trips a rule carrying a comment with a space', () => {
    const line = '-A FORWARD -d 10.0.1.2/32 -m comment --comment "virtpilot fw 1" -j ACCEPT';
    const tokens = tokeniseIptablesRule(line);
    // What the delete path passes back to iptables, minus the leading -A.
    expect(tokens.slice(1)).toEqual([
      'FORWARD', '-d', '10.0.1.2/32', '-m', 'comment', '--comment', 'virtpilot fw 1', '-j', 'ACCEPT',
    ]);
  });
});
