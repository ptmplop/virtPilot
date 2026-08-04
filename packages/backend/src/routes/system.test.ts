import { describe, it, expect } from 'vitest';
import { isUnitRunningState } from './system.js';

// The upgrade endpoint polls the transient unit to decide when the upgrade has
// finished. It used to ask `systemctl is-active` and treat a non-zero exit as
// "finished" — but that command exits 3 for anything other than exactly
// `active`, and a Type=oneshot unit is `activating` for its whole run. The
// poller therefore declared success on its first tick, killed the log stream
// mid-`npm ci`, and reported ExecMainStatus (still 0, nothing had exited).
describe('isUnitRunningState', () => {
  it('treats a running oneshot unit as running', () => {
    // Measured: `systemctl is-active` prints this and exits 3 for the entire
    // execution of a Type=oneshot unit.
    expect(isUnitRunningState('activating')).toBe(true);
  });

  it.each(['active', 'deactivating', 'reloading'])('treats %s as running', (state) => {
    expect(isUnitRunningState(state)).toBe(true);
  });

  it.each(['inactive', 'failed'])('treats %s as finished', (state) => {
    expect(isUnitRunningState(state)).toBe(false);
  });

  it('tolerates the trailing newline systemctl show emits', () => {
    expect(isUnitRunningState('activating\n')).toBe(true);
    expect(isUnitRunningState('inactive\n')).toBe(false);
  });

  it('does not treat unknown output as running', () => {
    // Better to end the stream than to hang forever on a state we cannot read.
    expect(isUnitRunningState('')).toBe(false);
    expect(isUnitRunningState('Failed to get property')).toBe(false);
  });
});
