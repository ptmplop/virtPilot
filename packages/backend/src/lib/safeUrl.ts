// SSRF guard: validate URLs supplied by authenticated users before the
// backend fetches them. We reject any non-http/https scheme and any host
// that resolves to loopback, link-local (169.254.*), private RFC1918,
// CGNAT (100.64/10), or IPv6 ULA / link-local. This prevents the download
// endpoints from becoming a generic egress proxy onto the host's metadata
// service or internal LAN.
//
// Two things make this more than a string check. First, classification works
// off an allowlist of global unicast rather than a blacklist of prefixes —
// a blacklist misses IPv4-mapped forms (`http://[::ffff:169.254.169.254]/`
// normalises to `::ffff:a9fe:a9fe`, which matches no v6 prefix pattern).
// Second, we resolve the hostname ourselves and check *every* answer, so a
// `nip.io`-style name pointing at 169.254.169.254 can't sail through.
//
// Resolving still leaves a DNS-rebinding window between our check and the
// client's own lookup, so we hand the caller a `lookup` function pinned to
// the addresses we validated and it passes that to http.get — the connect then
// cannot land anywhere else. Because the connect is pinned, we *filter* the
// answers rather than refusing the host outright when one answer is private:
// an unvetted address is simply never offered to the socket, so a mixed
// public/internal round-robin is still unreachable, while a host whose result
// set happens to contain one address we can't classify remains downloadable.
// Operators who need to download from a private mirror can lift the whole
// check with ALLOW_PRIVATE_DOWNLOAD=1.

import dns from 'dns';
import type { LookupAddress, LookupOptions } from 'dns';
import type { LookupFunction } from 'net';

export interface SafeDownloadTarget {
  url: URL;
  // Pass to http.get/https.get as the `lookup` option so the socket connects
  // to the address we vetted rather than a fresh (rebindable) resolution.
  // Undefined only when ALLOW_PRIVATE_DOWNLOAD is on — there's nothing to pin.
  lookup?: LookupFunction;
}

// Expand any IPv6 text form to its eight 16-bit groups. Returns null if the
// input isn't a well-formed v6 literal.
function expandV6(addr: string): number[] | null {
  // Drop any zone id ("fe80::1%eth0") before parsing.
  let s = addr.split('%')[0];
  // A trailing dotted quad ("::ffff:1.2.3.4") is legal v6 text — fold it into
  // two hex groups so the rest of the parse only deals with hex.
  const v4Tail = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Tail) {
    const octets = v4Tail[1].split('.').map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    s = `${s.slice(0, s.length - v4Tail[1].length)}${hi}:${lo}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let parts: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    parts = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    parts = [...head, ...Array<string>(fill).fill('0'), ...tail];
  }
  const groups: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(p)) return null;
    groups.push(parseInt(p, 16));
  }
  return groups;
}

// Return the dotted-quad an address really points at: the address itself for a
// v4 literal, or the embedded v4 for IPv4-mapped (::ffff:a.b.c.d),
// IPv4-compatible (::a.b.c.d) and NAT64-translated (64:ff9b::a.b.c.d) v6
// forms. Null means "genuinely IPv6".
function toIpv4(addr: string): string | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return addr;
  const g = expandV6(addr);
  if (!g) return null;
  const zeroPrefix = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  const mapped = zeroPrefix && g[5] === 0xffff;
  const compatible = zeroPrefix && g[5] === 0;
  // On an IPv6-only network behind DNS64 every A record arrives synthesised
  // into the NAT64 well-known prefix 64:ff9b::/96, so it has to be judged by
  // the IPv4 it actually reaches or such a network can download nothing at
  // all. Its first two groups are non-zero, so `zeroPrefix` can't cover it.
  // Deliberately NOT extended to the RFC 8215 local-use prefix 64:ff9b:1::/48:
  // that one is operator-chosen and stays refused.
  const nat64 =
    g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
  // ::1 and :: are handled by the v6 allowlist, not here.
  if (!mapped && !nat64 && !(compatible && (g[6] !== 0 || g[7] > 1))) return null;
  return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
}

// Allowlist: only routable, globally reachable unicast v4 passes. Everything
// else — this-network, RFC1918, loopback, link-local, CGNAT, the IETF test
// ranges, multicast and the reserved class E space — is refused.
function isGlobalUnicastV4(addr: string): boolean {
  const o = addr.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = o;
  if (a < 1 || a > 223) return false;              // this-network, multicast, class E
  if (a === 10 || a === 127) return false;         // RFC1918, loopback
  if (a === 169 && b === 254) return false;        // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64.0.0/10
  return true;
}

// Allowlist: 2000::/3 is the only currently assigned global unicast range, so
// requiring it rejects ::1, ::, ULA (fc00::/7), link-local (fe80::/10) and
// multicast (ff00::/8) without enumerating them.
function isGlobalUnicastV6(addr: string): boolean {
  const g = expandV6(addr);
  if (!g) return false;
  return (g[0] & 0xe000) === 0x2000;
}

function isPublicAddress(addr: string): boolean {
  const v4 = toIpv4(addr);
  if (v4) return isGlobalUnicastV4(v4);
  return isGlobalUnicastV6(addr);
}

// Hand back every vetted address, not just the first. Node asks with
// `all: true` when it runs Happy Eyeballs / autoSelectFamily, and pinning to a
// single answer would strip the dual-stack failover that a plain lookup gives
// — a multi-A host whose first address is unreachable would fail outright.
// Security is unaffected: the socket still only ever sees addresses we vetted.
function pinnedLookup(pinned: LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (options && (options as LookupOptions).all) {
      callback(
        null,
        pinned.map((a) => ({ address: a.address, family: a.family })),
      );
    } else {
      callback(null, pinned[0].address, pinned[0].family);
    }
  };
}

export async function assertSafeDownloadUrl(raw: string): Promise<SafeDownloadTarget> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (process.env.ALLOW_PRIVATE_DOWNLOAD === '1') {
    return { url: u };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`URL scheme not allowed: ${u.protocol}`);
  }
  // Strip the brackets that URL.hostname leaves around IPv6 literals so the
  // address checks see the bare address.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.toLowerCase().endsWith('.localhost')) {
    throw new Error(`Internal host not allowed: ${host}`);
  }

  let answers: LookupAddress[];
  try {
    // ADDRCONFIG mirrors the flags net.js uses for its own connect-time lookup,
    // so we vet exactly the candidate set the socket would otherwise have got.
    answers = await dns.promises.lookup(host, { all: true, hints: dns.ADDRCONFIG });
  } catch {
    throw new Error(`Could not resolve host: ${host}`);
  }
  if (answers.length === 0) throw new Error(`Could not resolve host: ${host}`);
  // Drop any answer that isn't global unicast and pin the connect to what's
  // left. A name that round-robins between a public and an internal address is
  // still unable to reach the internal one, because the socket is never offered
  // it — but one unclassifiable answer no longer kills the whole download.
  const vetted = answers.filter((a) => isPublicAddress(a.address));
  if (!vetted.length) {
    throw new Error(
      `Private/loopback address not allowed: ${answers.map((a) => a.address).join(', ')}`,
    );
  }

  return { url: u, lookup: pinnedLookup(vetted) };
}
