import { describe, expect, it } from 'vitest';
import { sameSshKey } from './sshKeyService.js';

describe('sameSshKey', () => {
  const blob = 'AAAAC3NzaC1lZDI1NTE5AAAAIM7b1sQ9cJt0Rk3a8wq5mM2c6bYpZr1n4x0yQe8tL2Vh';

  it('matches the same type and body whatever the comment says', () => {
    expect(sameSshKey(`ssh-ed25519 ${blob} ops@laptop`, `ssh-ed25519 ${blob} someone-else`)).toBe(true);
    expect(sameSshKey(`ssh-ed25519 ${blob}`, `  ssh-ed25519   ${blob}  `)).toBe(true);
  });

  it('tells different keys apart', () => {
    expect(sameSshKey(`ssh-ed25519 ${blob}`, `ssh-ed25519 ${blob.slice(0, -1)}X`)).toBe(false);
    expect(sameSshKey(`ssh-ed25519 ${blob}`, `ssh-rsa ${blob}`)).toBe(false);
  });

  it('never matches a malformed line', () => {
    expect(sameSshKey('', '')).toBe(false);
    expect(sameSshKey('ssh-ed25519', 'ssh-ed25519')).toBe(false);
  });
});
