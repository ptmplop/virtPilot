import { describe, it, expect } from 'vitest';
import { buildVirshBatch, isBatchWord, splitVirshBatch } from './virshBatch.js';

describe('buildVirshBatch', () => {
  it('puts a marker before each command and one at the end', () => {
    expect(buildVirshBatch([['domiflist', 'web-01'], ['domiflist', 'web-01', '--inactive']], '@@m'))
      .toBe('echo @@m:0 ; domiflist web-01 ; echo @@m:1 ; domiflist web-01 --inactive ; echo @@m:end');
  });

  it.each(['a b', 'a;b', 'a"b', "a'b", 'a\\b', 'a\nb', 'a#b', 'a|b', '$(x)', '`x`', ''])('refuses %j, which virsh would split again', (arg) => {
    expect(isBatchWord(arg)).toBe(false);
    expect(() => buildVirshBatch([['dominfo', arg]], '@@m')).toThrow('Refusing');
  });

  it('takes what a VM name, a UUID and a flag look like', () => {
    for (const arg of ['web_01.example-2', '061280f2-abab-454b-b016-b02d42778de2', '--inactive', 'virtpilot-8f11200d']) {
      expect(isBatchWord(arg)).toBe(true);
    }
  });
});

describe('splitVirshBatch', () => {
  it('gives each command its own answer', () => {
    expect(splitVirshBatch('@@m:0\none\n\n@@m:1\ntwo\nmore\n\n@@m:end', '@@m', 2)).toEqual(['one', 'two\nmore']);
  });

  it('says null for a command that failed, and carries on past it', () => {
    expect(splitVirshBatch('@@m:0\n\n@@m:1\ntwo\n@@m:end', '@@m', 2)).toEqual([null, 'two']);
  });

  it('says null for a failed last command too, whose status alone would fail the whole batch', () => {
    expect(splitVirshBatch('@@m:0\none\n@@m:1\n@@m:end', '@@m', 2)).toEqual(['one', null]);
  });

  it('keeps what a virsh killed part of the way through had finished, and not the table it was printing', () => {
    expect(splitVirshBatch('@@m:0\none\n@@m:1\n Interface\n------\n vnet0', '@@m', 3)).toEqual(['one', null, null]);
    expect(splitVirshBatch('', '@@m', 2)).toEqual([null, null]);
  });

  it('is not fooled by output that only resembles a marker', () => {
    expect(splitVirshBatch('@@m:0\n <description>@@m:9</description>\n@@other:1\n@@m:end', '@@m', 1))
      .toEqual(['<description>@@m:9</description>\n@@other:1']);
  });
});
