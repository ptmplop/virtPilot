import { describe, expect, it } from 'vitest';
import { plainDashes } from './plainDashes.js';

describe('plainDashes', () => {
  it('turns a dash between words into a spaced hyphen', () => {
    expect(plainDashes('Took a full backup — the guest agent was unavailable.'))
      .toBe('Took a full backup - the guest agent was unavailable.');
    expect(plainDashes('libvirt—unreachable')).toBe('libvirt - unreachable');
    expect(plainDashes('a – b')).toBe('a - b');
  });

  it('writes a number range with a plain hyphen', () => {
    expect(plainDashes('Day of month (1–28)')).toBe('Day of month (1-28)');
    expect(plainDashes('steps 2 – 4')).toBe('steps 2-4');
  });

  it('adds no space at the start or end of the text or of a line', () => {
    expect(plainDashes('— first')).toBe('- first');
    expect(plainDashes('last —')).toBe('last -');
    expect(plainDashes('one —\ntwo')).toBe('one -\ntwo');
  });

  it('leaves text without long dashes untouched', () => {
    const s = 'web-01 · 2 disk(s), method=libvirt-backup';
    expect(plainDashes(s)).toBe(s);
  });

  it('makes an old note match the prefix new code looks for', () => {
    expect(plainDashes('Took a full backup — no checkpoint.').startsWith('Took a full backup -')).toBe(true);
  });
});
