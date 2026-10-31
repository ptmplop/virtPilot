// A bridge owned by a libvirt network, which is how a VXLAN and a managed bridge get theirs:
// libvirt brings it back at boot, before any VM needs it. Both reconcile passes come here
// when one has gone.

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { virshMessage } from '../lib/passthroughErrors.js';
import { runSafe, virsh } from './safeExec.js';

export function plainError(err: unknown): string {
  const raw = String((err as { stderr?: string })?.stderr || (err instanceof Error ? err.message : err));
  return virshMessage(raw);
}

/**
 * Asked of the kernel, not libvirt: a libvirt that is stalled or restarting says nothing
 * about the bridge, and traffic doesn't need libvirt to cross it.
 */
export async function bridgeExists(bridge: string): Promise<boolean> {
  return fs.access(`/sys/class/net/${bridge}`).then(() => true, () => false);
}

/**
 * Define the libvirt network and set it to autostart, and start it unless told otherwise.
 * Told otherwise for a bridge that is already live: starting one fails with "File exists".
 * Only a network being made here is taken away again on failure: one being repaired may be
 * running with VMs on it. Not to be called on a name that may exist: with no <uuid> in the
 * XML libvirt generates a new one, and then refuses the name.
 */
export async function defineLibvirtNetwork(libvirtName: string, xml: string, opts: { start?: boolean } = {}): Promise<void> {
  const file = path.join(os.tmpdir(), `vp-net-${randomUUID()}.xml`);
  await fs.writeFile(file, xml, 'utf8');
  try {
    await virsh(['net-define', file]);
    if (opts.start !== false) await virsh(['net-start', libvirtName]);
    await virsh(['net-autostart', libvirtName]);
  } catch (err) {
    if (opts.start !== false) await removeLibvirtNetwork(libvirtName);
    throw new Error(plainError(err));
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}

export async function removeLibvirtNetwork(libvirtName: string): Promise<void> {
  await runSafe('virsh', ['-c', config.libvirtUri, 'net-destroy', libvirtName], { timeout: 30_000 });
  await runSafe('virsh', ['-c', config.libvirtUri, 'net-undefine', libvirtName], { timeout: 30_000 });
}

const knownIfindex = new Map<string, string>();
const reconnecting = new Set<string>();

async function reconnectRunningVms(bridge: string): Promise<string[]> {
  let vms: Awaited<ReturnType<typeof import('./vmService.js')['listVmsWithNics']>>;
  try {
    // Lazy import: vmService imports networkService, which imports this module.
    vms = await (await import('./vmService.js')).listVmsWithNics();
  } catch (err) {
    return [`Its bridge was rebuilt, and running VMs on it can't be put back until libvirt can list them: ${plainError(err)}`];
  }
  const lost: string[] = [];
  for (const vm of vms) {
    if (vm.status !== 'running') continue;
    for (const nic of vm.nics) {
      if (nic.source !== bridge || !nic.target || nic.target === '-') continue;
      if ((await runSafe('ip', ['link', 'set', nic.target, 'master', bridge])) === null) lost.push(vm.name);
    }
  }
  return lost.length > 0 ? [`${lost.join(', ')} lost this network when its bridge went away, and need a restart to get it back.`] : [];
}

/**
 * A bridge that was rebuilt took every running VM's tap off it, and libvirt doesn't put them
 * back when the network starts again. Every pass calls this: a new ifindex says it happened,
 * from sysfs alone, even if the restart fell between two passes. Kept up until it works.
 */
export async function reconnectIfRebuilt(bridge: string): Promise<string[]> {
  const ifindex = await fs.readFile(`/sys/class/net/${bridge}/ifindex`, 'utf8').then((s) => s.trim(), () => null);
  if (ifindex === null) return [];
  const known = knownIfindex.get(bridge);
  knownIfindex.set(bridge, ifindex);
  if (known !== undefined && known !== ifindex) reconnecting.add(bridge);
  if (!reconnecting.has(bridge)) return [];
  const said = await reconnectRunningVms(bridge);
  if (said.length === 0) reconnecting.delete(bridge);
  return said;
}

/** Bring back a bridge that has gone. Returns what went wrong. Follow with reconnectIfRebuilt. */
export async function restoreBridge(libvirtName: string, bridge: string): Promise<string[]> {
  const failed = (err: unknown) => [`Its libvirt network ${libvirtName} isn't running and would not start: ${plainError(err)}`];
  try {
    await virsh(['net-start', libvirtName]);
  } catch (err) {
    if (!/already active/i.test(plainError(err))) return failed(err);
    // Look again before going further. At boot this call waits for libvirt's own autostart,
    // so the bridge may have arrived in the meantime, with VMs on it.
    if (await bridgeExists(bridge)) return [];
    // Taken from under libvirt, by `ip link delete` or the bridge module being unloaded.
    // It still counts the network as running, so every start fails until it is stopped.
    try {
      await virsh(['net-destroy', libvirtName]);
      await virsh(['net-start', libvirtName]);
    } catch (again) {
      return failed(again);
    }
  }
  reconnecting.add(bridge);
  return [];
}
