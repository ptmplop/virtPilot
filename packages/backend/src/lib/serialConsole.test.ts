import { describe, expect, it } from 'vitest';
import { Backlog, consoleExit, createBannerFilter, stripInput } from './serialConsole';

describe('Backlog', () => {
  it('keeps everything under the cap and counts offsets from the start', () => {
    const b = new Backlog(100);
    b.append(Buffer.from('hello '));
    b.append(Buffer.from('world'));
    expect(b.total).toBe(11);
    expect(b.start).toBe(0);
    expect(b.since(6)?.toString()).toBe('world');
    expect(b.since(11)?.toString()).toBe('');
    expect(b.replay()).toEqual({ from: 0, data: Buffer.from('hello world') });
  });

  it('drops the oldest bytes past the cap, splitting a chunk when it has to', () => {
    const b = new Backlog(8);
    b.append(Buffer.from('abcdef'));
    b.append(Buffer.from('ghij'));
    expect(b.total).toBe(10);
    expect(b.start).toBe(2);
    expect(b.since(2)?.toString()).toBe('cdefghij');
    expect(b.since(1)).toBeNull();
    expect(b.since(11)).toBeNull();
  });

  it('replays from the next line once older output has been dropped', () => {
    const b = new Backlog(12);
    b.append(Buffer.from('line one\nline two\n'));
    const { from, data } = b.replay();
    expect(data.toString()).toBe('line two\n');
    expect(from).toBe(b.total - data.length);
  });

  it('ignores empty appends and refuses fractional offsets', () => {
    const b = new Backlog(10);
    b.append(Buffer.alloc(0));
    expect(b.total).toBe(0);
    b.append(Buffer.from('abc'));
    expect(b.since(1.5)).toBeNull();
  });
});

describe('createBannerFilter', () => {
  const banner = "Connected to domain 'web-01'\r\nEscape character is ^] (Ctrl + ])\r\n";

  it('drops the banner and passes what follows it', () => {
    const f = createBannerFilter();
    expect(f.push(banner + 'login: ')).toBe('login: ');
    expect(f.push('more')).toBe('more');
  });

  it('waits while the banner arrives in pieces', () => {
    const f = createBannerFilter();
    expect(f.push('Connected to dom')).toBe('');
    expect(f.push("ain 'web-01'\r\nEscape char")).toBe('');
    expect(f.push('acter is ^]\r\n')).toBe('');
    expect(f.push('x')).toBe('x');
  });

  it('accepts the older banner without the Ctrl hint', () => {
    const f = createBannerFilter();
    expect(f.push('Connected to domain web-01\nEscape character is ^]\nok')).toBe('ok');
  });

  it('lets anything that is not the banner through at once', () => {
    const f = createBannerFilter();
    expect(f.push('error: The domain is not running\r\n')).toBe('error: The domain is not running\r\n');
    expect(f.push('next')).toBe('next');
  });

  it('gives up when the second line is not the escape line', () => {
    const f = createBannerFilter();
    expect(f.push("Connected to domain 'x'\r\n")).toBe('');
    expect(f.push('something else\r\n')).toBe("Connected to domain 'x'\r\nsomething else\r\n");
  });

  it('flush returns what was held back, once', () => {
    const f = createBannerFilter();
    f.push('Connected to');
    expect(f.flush()).toBe('Connected to');
    expect(f.flush()).toBe('');
    expect(f.push('later')).toBe('later');
  });
});

describe('consoleExit', () => {
  const reason = (code: number, tail: string) => consoleExit(code, tail).reason;

  it('names the cases measured on libvirt', () => {
    expect(consoleExit(1, 'error: The domain is not running\r\n\r\n')).toEqual({ reason: 'The VM is not running', vmDown: true });
    expect(consoleExit(1, 'output\r\nerror: stream had I/O failure\r\n\r\n')).toEqual({ reason: 'Another console session took over', vmDown: false });
    expect(reason(1, "error: failed to get domain 'x'\r\n")).toBe('The VM no longer exists');
    expect(consoleExit(0, '\r\n')).toEqual({ reason: 'The VM stopped', vmDown: true });
    expect(consoleExit(2, '')).toEqual({ reason: 'The console closed', vmDown: false });
  });

  it('passes another error on as a sentence, capped for a close frame', () => {
    expect(reason(1, 'error: internal error: oops.\r\n')).toBe('Internal error: oops');
    const long = reason(1, `error: ${'x'.repeat(300)}`);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(120);
  });

  it('ignores the guest\'s own error lines', () => {
    expect(consoleExit(0, 'ACPI Error: AE_NOT_FOUND\r\nEXT4-fs error: bad block\r\n')).toEqual({ reason: 'The VM stopped', vmDown: true });
    expect(reason(1, 'GRUB: error: no such partition\r\n')).toBe('The console closed');
  });

  it('uses the last error printed', () => {
    expect(reason(1, 'error: first\r\nerror: stream had I/O failure\r\n')).toBe('Another console session took over');
  });
});

describe('stripInput', () => {
  it('removes the escape character and nothing else', () => {
    expect(stripInput(Buffer.from([0x61, 0x1d, 0x62])).toString()).toBe('ab');
    const plain = Buffer.from('ls -la\r');
    expect(stripInput(plain)).toBe(plain);
  });
});
