import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';

const execAsync = promisify(exec);

export interface FirewallRule {
  id: string;
  direction: 'inbound' | 'outbound';
  protocol: 'tcp' | 'udp' | 'icmp' | 'all';
  portRange?: string;
  action: 'allow' | 'drop';
  description?: string;
}

export interface FirewallConfig {
  rules: FirewallRule[];
  defaultInbound: 'allow' | 'drop';
  defaultOutbound: 'allow' | 'drop';
}

function firewallPath(vmName: string): string {
  return path.join(config.cloudInitDir, `${vmName}-firewall.json`);
}

function inChain(vmName: string): string {
  const safe = vmName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  return `VP-IN-${safe}`;
}

function outChain(vmName: string): string {
  const safe = vmName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  return `VP-OUT-${safe}`;
}

export async function getFirewallConfig(vmName: string): Promise<FirewallConfig> {
  try {
    const raw = await fs.readFile(firewallPath(vmName), 'utf8');
    const cfg = JSON.parse(raw) as Partial<FirewallConfig>;
    return {
      rules: (cfg.rules ?? []).map((r) => ({ ...r, id: r.id || randomUUID() })),
      defaultInbound: cfg.defaultInbound ?? 'allow',
      defaultOutbound: cfg.defaultOutbound ?? 'allow',
    };
  } catch {
    return { rules: [], defaultInbound: 'allow', defaultOutbound: 'allow' };
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

async function chainExists(chain: string): Promise<boolean> {
  try {
    await execAsync(`iptables -L ${chain} -n`);
    return true;
  } catch {
    return false;
  }
}

export async function applyFirewallRules(vmName: string, vmIp: string, cfg: FirewallConfig): Promise<void> {
  const { rules, defaultInbound, defaultOutbound } = cfg;
  const inC = inChain(vmName);
  const outC = outChain(vmName);

  // Remove existing jump rules
  await execAsync(`iptables -D FORWARD -d ${vmIp} -j ${inC} 2>/dev/null`).catch(() => {});
  await execAsync(`iptables -D FORWARD -s ${vmIp} -j ${outC} 2>/dev/null`).catch(() => {});

  // Flush and remove chains
  for (const chain of [inC, outC]) {
    if (await chainExists(chain)) {
      await execAsync(`iptables -F ${chain}`).catch(() => {});
      await execAsync(`iptables -X ${chain}`).catch(() => {});
    }
  }

  // Nothing to do if no rules and both defaults are allow (iptables default behaviour)
  if (rules.length === 0 && defaultInbound === 'allow' && defaultOutbound === 'allow') return;

  // Create fresh chains
  await execAsync(`iptables -N ${inC}`);
  await execAsync(`iptables -N ${outC}`);

  for (const rule of rules) {
    const chain = rule.direction === 'inbound' ? inC : outC;
    const target = rule.action === 'allow' ? 'ACCEPT' : 'DROP';
    const parts: string[] = [`iptables -A ${chain}`];
    if (rule.protocol !== 'all') {
      parts.push(`-p ${rule.protocol}`);
      if (rule.portRange && (rule.protocol === 'tcp' || rule.protocol === 'udp')) {
        const range = rule.portRange.includes('-')
          ? rule.portRange.replace('-', ':')
          : rule.portRange;
        parts.push(`--dport ${range}`);
      }
    }
    parts.push(`-j ${target}`);
    parts.push(`-m comment --comment "virtpilot-fw-${vmName}"`);
    await execAsync(parts.join(' ')).catch(() => {});
  }

  // Append default policy as a catch-all rule at the end of each chain
  const inDefault = defaultInbound === 'allow' ? 'ACCEPT' : 'DROP';
  const outDefault = defaultOutbound === 'allow' ? 'ACCEPT' : 'DROP';
  await execAsync(`iptables -A ${inC} -j ${inDefault}`).catch(() => {});
  await execAsync(`iptables -A ${outC} -j ${outDefault}`).catch(() => {});

  // Insert jump rules at top of FORWARD
  await execAsync(`iptables -I FORWARD -d ${vmIp} -j ${inC}`);
  await execAsync(`iptables -I FORWARD -s ${vmIp} -j ${outC}`);
}

export async function removeVmFirewall(vmName: string, vmIp: string): Promise<void> {
  const inC = inChain(vmName);
  const outC = outChain(vmName);
  await execAsync(`iptables -D FORWARD -d ${vmIp} -j ${inC} 2>/dev/null`).catch(() => {});
  await execAsync(`iptables -D FORWARD -s ${vmIp} -j ${outC} 2>/dev/null`).catch(() => {});
  for (const chain of [inC, outC]) {
    await execAsync(`iptables -F ${chain} 2>/dev/null`).catch(() => {});
    await execAsync(`iptables -X ${chain} 2>/dev/null`).catch(() => {});
  }
}
