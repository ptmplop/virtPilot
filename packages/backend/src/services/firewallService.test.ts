import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { firewallInForce, jumpsOutOfPlace, validateFirewallConfig, tokeniseIptablesRule, type FirewallConfig, type FirewallFile, type FirewallRule } from './firewallService.js';
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

describe('firewallInForce', () => {
  const saved: FirewallFile = cfg([rule()]);

  it('a file Apply never touched is not in force, whatever it says', () => {
    expect(firewallInForce(saved)).toBeNull();
  });

  it('what Apply put in force, not what has been saved since', () => {
    const applied = cfg([rule({ portRange: '443' })]);
    expect(firewallInForce({ ...saved, appliedHash: 'x', applied })?.cfg).toBe(applied);
  });

  it('what the kernel had when this version first saw it', () => {
    expect(firewallInForce({ ...saved, appliedRaw: ['-A VP-IN-aaaaaaaa -j DROP'] })?.raw).toEqual(['-A VP-IN-aaaaaaaa -j DROP']);
  });

  it('a hash from 2.16.7 that says the saved rules are what was applied: those', () => {
    const hash = createHash('sha256').update(JSON.stringify([saved.rules.map(({ id: _id, ...r }) => r), 'drop', 'allow', false, false])).digest('hex');
    expect(firewallInForce({ ...saved, appliedHash: hash })?.cfg?.rules).toEqual(saved.rules);
  });

  it('a hash that says they are not: a draft, which an upgrade does not put in force', () => {
    expect(firewallInForce({ ...saved, appliedHash: 'something else' })).toBeNull();
  });

  it('an Apply cut short with nothing known: nothing', () => {
    expect(firewallInForce({ ...saved, appliedHash: null })).toBeNull();
  });

  it('rules that say nothing put nothing in force', () => {
    expect(firewallInForce({ ...saved, applied: cfg([], { defaultInbound: 'allow' }) })).toBeNull();
  });
});

describe('jumpsOutOfPlace', () => {
  const vm = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const jumps = (ip: string) => [`-A FORWARD -s ${ip}/32 -j VP-OUT-aaaaaaaa`, `-A FORWARD -d ${ip}/32 -j VP-IN-aaaaaaaa`];
  const libvirt = ['-A FORWARD -j LIBVIRT_FWX', '-A FORWARD -j LIBVIRT_FWI', '-A FORWARD -j LIBVIRT_FWO'];
  const accept = (ip: string) => `-A FORWARD -d ${ip}/32 -p tcp -m tcp --dport 22 -m comment --comment "virtpilot-1234" -j ACCEPT`;

  it('all is well above a forward and libvirt', () => {
    expect(jumpsOutOfPlace(['-P FORWARD ACCEPT', ...jumps('10.0.0.5'), accept('10.0.0.5'), ...libvirt].join('\n'), vm)).toEqual([]);
  });

  it('under its forward\'s ACCEPT', () => {
    expect(jumpsOutOfPlace([accept('10.0.0.5'), ...jumps('10.0.0.5'), ...libvirt].join('\n'), vm)).toEqual(['10.0.0.5']);
  });

  it('under libvirt\'s rules', () => {
    expect(jumpsOutOfPlace([...libvirt, ...jumps('10.0.0.5')].join('\n'), vm)).toEqual(['10.0.0.5']);
  });

  it('another address\'s ACCEPT above it is no matter', () => {
    expect(jumpsOutOfPlace([accept('10.0.0.6'), ...jumps('10.0.0.5'), ...libvirt].join('\n'), vm)).toEqual([]);
  });

  it('another VM\'s jumps are not its business', () => {
    expect(jumpsOutOfPlace([...libvirt, '-A FORWARD -d 10.0.0.9/32 -j VP-IN-bbbbbbbb'].join('\n'), vm)).toEqual([]);
  });
});
