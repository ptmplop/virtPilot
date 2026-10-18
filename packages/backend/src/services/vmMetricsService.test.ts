import { describe, it, expect } from 'vitest';
import { guestMemory } from './vmMetricsService.js';

const stats = (o: Record<string, number>) => new Map(Object.entries(o));

describe('guestMemory', () => {
  it("uses the guest's own figures when its balloon driver reports them", () => {
    const m = guestMemory(stats({
      'balloon.maximum': 2097152, 'balloon.current': 2097152,
      'balloon.available': 2014000, 'balloon.unused': 1500000, 'balloon.rss': 900000,
    }));
    expect(m.source).toBe('guest');
    expect(m.totalMb).toBe(Math.round(2014000 / 1024));
    expect(m.usedMb).toBe(Math.round((2014000 - 1500000) / 1024));
  });

  it('falls back to the resident size on the host, not the allocation, when the guest is silent', () => {
    // A guest with no balloon stats used to read as allocation/allocation = 100%.
    const m = guestMemory(stats({ 'balloon.maximum': 1048576, 'balloon.current': 1048576, 'balloon.rss': 113784 }));
    expect(m.source).toBe('host');
    expect(m.totalMb).toBe(1024);
    expect(m.usedMb).toBe(111);
  });

  it('never reports more than the allocation (QEMU overhead pushes rss past it)', () => {
    const m = guestMemory(stats({ 'balloon.maximum': 1048576, 'balloon.current': 1048576, 'balloon.rss': 1200000 }));
    expect(m.usedMb).toBe(1024);
  });

  it('caps at a ballooned-down size, and keeps the old figure when even rss is missing', () => {
    expect(guestMemory(stats({ 'balloon.maximum': 2097152, 'balloon.current': 1048576, 'balloon.rss': 1500000 })).usedMb).toBe(1024);
    expect(guestMemory(stats({ 'balloon.maximum': 1048576, 'balloon.current': 1048576 })).usedMb).toBe(1024);
  });
});
