import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { config } from '../config.js';
import { run, runSafe } from './safeExec.js';
import { chainsFor, parseFilterState, portsScript, removeVmScript, tableScript, vmChainsScript, type FilterState } from '../lib/bridgeFilter.js';
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

// Apply rebuilds a VM's chains and jumps and rewrites its file, and nothing should change either
// while it does.
let jumpChanges: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(change: () => Promise<T>): Promise<T> {
  const run = jumpChanges.then(change, change);
  jumpChanges = run.catch(() => {});
  return run;
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

export function saveFirewallConfig(vmUuid: string, cfg: FirewallConfig): Promise<void> {
  validateFirewallConfig(cfg);
  const withIds = cfg.rules.map((r) => ({ ...r, id: r.id || randomUUID() }));
  return oneAtATime(async () => {
    const { rules: _rules, defaultInbound: _in, defaultOutbound: _out, allowEstablishedInbound: _ein, allowEstablishedOutbound: _eout, ...inForce } = await readFirewallFile(vmUuid) ?? ({} as Partial<FirewallFile>);
    await writeFirewallFile(vmUuid, { ...inForce, ...cfg, rules: withIds });
  });
}

/** A VM's file: the rules as saved, and beside them what Apply last put in force. */
export interface FirewallFile extends FirewallConfig {
  /** Undefined on a file from before this, which says nothing either way. Null from when an Apply starts until it succeeds. */
  appliedHash?: string | null;
  /** What to put back after a host restart, which may not be what is saved. */
  applied?: FirewallConfig;
  /** The same for rules already in force when this version first saw them, as iptables lists them: they may not be what is saved, and nothing else says what they were. */
  appliedRaw?: string[];
  /** The addresses it was on at last look, so that putting it back needs nothing from libvirt. */
  appliedTo?: string[];
  /** What the chains listed when they were built. Something can empty them and leave their names. */
  chainsHash?: string;
  /**
   * On every routed NIC, and in force across the bridge, per NIC. Only set by Apply: rules applied
   * before these went on one NIC, and have never filtered the rest. An allow rule there would open
   * what libvirt refuses, and a default of drop cut what works, so nothing changes until someone
   * has looked. The Firewall tab says so till then.
   */
  everyNic?: boolean;
  /** In force at its taps. */
  bridgeLayer?: boolean;
  /** Its number on the host, 1 to 65535, for telling its connections from those a guest made up. */
  bridgeMark?: number;
  /** Why the last Apply couldn't put them in force across the bridge. */
  bridgeError?: string;
}

function firewallHash(cfg: FirewallConfig): string {
  const rules = cfg.rules.map(({ id: _id, ...rule }) => rule);
  return createHash('sha256')
    .update(JSON.stringify([rules, cfg.defaultInbound, cfg.defaultOutbound, !!cfg.allowEstablishedInbound, !!cfg.allowEstablishedOutbound]))
    .digest('hex');
}

async function readFirewallFile(vmUuid: string): Promise<FirewallFile | null> {
  try {
    return JSON.parse(await fs.readFile(firewallPath(vmUuid), 'utf8')) as FirewallFile;
  } catch {
    return null;
  }
}

// Whole or not at all: this file is now what a restarted host gets its firewall back from.
async function writeFirewallFile(vmUuid: string, file: FirewallFile): Promise<void> {
  const tmp = `${firewallPath(vmUuid)}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
  await fs.rename(tmp, firewallPath(vmUuid)).catch(async (err) => {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  });
}

async function updateFirewallFile(vmUuid: string, change: Partial<FirewallFile>): Promise<void> {
  const file = await readFirewallFile(vmUuid);
  if (file) await writeFirewallFile(vmUuid, { ...file, ...change });
}

/** Every VM with a firewall file, for the passes that look after them. */
export async function listFirewallFiles(): Promise<Array<{ vmUuid: string; file: FirewallFile }>> {
  const names = await fs.readdir(config.cloudInitDir).catch(() => [] as string[]);
  const found = await Promise.all(names.flatMap((name) => {
    const vmUuid = name.match(/^([0-9a-f-]{36})-firewall\.json$/)?.[1];
    return vmUuid ? [readFirewallFile(vmUuid).then((file) => (file ? { vmUuid, file } : null))] : [];
  }));
  return found.flatMap((f) => (f ? [f] : []));
}

function asConfig(file: FirewallFile): FirewallConfig {
  return {
    rules: file.rules ?? [],
    defaultInbound: file.defaultInbound ?? 'allow',
    defaultOutbound: file.defaultOutbound ?? 'allow',
    allowEstablishedInbound: file.allowEstablishedInbound ?? false,
    allowEstablishedOutbound: file.allowEstablishedOutbound ?? false,
  };
}

function hasNoRules(cfg: FirewallConfig): boolean {
  return cfg.rules.length === 0 && cfg.defaultInbound === 'allow' && cfg.defaultOutbound === 'allow' && !cfg.allowEstablishedInbound && !cfg.allowEstablishedOutbound;
}

export type InForce = { cfg: FirewallConfig; raw?: undefined } | { raw: string[]; cfg?: undefined };

/**
 * What should be in force on this VM, null for nothing. A file with rules Apply never put in force
 * has none of these: those wait to be applied, and so do edits that were never applied, which a
 * hash from 2.16.7 can tell from what was.
 */
export function firewallInForce(file: FirewallFile): InForce | null {
  if (file.applied) return hasNoRules(file.applied) ? null : { cfg: file.applied };
  if (file.appliedRaw) return { raw: file.appliedRaw };
  const saved = asConfig(file);
  return file.appliedHash === firewallHash(saved) && !hasNoRules(saved) ? { cfg: saved } : null;
}

export interface FirewallStatus {
  /** Apply has put rules in force, or the host will on its next look at this VM. */
  applied: boolean;
  /** The addresses its jumps name: empty if none, null if iptables couldn't be read. */
  inForceOn: string[] | null;
  /** The tap devices its rules are in force on, across the bridge. */
  ports: string[];
  /** What is saved isn't what Apply last put in force, or an Apply failed. */
  unapplied: boolean;
  /** Applied since this version, so in force across the bridge too. */
  bridgeLayer: boolean;
  /** Why not, if an Apply tried. */
  bridgeError?: string;
}

export async function getFirewallStatus(vmUuid: string, cfg: FirewallConfig): Promise<FirewallStatus> {
  const file = await readFirewallFile(vmUuid);
  const appliedHash = file?.appliedHash;
  const state = await readFilterState();
  const short = uuidShort(vmUuid);
  return {
    applied: !!file && firewallInForce(file) !== null,
    inForceOn: await firewallAddresses(vmUuid),
    ports: [...state.ports].filter(([, owner]) => owner === short).map(([tap]) => tap),
    unapplied: appliedHash === null || (appliedHash !== undefined && appliedHash !== firewallHash(cfg)),
    bridgeLayer: !!file?.bridgeLayer,
    bridgeError: file?.bridgeError,
  };
}

export function deleteFirewallConfig(vmUuid: string): Promise<void> {
  return oneAtATime(async () => {
    await fs.unlink(firewallPath(vmUuid)).catch(() => {});
    for (const kind of ['ipt', 'nft'] as const) await fs.unlink(bootPath(vmUuid, kind)).catch(() => {});
  });
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

// Until none are left: nothing stops a rule being there twice. iptables failing ends it too.
async function dropJumps(vmUuid: string, ip: string): Promise<void> {
  for (const [flag, chain] of [['-d', inChain(vmUuid)], ['-s', outChain(vmUuid)]]) {
    while ((await iptablesSafe(['-D', 'FORWARD', flag, ip, '-j', chain])) !== null) { /* next */ }
  }
}

// Throws if a jump can't go in: a forward with its ACCEPT in place and no firewall above it is open.
// In one step, or for a moment there is no jump and that forward is open anyway.
async function putJumps(vmUuid: string, ip: string): Promise<void> {
  const inJump = `-d ${ip}/32 -j ${inChain(vmUuid)}`;
  const outJump = `-s ${ip}/32 -j ${outChain(vmUuid)}`;
  const present = ((await iptablesSafe(['-S', 'FORWARD'])) ?? '').split('\n').map((line) => line.trim().replace(/^-A FORWARD /, ''));
  const gone = present.filter((line) => line === inJump || line === outJump).map((line) => `-D FORWARD ${line}`);
  await restoreTable([...gone, `-I FORWARD -d ${ip} -j ${inChain(vmUuid)}`, `-I FORWARD -s ${ip} -j ${outChain(vmUuid)}`]);
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
 * forward on another NIC go around it: both have happened.
 *
 * No-op when the VM has no firewall chains, i.e. no policy has been applied.
 */
export function reassertForwardJumps(vmUuid: string, forwardIp: string): Promise<void> {
  return oneAtATime(async () => {
    if ((await iptablesSafe(['-S', inChain(vmUuid)])) === null) return;
    await repairJumps(vmUuid);
    await putJumps(vmUuid, validateIpv4(forwardIp));
    await noteAddresses(vmUuid);
  });
}

/** Puts the firewall on one more address. No-op with no chains, or with its rules since taken out of force. */
export function addFirewallAddress(vmUuid: string, ipRaw: string): Promise<void> {
  return oneAtATime(async () => {
    const file = await readFirewallFile(vmUuid);
    if (!file || !firewallInForce(file) || (await iptablesSafe(['-S', inChain(vmUuid)])) === null) return;
    await putJumps(vmUuid, validateIpv4(ipRaw));
    await noteAddresses(vmUuid);
  });
}

/** Takes the firewall off an address, which is free to pass to a VM these rules aren't for. */
export function removeFirewallAddress(vmUuid: string, ipRaw: string): Promise<void> {
  return oneAtATime(async () => {
    await dropJumps(vmUuid, validateIpv4(ipRaw));
    await noteAddresses(vmUuid);
  });
}

// Read back rather than worked out, so the file says what the kernel has. If it can't be read the
// last answer stands, and the next pass tries again.
async function noteAddresses(vmUuid: string): Promise<void> {
  const held = await firewallAddresses(vmUuid);
  if (held) {
    await updateFirewallFile(vmUuid, { appliedTo: held });
    await writeBootFiles(vmUuid);
  }
}

const bootPath = (vmUuid: string, kind: 'ipt' | 'nft') => path.join(config.cloudInitDir, `${vmUuid}-firewall.boot.${kind}`);

/**
 * For libvirt's hook, which runs as root as a VM starts, before the backend has any say: what to
 * load, ready-made, so that it runs no code of the service's, only nft and iptables-restore on
 * these. Rewritten whenever what is in force changes, and taken away with it.
 */
async function writeBootFiles(vmUuid: string): Promise<void> {
  const file = await readFirewallFile(vmUuid);
  const inForce = file && firewallInForce(file);
  const put = async (kind: 'ipt' | 'nft', lines: readonly string[] | null) => {
    if (!lines) {
      await fs.unlink(bootPath(vmUuid, kind)).catch(() => {});
      return;
    }
    const tmp = `${bootPath(vmUuid, kind)}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, `${lines.join('\n')}\n`, 'utf8');
    await fs.rename(tmp, bootPath(vmUuid, kind));
  };
  if (!inForce) {
    await put('ipt', null);
    await put('nft', null);
    return;
  }
  const ips = [...new Set((file.appliedTo ?? []).map((ip) => validateIpv4(ip)))];
  await put('ipt', ['*filter', ...await chainLines(vmUuid, inForce), ...ips.flatMap((ip) => [`-I FORWARD -d ${ip} -j ${inChain(vmUuid)}`, `-I FORWARD -s ${ip} -j ${outChain(vmUuid)}`]), 'COMMIT']);
  await put('nft', file.bridgeLayer && inForce.cfg && file.bridgeMark ? [...tableScript(hostAddresses()), ...vmChainsScript(uuidShort(vmUuid), inForce.cfg, file.bridgeMark)] : null);
}

/**
 * The addresses whose jumps in FORWARD are under a rule that should be under them: libvirt's, or a
 * port forward's ACCEPT. Whoever inserted last is on top, and a crash between a forward's ACCEPT
 * and the call above would leave that forward open.
 */
export function jumpsOutOfPlace(forward: string, vmUuid: string): string[] {
  const chains = new Set([inChain(vmUuid), outChain(vmUuid)]);
  let lowest = -1;
  const below = new Set<string>();
  const accepts = new Map<string, number>();
  const lines = forward.split('\n').map((line) => tokeniseIptablesRule(line.trim())).filter((t) => t[0] === '-A' && t[1] === 'FORWARD');
  lines.forEach((tokens, i) => {
    const target = tokens[tokens.lastIndexOf('-j') + 1];
    if (target?.startsWith('LIBVIRT_') && lowest === -1) lowest = i;
    const comment = tokens[tokens.indexOf('--comment') + 1];
    const to = tokens[tokens.indexOf('-d') + 1];
    if (target === 'ACCEPT' && comment?.startsWith('virtpilot-') && tokens.includes('-d') && !accepts.has(to)) accepts.set(to, i);
  });
  lines.forEach((tokens, i) => {
    const target = tokens[tokens.lastIndexOf('-j') + 1];
    if (!chains.has(target)) return;
    const flag = tokens.findIndex((t) => t === '-d' || t === '-s');
    if (flag === -1) return;
    const ip = tokens[flag + 1];
    const accept = accepts.get(ip);
    if ((lowest !== -1 && i > lowest) || (accept !== undefined && i > accept)) below.add(ip.replace(/\/32$/, ''));
  });
  return [...below];
}

/** Puts this VM's jumps for these addresses back on top, for the pass that found them under something. */
export function raiseFirewallAddresses(vmUuid: string, ips: readonly string[]): Promise<void> {
  return oneAtATime(async () => {
    for (const ip of ips) await putJumps(vmUuid, validateIpv4(ip));
  });
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

/**
 * Puts these rules in force, on these addresses and these taps. Says so if the bridge side of it
 * couldn't be, which leaves what is routed through this host filtered and is no reason to fail that.
 */
export function applyFirewallRules(vmUuid: string, vmIpsRaw: readonly string[], cfg: FirewallConfig, ports: readonly string[] = []): Promise<{ bridgeError?: string }> {
  return oneAtATime(async () => {
    await updateFirewallFile(vmUuid, { appliedHash: null });
    // Whatever it is on now stays. What Apply could read of the VM may be less than what is true,
    // and the regular check is what takes an address off, on evidence.
    const ips = hasNoRules(cfg) ? [] : [...new Set([...vmIpsRaw, ...(await firewallAddresses(vmUuid) ?? [])])];
    await rebuildFirewall(vmUuid, ips, cfg);
    const before = await readFirewallFile(vmUuid);
    const bridgeMark = before?.bridgeMark ?? await freeBridgeMark();
    const bridgeError = await loadBridgeFilter(vmUuid, cfg, ports, bridgeMark).then(() => undefined, nftError);
    // Only what it has now, as far as anything can say: an address it held once may be another VM's.
    if (!bridgeError && !before?.bridgeLayer && !hasNoRules(cfg)) await markOpenConnections([...new Set(vmIpsRaw)], bridgeMark);
    await updateFirewallFile(vmUuid, { appliedHash: firewallHash(cfg), applied: cfg, appliedRaw: undefined, appliedTo: ips, chainsHash: await chainsFingerprint(vmUuid), everyNic: true, bridgeLayer: !bridgeError, bridgeError, bridgeMark });
    await writeBootFiles(vmUuid);
    return bridgeError ? { bridgeError } : {};
  });
}

function nftError(err: { stderr?: unknown; message?: string }): string {
  return String(err.stderr || err.message).trim().split('\n').slice(0, 3).join(' ');
}

// The lowest number no other VM's file has. Inside the queue, so two Applies can't take one.
async function freeBridgeMark(): Promise<number> {
  const taken = new Set((await listFirewallFiles()).map(({ file }) => file.bridgeMark));
  for (let n = 1; n <= 0xffff; n++) if (!taken.has(n)) return n;
  throw new Error('No firewall mark left on this host');
}

/** The host's own addresses, whose traffic to and from its guests is the host's business. */
function hostAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flatMap((list) => (list ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address));
}

/**
 * Connections a VM already had when its rules first went on at the tap were tracked unmarked, so
 * their replies would no longer count as its own and it would lose them. Given its half of the mark,
 * by the addresses it has, where `conntrack` is there to do it: the top half on what it started, the
 * bottom on what came to it. The other half is left as it was, as another VM's.
 */
async function markOpenConnections(ips: readonly string[], mark: number): Promise<void> {
  for (const ip of ips) {
    await runSafe('conntrack', ['-U', '--orig-src', validateIpv4(ip), '--mark', `${mark * 0x10000}/${0xffff0000}`], { timeout: 10_000 });
    await runSafe('conntrack', ['-U', '--orig-dst', validateIpv4(ip), '--mark', `${mark}/${0x0000ffff}`], { timeout: 10_000 });
  }
}

// In one transaction, as nft does a script: every frame meets the old rules or the new.
async function nftScript(lines: readonly string[]): Promise<void> {
  const file = path.join(os.tmpdir(), `virtpilot-bridge-${randomUUID()}.nft`);
  try {
    await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
    await run('nft', ['-f', file]);
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}

/** The bridge filter as it is now. Empty if nft has no such table, or there's no nft to ask. */
export async function readFilterState(): Promise<FilterState> {
  return parseFilterState(await runSafe('nft', ['-j', 'list', 'table', 'bridge', 'virtpilot']) ?? '');
}

async function tapGone(tap: string): Promise<boolean> {
  return fs.access(`/sys/class/net/${tap}`).then(() => false, () => true);
}

async function loadBridgeFilter(vmUuid: string, cfg: FirewallConfig, ports: readonly string[], mark: number): Promise<void> {
  const short = uuidShort(vmUuid);
  const state = await readFilterState();
  if (hasNoRules(cfg)) {
    await dropFromBridgeFilter(short, state);
    return;
  }
  const stale = [...state.ports].filter(([tap, owner]) => owner === short && !ports.includes(tap)).map(([tap]) => tap);
  await nftScript([...tableScript(hostAddresses()), ...vmChainsScript(short, cfg, mark), ...portsScript(short, ports, stale)]);
}

async function dropFromBridgeFilter(short: string, state: FilterState): Promise<void> {
  const { inChain } = chainsFor(short);
  if (!state.chains.has(inChain)) return;
  await nftScript(removeVmScript(short, [...state.ports].filter(([, owner]) => owner === short).map(([tap]) => tap)));
}

/**
 * Puts this VM's chains back as they should be, whatever has been done to them, and brings its taps
 * into line: a VM's taps change every time it starts. All of it again each pass, in one step, as
 * nothing else would notice chains emptied behind its back. A tap only comes off when its device
 * has gone: this list was read around slow calls, and a VM can have started meanwhile, with its
 * hook putting its new taps in. Never throws: the bridge half failing is said on the tab, and is no
 * reason to stop the routed half following the VM.
 */
export function syncBridgePorts(vmUuid: string, ports: readonly string[]): Promise<void> {
  return oneAtATime(async () => {
    const file = await readFirewallFile(vmUuid);
    const cfg = file?.bridgeLayer ? firewallInForce(file)?.cfg : undefined;
    if (!file || !cfg || !file.bridgeMark) return;
    const short = uuidShort(vmUuid);
    const mark = file.bridgeMark;
    try {
      const state = await readFilterState();
      const held = [...state.ports].filter(([, owner]) => owner === short).map(([tap]) => tap);
      const stale: string[] = [];
      for (const tap of held.filter((t) => !ports.includes(t))) if (await tapGone(tap)) stale.push(tap);
      await nftScript([...tableScript(hostAddresses()), ...vmChainsScript(short, cfg, mark), ...portsScript(short, ports.filter((t) => !held.includes(t)), stale)]);
      if (file.bridgeError) await updateFirewallFile(vmUuid, { bridgeError: undefined });
    } catch (err) {
      const said = nftError(err as { stderr?: unknown; message?: string });
      if (said !== file.bridgeError) await updateFirewallFile(vmUuid, { bridgeError: said });
    }
  });
}

/**
 * Whatever is in the filter for a VM with nothing in force there: one deleted while the backend was
 * down, say. Read here, inside the queue, as an Apply between reading the files and the filter would
 * otherwise lose a first Apply's chains.
 */
export function sweepBridgeFilter(): Promise<void> {
  return oneAtATime(async () => {
    const state = await readFilterState();
    if (state.chains.size === 0) return;
    const wanted = new Set((await listFirewallFiles()).filter(({ file }) => file.bridgeLayer && firewallInForce(file)?.cfg).map(({ vmUuid }) => uuidShort(vmUuid)));
    const shorts = [...state.chains].flatMap((name) => name.match(/^vp-in-([0-9a-f]{8})$/)?.[1] ?? []);
    for (const short of shorts.filter((s) => !wanted.has(s))) await dropFromBridgeFilter(short, state).catch(() => {});
  });
}

/** Whether this VM's chains are in the kernel. If that can't be read they are as good as not, and rebuilding them harms nothing. */
export async function firewallChainsExist(vmUuid: string): Promise<boolean> {
  return (await iptablesSafe(['-S', inChain(vmUuid)])) !== null;
}

// What the two chains list, to know them again. Null if either isn't there.
async function chainsFingerprint(vmUuid: string): Promise<string | undefined> {
  const [inList, outList] = await Promise.all([iptablesSafe(['-S', inChain(vmUuid)]), iptablesSafe(['-S', outChain(vmUuid)])]);
  return inList === null || outList === null ? undefined : createHash('sha256').update(`${inList}\n${outList}`).digest('hex');
}

async function rebuildInForce(vmUuid: string, ips: readonly string[], inForce: InForce): Promise<void> {
  if (inForce.cfg) {
    await rebuildFirewall(vmUuid, ips, inForce.cfg);
    return;
  }
  await restoreTable([...await chainLines(vmUuid, inForce), ...await jumpSwap(vmUuid, [...new Set(ips.map((ip) => validateIpv4(ip)))])]);
}

/** A VM's two chains as iptables-restore lines, emptying them first. */
async function chainLines(vmUuid: string, inForce: InForce): Promise<string[]> {
  const inC = inChain(vmUuid);
  const outC = outChain(vmUuid);
  const chains = [`:${inC} - [0:0]`, `:${outC} - [0:0]`];
  if (inForce.raw) return [...chains, ...inForce.raw.filter((line) => line.startsWith(`-A ${inC} `) || line.startsWith(`-A ${outC} `))];
  return [...chains, ...await ruleLines(vmUuid, inForce.cfg)];
}

/**
 * Sees that what should be in force is, and puts it back if not: a host restart, or anything that
 * emptied or changed the chains. Reads the file here and not before, as it was asked for around
 * slow calls and a delete or an Apply may have happened since. Nothing here asks libvirt.
 * `none` if nothing should be in force, and `rebuilt` if something was missing.
 */
export function keepInForce(vmUuid: string, ipsRaw: readonly string[]): Promise<'none' | 'ok' | 'rebuilt'> {
  return oneAtATime(async () => {
    const file = await readFirewallFile(vmUuid);
    const inForce = file && firewallInForce(file);
    if (!inForce) return 'none';
    const now = await chainsFingerprint(vmUuid);
    if (now !== undefined && (!file.chainsHash || now === file.chainsHash)) {
      if (!file.chainsHash) await updateFirewallFile(vmUuid, { chainsHash: now });
      await repairJumps(vmUuid);
      return 'ok';
    }
    const ips = [...new Set([...(file.appliedTo ?? []), ...ipsRaw])];
    await rebuildInForce(vmUuid, ips, inForce);
    // The bridge half too, without its taps, which a start or the regular check puts in. If it fails
    // the routed half is back all the same.
    if (file.bridgeLayer && inForce.cfg && file.bridgeMark) await nftScript([...tableScript(hostAddresses()), ...vmChainsScript(uuidShort(vmUuid), inForce.cfg, file.bridgeMark)]).catch(() => {});
    await updateFirewallFile(vmUuid, { appliedTo: ips, chainsHash: await chainsFingerprint(vmUuid) });
    await writeBootFiles(vmUuid);
    return 'rebuilt';
  });
}

/**
 * A firewall from before there was a copy to keep, in force now. Saved rules are that copy only if
 * 2.16.7's hash says they are what was applied: otherwise they may be a draft, and putting a draft
 * in force at the next restart isn't for an upgrade to do. What the kernel has is what was applied.
 */
export function noteRulesAlreadyInForce(vmUuid: string): Promise<void> {
  return oneAtATime(async () => {
    const file = await readFirewallFile(vmUuid);
    if (!file || file.applied || file.appliedRaw) return;
    const lists = await Promise.all([iptablesSafe(['-S', inChain(vmUuid)]), iptablesSafe(['-S', outChain(vmUuid)])]);
    if (lists.some((list) => list === null)) return;
    const saved = asConfig(file);
    const known = file.appliedHash === firewallHash(saved);
    await updateFirewallFile(vmUuid, {
      ...(known ? { applied: saved } : { appliedRaw: lists.flatMap((list) => list!.split('\n')).filter((line) => line.startsWith('-A ')) }),
      appliedTo: await firewallAddresses(vmUuid) ?? file.appliedTo ?? [],
    });
    await writeBootFiles(vmUuid);
  });
}

// All of it in one step, as one transaction of iptables-restore: a VM's rules used to be taken away
// and put back one call at a time, and it had none for as long as that took. --noflush leaves the
// rest of the table alone, and naming a chain empties it.
async function restoreTable(lines: readonly string[]): Promise<void> {
  const file = path.join(os.tmpdir(), `virtpilot-firewall-${randomUUID()}.rules`);
  try {
    await fs.writeFile(file, ['*filter', ...lines, 'COMMIT', ''].join('\n'), 'utf8');
    await run('iptables-restore', [...WAIT, '--noflush', file]);
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}

async function jumpSwap(vmUuid: string, vmIps: readonly string[]): Promise<string[]> {
  const inC = inChain(vmUuid);
  const outC = outChain(vmUuid);
  const dump = await iptablesSafe(['-S', 'FORWARD']);
  const gone = (dump ?? '').split('\n').flatMap((line) => {
    const tokens = tokeniseIptablesRule(line.trim());
    const jump = tokens.lastIndexOf('-j');
    return tokens[0] === '-A' && tokens[1] === 'FORWARD' && jump !== -1 && [inC, outC].includes(tokens[jump + 1])
      ? [`-D ${tokens.slice(1).join(' ')}`]
      : [];
  });
  return [...gone, ...vmIps.flatMap((vmIp) => [`-I FORWARD -d ${vmIp} -j ${inC}`, `-I FORWARD -s ${vmIp} -j ${outC}`])];
}

/** A VM's rules as iptables-restore lines, its two chains' contents. Validates every rule, and throws first. */
async function ruleLines(vmUuid: string, cfg: FirewallConfig): Promise<string[]> {
  const { rules, defaultInbound, defaultOutbound, allowEstablishedInbound, allowEstablishedOutbound } = cfg;
  const inC = inChain(vmUuid);
  const outC = outChain(vmUuid);
  const { comment: hasComment, conntrack: hasConntrack } = await probeMatchSupport();
  const commentArgs = hasComment
    ? ['-m', 'comment', '--comment', `virtpilot-fw-${uuidShort(vmUuid)}`]
    : [];

  // Allow means these rules have no objection, and no more: libvirt's rules and a forward's ACCEPT
  // are below the jumps. ACCEPT here would let in whatever libvirt refuses, on every port.
  const inDefault = defaultInbound === 'allow' ? 'RETURN' : 'DROP';
  const outDefault = defaultOutbound === 'allow' ? 'RETURN' : 'DROP';

  const ruleArgs: string[][] = rules.map((rule) => {
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

  const established: string[] = [];
  if (allowEstablishedInbound || allowEstablishedOutbound) {
    if (hasConntrack) {
      if (allowEstablishedInbound) established.push(`-A ${inC} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`);
      if (allowEstablishedOutbound) established.push(`-A ${outC} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`);
    } else {
      console.warn('[firewall] Host has no xt_conntrack support - established/related rules omitted');
    }
  }
  return [...established, ...ruleArgs.map((args) => args.join(' ')), `-A ${inC} -j ${inDefault}`, `-A ${outC} -j ${outDefault}`];
}

async function rebuildFirewall(vmUuid: string, vmIpsRaw: readonly string[], cfg: FirewallConfig): Promise<void> {
  const vmIps = [...new Set(vmIpsRaw.map((ip) => validateIpv4(ip)))];
  const inC = inChain(vmUuid);
  const outC = outChain(vmUuid);

  if (hasNoRules(cfg)) {
    await removeForwardJumps([inC, outC]);
    await destroyChains([inC, outC]);
    return;
  }

  // Build (and therefore validate) every rule BEFORE any live filtering is
  // touched. Tearing the chains down first meant a single malformed rule left
  // the VM completely unfiltered.
  const lines = await ruleLines(vmUuid, cfg);
  const chains = [`:${inC} - [0:0]`, `:${outC} - [0:0]`];
  const defaults = lines.slice(-2);
  const hadRules = await firewallChainsExist(vmUuid);

  try {
    // A rejected rule rejects the whole step, with whatever was in force still in force.
    await restoreTable([...chains, ...lines, ...await jumpSwap(vmUuid, vmIps)]);
  } catch (err) {
    if (hadRules) throw err;
    // With nothing in force, an incomplete allow-list can both leak and black-hole traffic, and no
    // rules at all leaves a `defaultInbound: 'drop'` VM unfiltered, stickily so as every retry hits
    // the same rule. Fall back to the DECLARED default policy: empty chains carrying only their
    // terminal target, plus the FORWARD jumps. A failed apply then fails CLOSED. The caller still
    // sees the original error, so the API reports the failure honestly.
    try {
      await restoreTable([...chains, ...defaults, ...await jumpSwap(vmUuid, vmIps)]);
      console.warn(`[firewall] Apply failed for ${vmUuid} - fell back to the declared default policy (${defaults.join(', ')})`);
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
    await dropFromBridgeFilter(uuidShort(vmUuid), await readFilterState()).catch((err) => console.warn(`[firewall] Could not take ${vmUuid} out of the bridge filter:`, err));
    for (const kind of ['ipt', 'nft'] as const) await fs.unlink(bootPath(vmUuid, kind)).catch(() => {});
  });
}
