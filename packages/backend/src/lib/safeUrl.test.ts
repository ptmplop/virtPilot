import { describe, it, expect, afterEach } from 'vitest';
import { assertSafeDownloadUrl } from './safeUrl.js';

// The download endpoints fetch operator-supplied URLs from inside the host, so
// this guard is what stops them becoming a generic egress proxy onto the cloud
// metadata service or the internal LAN. Every case below uses a literal address
// or is rejected before DNS, so the suite makes no network calls.

afterEach(() => {
  delete process.env.ALLOW_PRIVATE_DOWNLOAD;
});

describe('assertSafeDownloadUrl', () => {
  it.each([
    ['loopback', 'http://127.0.0.1:3002/health'],
    ['loopback (other 127/8)', 'http://127.1.2.3/x'],
    ['link-local / cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['RFC1918 10/8', 'http://10.0.1.1/x'],
    ['RFC1918 192.168/16', 'http://192.168.122.1/x'],
    ['RFC1918 172.16/12', 'http://172.31.1.1/x'],
    ['CGNAT 100.64/10', 'http://100.64.0.1/x'],
    ['IPv6 loopback', 'http://[::1]/x'],
    ['IPv6 link-local', 'http://[fe80::1]/x'],
    ['IPv6 ULA', 'http://[fd00::1]/x'],
    // The blacklist-shaped check this replaced matched none of these.
    ['IPv4-mapped IPv6 metadata', 'http://[::ffff:169.254.169.254]/x'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/x'],
  ])('rejects %s', async (_label, url) => {
    await expect(assertSafeDownloadUrl(url)).rejects.toThrow(/not allowed/i);
  });

  it.each([
    ['file', 'file:///etc/passwd'],
    ['gopher', 'gopher://example.com/'],
    ['ftp', 'ftp://example.com/x.qcow2'],
    ['data', 'data:text/plain,hello'],
  ])('rejects the %s scheme', async (_label, url) => {
    await expect(assertSafeDownloadUrl(url)).rejects.toThrow(/scheme not allowed/i);
  });

  it('rejects localhost by name, before any lookup', async () => {
    await expect(assertSafeDownloadUrl('http://localhost/x')).rejects.toThrow(/Internal host/i);
    await expect(assertSafeDownloadUrl('http://foo.localhost/x')).rejects.toThrow(/Internal host/i);
  });

  it('rejects a malformed URL', async () => {
    await expect(assertSafeDownloadUrl('not a url')).rejects.toThrow(/Invalid URL/i);
  });

  it('accepts a public literal address and pins the connect to it', async () => {
    const target = await assertSafeDownloadUrl('https://1.1.1.1/image.qcow2');
    expect(target.url.hostname).toBe('1.1.1.1');
    // Without the pin, the socket would re-resolve and could land elsewhere.
    expect(typeof target.lookup).toBe('function');
  });

  it('lets an operator opt out entirely for a private mirror', async () => {
    process.env.ALLOW_PRIVATE_DOWNLOAD = '1';
    const target = await assertSafeDownloadUrl('http://10.0.1.1/mirror.qcow2');
    expect(target.url.hostname).toBe('10.0.1.1');
    // Nothing to pin when the check is lifted.
    expect(target.lookup).toBeUndefined();
  });
});
