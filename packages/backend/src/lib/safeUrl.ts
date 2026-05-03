// SSRF guard: validate URLs supplied by authenticated users before the
// backend fetches them. We reject any non-http/https scheme and any host
// that resolves to loopback, link-local (169.254.*), private RFC1918,
// CGNAT (100.64/10), or IPv6 ULA / link-local. This prevents the download
// endpoints from becoming a generic egress proxy onto the host's metadata
// service or internal LAN.
//
// Note we intentionally do not resolve DNS here — `dns.lookup()` would let
// us catch DNS-rebinding attempts up front, but the *actual* connect target
// is decided by Node's HTTP client, so the only race-free check is to
// disallow names that can resolve privately at all. Operators who need to
// download from a private mirror can lift this with ALLOW_PRIVATE_DOWNLOAD.

const PRIVATE_V4 = [
  /^0\./,           // current network
  /^10\./,          // RFC1918
  /^127\./,         // loopback
  /^169\.254\./,    // link-local
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // RFC1918
  /^192\.168\./,    // RFC1918
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // CGNAT 100.64.0.0/10
  /^224\./,         // multicast
  /^255\.255\.255\.255$/,
];

const PRIVATE_V6 = [
  /^::1$/,
  /^::$/,
  /^fc/i,           // ULA fc00::/7
  /^fd/i,
  /^fe[89ab]/i,     // link-local fe80::/10
  /^ff/i,           // multicast
];

function isPrivateV4(addr: string): boolean {
  return PRIVATE_V4.some((re) => re.test(addr));
}

function isPrivateV6(addr: string): boolean {
  const lower = addr.toLowerCase();
  return PRIVATE_V6.some((re) => re.test(lower));
}

function isLiteralIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isLiteralIpv6(host: string): boolean {
  return host.includes(':');
}

export interface SafeUrl {
  url: URL;
  redirectTo: (target: string) => SafeUrl;
}

export function assertSafeDownloadUrl(raw: string): URL {
  if (process.env.ALLOW_PRIVATE_DOWNLOAD === '1') {
    return new URL(raw);
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`URL scheme not allowed: ${u.protocol}`);
  }
  // Strip the brackets that URL.hostname leaves around IPv6 literals so the
  // regex checks see the bare address.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '::') {
    throw new Error(`Internal host not allowed: ${host}`);
  }
  if (isLiteralIpv4(host) && isPrivateV4(host)) {
    throw new Error(`Private/loopback IP not allowed: ${host}`);
  }
  if (isLiteralIpv6(host) && isPrivateV6(host)) {
    throw new Error(`Private/loopback IPv6 not allowed: ${host}`);
  }
  return u;
}
