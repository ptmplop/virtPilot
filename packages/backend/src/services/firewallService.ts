import fs from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { config } from '../config.js';
import { run, runSafe } from './safeExec.js';
import {
  validateIpv4,
  validateIpv4OrCidr,
  validatePortRange,
  validateProtocol,
  validateIcmpType,
  ValidationError,
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

/**
 * Rejects a rule set that could not be applied.
 *
 * Validation used to happen only at apply time, so a rule with an out-of-range
 * port saved happily with a 200 and only blew up later — by which point the
 * operator had left the page believing it was in force.
 */
export function validateFirewallConfig(cfg: FirewallConfig): void {
  for (const [i, rule] of cfg.rules.entries()) {
    const where = `rule ${i + 1}${rule.description ? ` (${rule.description})` : ''}`;
    if (rule.direction !== 'inbound' && rule.direction !== 'outbound') {
      throw new ValidationError('direction', rule.direction, `${where}: must be inbound or outbound`);
    }
    if (rule.action !== 'allow' && rule.action !== 'drop') {
      throw new ValidationError('action', rule.action, `${where}: must be allow or drop`);
    }
    // The point of validating on save is telling the operator *which* rule is
    // wrong, so the field validators' own messages get the rule's identity
    // attached rather than surfacing bare.
    const inRule = <T>(field: string, value: unknown, run: () => T): T => {
      try {
        return run();
      } catch (err) {
        throw new ValidationError(field, value, `${where}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const protocol = inRule('protocol', rule.protocol, () => validateProtocol(rule.protocol));
    if (rule.portRange !== undefined && rule.portRange !== '') {
      if (protocol !== 'tcp' && protocol !== 'udp') {
        throw new ValidationError('portRange', rule.portRange, `${where}: ports only apply to tcp or udp`);
      }
      inRule('portRange', rule.portRange, () => validatePortRange(rule.portRange!));
    }
    if (rule.icmpType !== undefined && rule.icmpType !== '') {
      inRule('icmpType', rule.icmpType, () => validateIcmpType(rule.icmpType!));
    }
    if (rule.source !== undefined && rule.source !== '') {
      inRule('source', rule.source, () => validateIpv4OrCidr(rule.source!));
    }
    if (rule.destination !== undefined && rule.destination !== '') {
      inRule('destination', rule.destination, () => validateIpv4OrCidr(rule.destination!));
    }
  }
  for (const key of ['defaultInbound', 'defaultOutbound'] as const) {
    if (cfg[key] !== 'allow' && cfg[key] !== 'drop') {
      throw new ValidationError(key, cfg[key], 'must be allow or drop');
    }
  }
}

export async function saveFirewallConfig(vmUuid: string, cfg: FirewallConfig): Promise<void> {
  validateFirewallConfig(cfg);
  const withIds = cfg.rules.map((r) => ({ ...r, id: r.id || randomUUID() }));
  const { appliedHash } = await readAppliedHash(vmUuid);
  await fs.writeFile(
    firewallPath(vmUuid),
    JSON.stringify({ ...cfg, rules: withIds, appliedHash }, null, 2),
    'utf8'
  );
}

// What Apply last put in force, to tell it from what is saved. Undefined on a file from before
// this, which says nothing either way. Null from when an Apply starts until it succeeds.
function firewallHash(cfg: FirewallConfig): string {
  const rules = cfg.rules.map(({ id: _id, ...rule }) => rule);
  return createHash('sha256')
    .update(JSON.stringify([rules, cfg.defaultInbound, cfg.defaultOutbound, !!cfg.allowEstablishedInbound, !!cfg.allowEstablishedOutbound]))
    .digest('hex');
}

async function readAppliedHash(vmUuid: string): Promise<{ appliedHash?: string | null }> {
  try {
    const { appliedHash } = JSON.parse(await fs.readFile(firewallPath(vmUuid), 'utf8')) as { appliedHash?: string | null };
    return { appliedHash };
  } catch {
    return {};
  }
}

async function writeAppliedHash(vmUuid: string, appliedHash: string | null): Promise<void> {
  try {
    const saved = JSON.parse(await fs.readFile(firewallPath(vmUuid), 'utf8')) as object;
    await fs.writeFile(firewallPath(vmUuid), JSON.stringify({ ...saved, appliedHash }, null, 2), 'utf8');
  } catch { /* no saved rules to say this of */ }
}

export interface FirewallStatus {
  /** The addresses its jumps name: empty if none, null if iptables couldn't be read. */
  inForceOn: string[] | null;
  /** What is saved isn't what Apply last put in force, or an Apply failed. */
  unapplied: boolean;
  /** Bridged frames reach iptables at all. Without br_netfilter a bridged NIC isn't filtered. */
  bridgedFiltered: boolean;
}

export async function getFirewallStatus(vmUuid: string, cfg: FirewallConfig): Promise<FirewallStatus> {
  const { appliedHash } = await readAppliedHash(vmUuid);
  const sysctl = await fs.readFile('/proc/sys/net/bridge/bridge-nf-call-iptables', 'utf8').catch(() => '0');
  return {
    inForceOn: await firewallAddresses(vmUuid),
    unapplied: appliedHash === null || (appliedHash !== undefined && appliedHash !== firewallHash(cfg)),
    bridgedFiltered: sysctl.trim() === '1',
  };
}

export async function deleteFirewallConfig(vmUuid: string): Promise<void> {
  await fs.unlink(firewallPath(vmUuid)).catch(() => {});
}

// Every invocation waits up to 5s for the xtables lock. libvirt, docker and
// our own port-forward service all drive iptables on the same host, so without
// this a concurrent run makes us fail with "another app is currently holding
// the xtables lock" instead of simply queueing.
const WAIT = ['-w', '5'];

async function iptables(args: readonly string[]): Promise<string> {
  return run('iptables', [...WAIT, ...args]);
}

async function iptablesSafe(args: readonly string[]): Promise<string | null> {
  return runSafe('iptables', [...WAIT, ...args]);
}

// `-m comment` and `-m conntrack` need the xt_comment / xt_conntrack kernel
// modules. On a host without them iptables rejects the whole rule, so probe
// once against a scratch chain and degrade instead of failing every apply.
// Cached for the process lifetime — kernel modules don't come and go.
let matchSupport: Promise<{ comment: boolean; conntrack: boolean }> | null = null;

function probeMatchSupport(): Promise<{ comment: boolean; conntrack: boolean }> {
  if (!matchSupport) matchSupport = (async () => {
    const probe = 'VP-PROBE';
    await iptablesSafe(['-N', probe]);
    await iptablesSafe(['-F', probe]);
    const comment = (await iptablesSafe(['-A', probe, '-m', 'comment', '--comment', 'virtpilot-probe', '-j', 'ACCEPT'])) !== null;
    const conntrack = (await iptablesSafe(['-A', probe, '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'])) !== null;
    await iptablesSafe(['-F', probe]);
    await iptablesSafe(['-X', probe]);
    return { comment, conntrack };
  })();
  return matchSupport;
}

// Split one `iptables -S` line into argv tokens, unquoting double-quoted
// values (comments are emitted quoted). Exported because portForwardService
// has to reconcile its own rules out of a live table the same way.
export function tokeniseIptablesRule(line: string): string[] {
  const tokens: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    tokens.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  }
  return tokens;
}

// Delete every FORWARD rule that jumps to one of our chains, whatever its
// `-s`/`-d` match happens to be. Matching on the VM's current IP isn't enough:
// if the IP changed since the last apply, the old jump would be orphaned in
// FORWARD and keep filtering traffic for whoever inherits that address.
async function removeForwardJumps(chains: readonly string[]): Promise<void> {
  const dump = await iptablesSafe(['-S', 'FORWARD']);
  if (dump === null) return;
  for (const line of dump.split('\n')) {
    const tokens = tokeniseIptablesRule(line.trim());
    if (tokens[0] !== '-A' || tokens[1] !== 'FORWARD') continue;
    const jump = tokens.lastIndexOf('-j');
    if (jump === -1 || !chains.includes(tokens[jump + 1])) continue;
    await iptablesSafe(['-D', ...tokens.slice(1)]);
  }
}

// Apply rebuilds a VM's chains and jumps, and nothing should change them while it does.
let jumpChanges: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(change: () => Promise<T>): Promise<T> {
  const run = jumpChanges.then(change, change);
  jumpChanges = run.catch(() => {});
  return run;
}

// Until none are left: nothing stops a rule being there twice. iptables failing ends it too.
async function dropJumps(vmUuid: string, ip: string): Promise<void> {
  for (const [flag, chain] of [['-d', inChain(vmUuid)], ['-s', outChain(vmUuid)]]) {
    while ((await iptablesSafe(['-D', 'FORWARD', flag, ip, '-j', chain])) !== null) { /* next */ }
  }
}

// Throws if a jump can't go in: a forward with its ACCEPT in place and no firewall above it is open.
async function putJumps(vmUuid: string, ip: string): Promise<void> {
  await dropJumps(vmUuid, ip);
  await iptables(['-I', 'FORWARD', '-d', ip, '-j', inChain(vmUuid)]);
  await iptables(['-I', 'FORWARD', '-s', ip, '-j', outChain(vmUuid)]);
}

/**
 * Puts this VM's firewall jumps back at the head of FORWARD.
 *
 * Both the firewall and the port-forward service insert into FORWARD, so
 * whichever ran last used to end up on top — and the two orders gave opposite
 * security outcomes. Configure the firewall first and a later port forward sat
 * *above* it, quietly punching a hole through a deny-all inbound policy;
 * configure the forward first and the firewall shadowed it instead.
 *
 * The per-VM firewall is the policy and a port forward is only address
 * translation, so the firewall wins: the port-forward service calls this after
 * installing a rule. A forward onto a VM with a deny-all policy therefore needs
 * a matching allow rule, which is visible and fixable — unlike a firewall that
 * silently is not in force.
 *
 * So the forward's address joins the addresses the firewall is on, and no other is touched. Moving
 * it there instead would leave the NIC it filters unfiltered, and leaving it out would let a
 * forward on another NIC go around it: both have happened. `keepOnly`, for a new reservation that
 * has given the firewall's NIC a new address, drops the old one, keeping only those listed.
 *
 * No-op when the VM has no firewall chains, i.e. no policy has been applied.
 */
export function reassertForwardJumps(vmUuid: string, forwardIp: string, keepOnly?: readonly string[]): Promise<void> {
  return oneAtATime(async () => {
    if ((await iptablesSafe(['-S', inChain(vmUuid)])) === null) return;
    const ip = validateIpv4(forwardIp);
    await repairJumps(vmUuid);
    if (keepOnly) {
      for (const held of (await firewallAddresses(vmUuid)) ?? []) {
        if (held !== ip && !keepOnly.includes(held)) await dropJumps(vmUuid, held);
      }
    }
    await putJumps(vmUuid, ip);
  });
}

/** Puts the firewall on one more address. No-op with no chains. */
export function addFirewallAddress(vmUuid: string, ipRaw: string): Promise<void> {
  return oneAtATime(async () => {
    if ((await iptablesSafe(['-S', inChain(vmUuid)])) === null) return;
    await putJumps(vmUuid, validateIpv4(ipRaw));
  });
}

/** Takes the firewall off an address, which is free to pass to a VM these rules aren't for. */
export function removeFirewallAddress(vmUuid: string, ipRaw: string): Promise<void> {
  return oneAtATime(() => dropJumps(vmUuid, validateIpv4(ipRaw)));
}

/** The addresses a VM's firewall is on, from its jumps in FORWARD: none if it isn't, null if that can't be read. */
export async function firewallAddresses(vmUuid: string): Promise<string[] | null> {
  const jumps = await readJumps(vmUuid);
  return jumps && [...new Set([...jumps.inbound, ...jumps.outbound])];
}

async function readJumps(vmUuid: string): Promise<{ inbound: string[]; outbound: string[] } | null> {
  const dump = await iptablesSafe(['-S', 'FORWARD']);
  if (dump === null) return null;
  const inbound: string[] = [];
  const outbound: string[] = [];
  for (const line of dump.split('\n')) {
    const tokens = tokeniseIptablesRule(line.trim());
    const jump = tokens.lastIndexOf('-j');
    if (tokens[0] !== '-A' || tokens[1] !== 'FORWARD' || jump === -1) continue;
    const list = tokens[jump + 1] === inChain(vmUuid) ? inbound : tokens[jump + 1] === outChain(vmUuid) ? outbound : null;
    const match = tokens.findIndex((t) => t === '-d' || t === '-s');
    if (list && match !== -1) list.push(tokens[match + 1].replace(/\/32$/, ''));
  }
  return { inbound, outbound };
}

// One of a pair lost to a crash or a failed call leaves an address filtered one way only.
async function repairJumps(vmUuid: string): Promise<void> {
  const jumps = await readJumps(vmUuid);
  for (const ip of jumps?.outbound.filter((a) => !jumps.inbound.includes(a)) ?? []) await iptablesSafe(['-I', 'FORWARD', '-d', ip, '-j', inChain(vmUuid)]);
  for (const ip of jumps?.inbound.filter((a) => !jumps.outbound.includes(a)) ?? []) await iptablesSafe(['-I', 'FORWARD', '-s', ip, '-j', outChain(vmUuid)]);
}

async function destroyChains(chains: readonly string[]): Promise<void> {
  for (const chain of chains) {
    await iptablesSafe(['-F', chain]);
    await iptablesSafe(['-X', chain]);
  }
}

// xt_multiport stores at most 15 ports, and a range consumes two of those
// slots. validatePortRange deliberately allows longer lists so existing saved
// configs still load, so the cap is enforced here instead — at rule-build time,
// which runs before any live filtering is touched.
const MULTIPORT_MAX_ENTRIES = 15;

// Build the iptables --dport / --dports args for a port-range value. The
// value is pre-validated against PORT_RANGE_RE so we know it only contains
// digits, commas, hyphens, and colons.
function portArgs(portRange: string): string[] {
  if (portRange.includes(',')) {
    const parts = portRange.split(',');
    const slots = parts.reduce((n, p) => n + (p.includes('-') || p.includes(':') ? 2 : 1), 0);
    if (slots > MULTIPORT_MAX_ENTRIES) {
      throw new Error(
        `Port list "${portRange}" needs ${slots} multiport slots but the kernel allows at most ${MULTIPORT_MAX_ENTRIES} (a range counts as two). Split it across several rules.`
      );
    }
    const ports = parts.map((p) => p.includes('-') ? p.replace('-', ':') : p).join(',');
    return ['-m', 'multiport', '--dports', ports];
  }
  const range = portRange.includes('-') ? portRange.replace('-', ':') : portRange;
  return ['--dport', range];
}

export function applyFirewallRules(vmUuid: string, vmIpsRaw: readonly string[], cfg: FirewallConfig): Promise<void> {
  return oneAtATime(() => applyFirewallRulesNow(vmUuid, vmIpsRaw, cfg));
}

async function applyFirewallRulesNow(vmUuid: string, vmIpsRaw: readonly string[], cfg: FirewallConfig): Promise<void> {
  await writeAppliedHash(vmUuid, null);
  await rebuildFirewall(vmUuid, vmIpsRaw, cfg);
  await writeAppliedHash(vmUuid, firewallHash(cfg));
}

async function rebuildFirewall(vmUuid: string, vmIpsRaw: readonly string[], cfg: FirewallConfig): Promise<void> {
  const vmIps = [...new Set(vmIpsRaw.map((ip) => validateIpv4(ip)))];
  const { rules, defaultInbound, defaultOutbound, allowEstablishedInbound, allowEstablishedOutbound } = cfg;
  const inC = inChain(vmUuid);
  const outC = outChain(vmUuid);

  const isNoop =
    rules.length === 0 &&
    defaultInbound === 'allow' &&
    defaultOutbound === 'allow' &&
    !allowEstablishedInbound &&
    !allowEstablishedOutbound;

  // Build (and therefore validate) every rule BEFORE any live filtering is
  // touched. Tearing the chains down first meant a single malformed rule left
  // the VM completely unfiltered.
  const { comment: hasComment, conntrack: hasConntrack } = await probeMatchSupport();
  const commentArgs = hasComment
    ? ['-m', 'comment', '--comment', `virtpilot-fw-${uuidShort(vmUuid)}`]
    : [];

  // Allow means these rules have no objection, and no more: libvirt's rules and a forward's ACCEPT
  // are below the jumps. ACCEPT here would let in whatever libvirt refuses, on every port.
  const inDefault = defaultInbound === 'allow' ? 'RETURN' : 'DROP';
  const outDefault = defaultOutbound === 'allow' ? 'RETURN' : 'DROP';

  const ruleArgs: string[][] = isNoop ? [] : rules.map((rule) => {
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
    args.push(...commentArgs);
    return args;
  });

  await removeForwardJumps([inC, outC]);
  await destroyChains([inC, outC]);

  if (isNoop) return;

  try {
    // `-N` is best-effort and `-F` unconditional: a chain left behind by an
    // earlier half-finished apply must not make every later apply fail and
    // strand the VM with no filtering at all.
    for (const chain of [inC, outC]) {
      await iptablesSafe(['-N', chain]);
      await iptables(['-F', chain]);
    }

    if (allowEstablishedInbound || allowEstablishedOutbound) {
      if (hasConntrack) {
        if (allowEstablishedInbound) {
          await iptables(['-A', inC, '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT']);
        }
        if (allowEstablishedOutbound) {
          await iptables(['-A', outC, '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT']);
        }
      } else {
        console.warn('[firewall] Host has no xt_conntrack support - established/related rules omitted');
      }
    }

    // Strict from here on: a rejected rule used to be skipped silently, so the
    // API reported "Applied N rule(s)" for a policy the kernel never had.
    for (const args of ruleArgs) {
      await iptables(args);
    }

    await iptables(['-A', inC, '-j', inDefault]);
    await iptables(['-A', outC, '-j', outDefault]);

    for (const vmIp of vmIps) {
      await iptables(['-I', 'FORWARD', '-d', vmIp, '-j', inC]);
      await iptables(['-I', 'FORWARD', '-s', vmIp, '-j', outC]);
    }
  } catch (err) {
    // Half-built chains are worse than none — an incomplete allow-list can both
    // leak and black-hole traffic. But rolling back to *nothing* is worse still:
    // it left a `defaultInbound: 'drop'` VM with no chains and no FORWARD jumps,
    // i.e. completely unfiltered, and stickily so because every retry hit the
    // same rule. Fall back to the DECLARED default policy instead: empty chains
    // carrying only their terminal target, plus the FORWARD jumps. A failed
    // apply then fails CLOSED. Best-effort throughout — the caller must still
    // see the original error, so the API reports the failure honestly.
    try {
      await removeForwardJumps([inC, outC]);
      for (const chain of [inC, outC]) {
        await iptablesSafe(['-N', chain]);
        await iptablesSafe(['-F', chain]);
      }
      await iptablesSafe(['-A', inC, '-j', inDefault]);
      await iptablesSafe(['-A', outC, '-j', outDefault]);
      for (const vmIp of vmIps) {
        await iptablesSafe(['-I', 'FORWARD', '-d', vmIp, '-j', inC]);
        await iptablesSafe(['-I', 'FORWARD', '-s', vmIp, '-j', outC]);
      }
      console.warn(`[firewall] Apply failed for ${vmUuid} - fell back to the declared default policy (in=${inDefault}, out=${outDefault})`);
    } catch (fallbackErr) {
      console.error('[firewall] Could not install the default-policy fallback after a failed apply:', fallbackErr);
    }
    throw err;
  }
}

export function removeVmFirewall(vmUuid: string, _vmIpRaw?: string | null): Promise<void> {
  const inC = inChain(vmUuid);
  const outC = outChain(vmUuid);
  // Sweep FORWARD by jump target rather than by the VM's IP: the caller's idea
  // of the IP can be stale (or absent), and any jump we leave behind keeps
  // filtering traffic for whoever inherits that address next.
  return oneAtATime(async () => {
    await removeForwardJumps([inC, outC]);
    await destroyChains([inC, outC]);
  });
}
