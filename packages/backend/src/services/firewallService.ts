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

function firewallPath(vmName: string): string {
  return path.join(config.cloudInitDir, `${vmName}-firewall.json`);
}

// Sanitise the VM name into the form iptables chain names allow. Chain
// names are limited to 28 chars, alphanumeric only — anything else and
// iptables refuses, so this also catches names that would be hostile.
function safeChainSegment(vmName: string): string {
  const safe = vmName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  if (safe.length === 0) throw new Error('VM name produces empty iptables segment');
  return safe;
}

function inChain(vmName: string): string {
  return `VP-IN-${safeChainSegment(vmName)}`;
}

function outChain(vmName: string): string {
  return `VP-OUT-${safeChainSegment(vmName)}`;
}

export async function getFirewallConfig(vmName: string): Promise<FirewallConfig> {
  try {
    const raw = await fs.readFile(firewallPath(vmName), 'utf8');
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

export async function saveFirewallConfig(vmName: string, cfg: FirewallConfig): Promise<void> {
  const withIds = cfg.rules.map((r) => ({ ...r, id: r.id || randomUUID() }));
  await fs.writeFile(
    firewallPath(vmName),
    JSON.stringify({ ...cfg, rules: withIds }, null, 2),
    'utf8'
  );
}

export async function deleteFirewallConfig(vmName: string): Promise<void> {
  await fs.unlink(firewallPath(vmName)).catch(() => {});
}

export async function renameFirewallConfig(oldName: string, newName: string): Promise<void> {
  try {
    const content = await fs.readFile(firewallPath(oldName), 'utf8');
    await fs.writeFile(firewallPath(newName), content, 'utf8');
    await fs.unlink(firewallPath(oldName));
  } catch { /* no firewall config for this VM */ }
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

export async function applyFirewallRules(vmName: string, vmIpRaw: string, cfg: FirewallConfig): Promise<void> {
  const vmIp = validateIpv4(vmIpRaw);
  const { rules, defaultInbound, defaultOutbound, allowEstablishedInbound, allowEstablishedOutbound } = cfg;
  const inC = inChain(vmName);
  const outC = outChain(vmName);

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
    args.push('-m', 'comment', '--comment', `virtpilot-fw-${safeChainSegment(vmName)}`);
    await runSafe('iptables', args);
  }

  const inDefault = defaultInbound === 'allow' ? 'ACCEPT' : 'DROP';
  const outDefault = defaultOutbound === 'allow' ? 'ACCEPT' : 'DROP';
  await runSafe('iptables', ['-A', inC, '-j', inDefault]);
  await runSafe('iptables', ['-A', outC, '-j', outDefault]);

  await run('iptables', ['-I', 'FORWARD', '-d', vmIp, '-j', inC]);
  await run('iptables', ['-I', 'FORWARD', '-s', vmIp, '-j', outC]);
}

export async function removeVmFirewall(vmName: string, vmIpRaw: string): Promise<void> {
  const vmIp = validateIpv4(vmIpRaw);
  const inC = inChain(vmName);
  const outC = outChain(vmName);
  await runSafe('iptables', ['-D', 'FORWARD', '-d', vmIp, '-j', inC]);
  await runSafe('iptables', ['-D', 'FORWARD', '-s', vmIp, '-j', outC]);
  for (const chain of [inC, outC]) {
    await runSafe('iptables', ['-F', chain]);
    await runSafe('iptables', ['-X', chain]);
  }
}
