// Strict input validators for values that flow into shell commands, libvirt,
// iptables, file paths, and similar trust boundaries. Every validator either
// returns the value unchanged or throws — never silently mutates.

const VM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
// RFC 4122 lowercase hyphenated UUID. Used as the storage identity for VMs.
const VM_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NETWORK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const SNAPSHOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const BRIDGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;
const NIC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,15}$/;
const DISK_TARGET_RE = /^(?:hd|sd|vd|xvd)[a-z](?:[a-z0-9]{0,2})?$/;
// libvirt NIC model names are all lowercase (virtio, e1000e, rtl8139, ...).
const NIC_MODEL_RE = /^[a-z0-9-]{1,32}$/;
const MAC_RE = /^[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV4_CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
// Shape only — each port's 1-65535 bound is enforced numerically in
// validatePortRange. A regex that also pins the range is unreadable and easy to
// get subtly wrong.
const PORT_RANGE_RE = /^\d{1,5}(?:[:\-]\d{1,5})?(?:,\d{1,5}(?:[:\-]\d{1,5})?)*$/;
const ICMP_TYPE_RE = /^(\d{1,3})(?:\/\d{1,3})?$/;
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export class ValidationError extends Error {
  constructor(field: string, value: unknown, reason = 'invalid format') {
    super(`Invalid ${field}: ${reason} (got ${JSON.stringify(value)})`);
    this.name = 'ValidationError';
  }
}

function check(re: RegExp, field: string, value: unknown): string {
  if (typeof value !== 'string' || !re.test(value)) throw new ValidationError(field, value);
  return value;
}

export const validateVmName = (v: unknown): string => check(VM_NAME_RE, 'vmName', v);
export const validateVmUuid = (v: unknown): string => {
  if (typeof v !== 'string') throw new ValidationError('vmUuid', v);
  const lower = v.toLowerCase();
  if (!VM_UUID_RE.test(lower)) throw new ValidationError('vmUuid', v);
  return lower;
};
export const validateNetworkName = (v: unknown): string => check(NETWORK_NAME_RE, 'networkName', v);
export const validateSnapshotName = (v: unknown): string => check(SNAPSHOT_NAME_RE, 'snapshotName', v);
export const validateBridgeName = (v: unknown): string => check(BRIDGE_NAME_RE, 'bridgeName', v);
export const validateNicName = (v: unknown): string => check(NIC_NAME_RE, 'nicName', v);
export const validateDiskTarget = (v: unknown): string => check(DISK_TARGET_RE, 'diskTarget', v);
export const validateNicModel = (v: unknown): string => check(NIC_MODEL_RE, 'nicModel', v);
export const validateMac = (v: unknown): string => {
  const s = check(MAC_RE, 'mac', v);
  return s.toLowerCase();
};
export const validateIpv4 = (v: unknown): string => {
  if (typeof v !== 'string') throw new ValidationError('ip', v);
  const m = v.match(IPV4_RE);
  if (!m) throw new ValidationError('ip', v);
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new ValidationError('ip', v, 'octet out of range');
  }
  return v;
};
export const validateIpv4Cidr = (v: unknown): string => {
  if (typeof v !== 'string') throw new ValidationError('cidr', v);
  const m = v.match(IPV4_CIDR_RE);
  if (!m) throw new ValidationError('cidr', v);
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new ValidationError('cidr', v, 'octet out of range');
  }
  const prefix = Number(m[5]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new ValidationError('cidr', v, 'prefix out of range');
  return v;
};
export const validateIpv4OrCidr = (v: unknown): string => {
  if (typeof v !== 'string') throw new ValidationError('ip-or-cidr', v);
  if (IPV4_RE.test(v)) return validateIpv4(v);
  return validateIpv4Cidr(v);
};
export const validatePort = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ValidationError('port', v);
  return n;
};
// Accepts `80`, `80-90`, `80:90` and comma-separated combinations. Ports are
// bounded to 1-65535 because iptables rejects 0 and anything above 65535 — and
// an out-of-range value that only fails inside iptables would do so mid-apply,
// after the live chains had already been touched.
// Deliberately NOT capped on the number of entries: the kernel's multiport
// match tops out at 15, but existing firewall.json files may already hold
// longer lists and must still load. That cap lives at rule-build time, where it
// can produce a clear error before anything is torn down.
export const validatePortRange = (v: unknown): string => {
  const s = check(PORT_RANGE_RE, 'portRange', v);
  for (const part of s.split(',')) {
    const bounds = part.split(/[:\-]/).map(Number);
    for (const n of bounds) {
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new ValidationError('portRange', v, 'port out of range (1-65535)');
      }
    }
    if (bounds.length === 2 && bounds[0] > bounds[1]) {
      throw new ValidationError('portRange', v, 'range start is above its end');
    }
  }
  return s;
};
export const validateIcmpType = (v: unknown): string => check(ICMP_TYPE_RE, 'icmpType', v);
export const validateProtocol = (v: unknown): 'tcp' | 'udp' | 'icmp' | 'all' => {
  if (v === 'tcp' || v === 'udp' || v === 'icmp' || v === 'all') return v;
  throw new ValidationError('protocol', v);
};
export const validateFilename = (v: unknown): string => check(FILENAME_RE, 'filename', v);
export const validatePositiveInt = (v: unknown, max = Number.MAX_SAFE_INTEGER): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new ValidationError('positiveInt', v);
  return n;
};
export const validateNonNegativeInt = (v: unknown, max = Number.MAX_SAFE_INTEGER): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new ValidationError('nonNegativeInt', v);
  return n;
};

// XML-escape a string for safe inclusion as text content or attribute value.
// libvirt parses domain XML strictly; we still escape defensively because user-
// supplied values (VM name, hostname, MAC) flow into the templates we generate.
export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&apos;';
      default: return c;
    }
  });
}

// Reject paths that try to escape a parent dir (../) or are absolute. Used as
// a defence-in-depth check after path.basename() normalisation.
export function ensureWithinDir(parent: string, candidate: string): string {
  const path = require('path') as typeof import('path');
  const resolved = path.resolve(parent, candidate);
  const parentResolved = path.resolve(parent);
  if (resolved !== parentResolved && !resolved.startsWith(parentResolved + path.sep)) {
    throw new ValidationError('path', candidate, 'escapes parent directory');
  }
  return resolved;
}
