import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { buildPassthroughReport, scrubAddresses } from './passthroughReport.js';
import { buildInventory } from './hostDevices.js';
import type { HostFacts } from './hostFacts.js';

const facts: HostFacts = JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', 'bp8-vt-on.json'), 'utf8'));

describe('scrubAddresses', () => {
  it('removes network addresses and keeps PCI ones', () => {
    expect(scrubAddresses("Carries the host's network (eth0, 203.0.113.78)")).toBe("Carries the host's network (eth0, <address>)");
    expect(scrubAddresses('Shares a group with Thermal (00:14.2)')).toBe('Shares a group with Thermal (00:14.2)');
    expect(scrubAddresses('fd00:1234::1/64 on br0')).toBe('<address> on br0');
    expect(scrubAddresses('ixgbe 0000:18:00.1: a4:bf:01:2e:ac:ea')).toBe('ixgbe 0000:18:00.1: <address>');
    expect(scrubAddresses('at 12:33:14')).toBe('at 12:33:14');
  });
});

describe('buildPassthroughReport', () => {
  it('carries no VM names or host addresses', () => {
    const vm = { uuid: 'fe2b519b-363d-40b4-847d-4f78a1751aaf', name: 'payroll-db', running: true };
    const inv = buildInventory({ facts, assignments: { pci: new Map([['0000:3b:00.0', [vm]]]), usb: new Map() } });
    const report = buildPassthroughReport(inv, facts, '2.15.0');
    expect(report).toContain('VirtPilot 2.15.0 passthrough report');
    expect(report).toContain('0000:3b:00.0 | GPU | NVIDIA Corporation AD104GL [L4] | [10de:27b8]');
    expect(report).toContain('given to VM 1 (running)');
    expect(report).not.toContain('payroll-db');
    expect(report).not.toContain('203.0.113.78');
  });
});
