import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { run, runSafe } from './safeExec.js';
import {
  validateIpv4,
  validateIpv4OrCidr,
  validatePortRange,
  validateProtocol,
  validateIcmpType,
} from '../lib/validate.js';

export interface FirewallRule {
  id: string;
  direction: 'inbound' | 'outbound';
  protocol: 'tcp' | 'udp' | 'icmp' | 'all';
  portRange?: string;
  source?: string;
  destination?: string;
  icmpType?: string;
  action: 'allow' | 'drop';
  description?: string;
}

export interface FirewallConfig {
  rules: FirewallRule[];
  defaultInbound: 'allow' | 'drop';
  defaultOutbound: 'allow' | 'drop';
  allowEstablishedInbound?: boolean;
  allowEstablishedOutbound?: boolean;
}

function firewallPath(vmUuid: string): string {
  return path.join(config.cloudInitDir, `${vmUuid}-firewall.json`);
}

// First 8 hex chars of the UUID (no hyphens) — used as the iptables chain
// suffix. Chain names are limited to 28 characters; `VP-IN-` + 8 chars = 14,
// well under the limit.
function uuidShort(vmUuid: string): string {
  const hex = vmUuid.replace(/-/g, '').slice(0, 8);
  if (!/^[0-9a-f]{8}$/.test(hex)) throw new Error('Invalid VM UUID');
  return hex;
}

function inChain(vmUuid: string): string {
  return `VP-IN-${uuidShort(vmUuid)}`;
}

function outChain(vmUuid: string): string {
  return `VP-OUT-${uuidShort(vmUuid)}`;
}

export async function getFirewallConfig(vmUuid: string): Promise<FirewallConfig> {
  try {
    const raw = await fs.readFile(firewallPath(vmUuid), 'utf8');
    const cfg = JSON.parse(raw) as Partial<FirewallConfig>;
    return {
      rules: (cfg.rules ?? []).map((r) => ({ ...r, id: r.id || randomUUID() })),
      defaultInbound: cfg.defaultInbound ?? 'allow',
      defaultOutbound: cfg.defaultOutbound ?? 'allow',
      allowEstablishedInbound: cfg.allowEstablishedInbound ?? false,
      allowEstablishedOutbound: cfg.allowEstablishedOutbound ?? false,
    };
  } catch {
    return { rules: [], defaultInbound: 'allow', defaultOutbound: 'allow', allowEstablishedInbound: false, allowEstablishedOutbound: false };
  }
}

export async function saveFirewallConfig(vmUuid: string, cfg: FirewallConfig): Promise<void> {
  const withIds = cfg.rules.map((r) => ({ ...r, id: r.id || randomUUID() }));
  await fs.writeFile(
    firewallPath(vmUuid),
    JSON.stringify({ ...cfg, rules: withIds }, null, 2),
    'utf8'
  );
}

export async function deleteFirewallConfig(vmUuid: string): Promise<void> {
  await fs.unlink(firewallPath(vmUuid)).catch(() => {});
}

async function chainExists(chain: string): Promise<boolean> {
  return (await runSafe('iptables', ['-L', chain, '-n'])) !== null;
}

// Build the iptables --dport / --dports args for a port-range value. The
// value is pre-validated against PORT_RANGE_RE so we know it only contains
// digits, commas, hyphens, and colons.
function portArgs(portRange: string): string[] {
  if (portRange.includes(',')) {
    const ports = portRange.split(',').map((p) => p.includes('-') ? p.replace('-', ':') : p).join(',');
    return ['-m', 'multiport', '--dports', ports];
  }
  const range = portRange.includes('-') ? portRange.replace('-', ':') : portRange;
  return ['--dport', range];
}

export async function applyFirewallRules(vmUuid: string, vmIpRaw: string, cfg: FirewallConfig): Promise<void> {
  const vmIp = validateIpv4(vmIpRaw);
  const { rules, defaultInbound, defaultOutbound, allowEstablishedInbound, allowEstablishedOutbound } = cfg;
  const inC = inChain(vmUuid);
  const outC = outChain(vmUuid);

  // Remove existing jump rules
  await runSafe('iptables', ['-D', 'FORWARD', '-d', vmIp, '-j', inC]);
  await runSafe('iptables', ['-D', 'FORWARD', '-s', vmIp, '-j', outC]);

  for (const chain of [inC, outC]) {
    if (await chainExists(chain)) {
      await runSafe('iptables', ['-F', chain]);
      await runSafe('iptables', ['-X', chain]);
    }
  }

  if (
    rules.length === 0 &&
    defaultInbound === 'allow' &&
    defaultOutbound === 'allow' &&
    !allowEstablishedInbound &&
    !allowEstablishedOutbound
  ) return;

  await run('iptables', ['-N', inC]);
  await run('iptables', ['-N', outC]);

  if (allowEstablishedInbound) {
    await runSafe('iptables', ['-A', inC, '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT']);
  }
  if (allowEstablishedOutbound) {
    await runSafe('iptables', ['-A', outC, '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT']);
  }

  for (const rule of rules) {
    const chain = rule.direction === 'inbound' ? inC : outC;
    const target = rule.action === 'allow' ? 'ACCEPT' : 'DROP';
    const proto = validateProtocol(rule.protocol);
    const args: string[] = ['-A', chain];
    if (rule.direction === 'inbound' && rule.source) args.push('-s', validateIpv4OrCidr(rule.source));
    if (rule.direction === 'outbound' && rule.destination) args.push('-d', validateIpv4OrCidr(rule.destination));
    if (proto !== 'all') {
      args.push('-p', proto);
      if (proto === 'icmp' && rule.icmpType) {
        args.push('--icmp-type', validateIcmpType(rule.icmpType));
      } else if (rule.portRange && (proto === 'tcp' || proto === 'udp')) {
        args.push(...portArgs(validatePortRange(rule.portRange)));
      }
    }
    args.push('-j', target);
    args.push('-m', 'comment', '--comment', `virtpilot-fw-${uuidShort(vmUuid)}`);
    await runSafe('iptables', args);
  }

  const inDefault = defaultInbound === 'allow' ? 'ACCEPT' : 'DROP';
  const outDefault = defaultOutbound === 'allow' ? 'ACCEPT' : 'DROP';
  await runSafe('iptables', ['-A', inC, '-j', inDefault]);
  await runSafe('iptables', ['-A', outC, '-j', outDefault]);

  await run('iptables', ['-I', 'FORWARD', '-d', vmIp, '-j', inC]);
  await run('iptables', ['-I', 'FORWARD', '-s', vmIp, '-j', outC]);
}

export async function removeVmFirewall(vmUuid: string, vmIpRaw: string): Promise<void> {
  const vmIp = validateIpv4(vmIpRaw);
  const inC = inChain(vmUuid);
  const outC = outChain(vmUuid);
  await runSafe('iptables', ['-D', 'FORWARD', '-d', vmIp, '-j', inC]);
  await runSafe('iptables', ['-D', 'FORWARD', '-s', vmIp, '-j', outC]);
  for (const chain of [inC, outC]) {
    await runSafe('iptables', ['-F', chain]);
    await runSafe('iptables', ['-X', chain]);
  }
}
