import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

// Read version from this package's package.json so it stays in lock-step
// with the version-bump checklist (no manual update needed here).
function readVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export const VERSION = readVersion();

const storageRoot = process.env.STORAGE_ROOT ?? '/var/lib/virtpilot';

// Fail fast on insecure / unset secrets — refuse to boot rather than serving
// a forged-token-friendly default.
function requireSecret(name: string, value: string | undefined, minLen: number, badDefaults: string[] = []): string {
  if (!value || value.length < minLen) {
    throw new Error(
      `${name} env var must be set and at least ${minLen} characters. ` +
      `Run install.sh or rotate via: openssl rand -hex 32`,
    );
  }
  if (badDefaults.includes(value)) {
    throw new Error(`${name} is set to a known-default value — refusing to start. Generate a fresh secret.`);
  }
  return value;
}

const isProd = process.env.NODE_ENV === 'production';
const inUnitTest = process.env.NODE_ENV === 'test';

// JWT secret — required in prod, dev tolerates a freshly-generated ephemeral
// secret so first-time `npx tsx src/index.ts` invocations work without a .env.
let jwtSecret: string;
if (isProd) {
  jwtSecret = requireSecret('JWT_SECRET', process.env.JWT_SECRET, 32, ['change-me-in-production']);
} else if (process.env.JWT_SECRET) {
  jwtSecret = process.env.JWT_SECRET;
} else if (inUnitTest) {
  jwtSecret = 'test-secret-not-for-production';
} else {
  // dev fallback: emit a per-process random secret. Not stable across restarts,
  // which means dev sessions are invalidated on reload — that's a desirable
  // signal that JWT_SECRET should be set in .env.
  jwtSecret = require('crypto').randomBytes(32).toString('hex');
  console.warn('[config] JWT_SECRET not set — generated an ephemeral secret. Set JWT_SECRET in .env for stable sessions.');
}

// Auth — accept hashed (preferred) or plaintext (legacy). The auth route
// migrates plaintext to hashed on first successful login.
const authPasswordHash = process.env.AUTH_PASSWORD_HASH ?? '';
const authPasswordLegacy = process.env.AUTH_PASSWORD ?? '';
if (isProd && !authPasswordHash && !authPasswordLegacy) {
  throw new Error('AUTH_PASSWORD_HASH (preferred) or AUTH_PASSWORD must be set in .env');
}
if (isProd && !authPasswordHash && authPasswordLegacy.length < 8) {
  throw new Error('AUTH_PASSWORD is shorter than 8 characters — refusing to start');
}

// Encryption key for at-rest secrets (TOTP, VM passwords). Optional: defaults
// to a value derived from JWT_SECRET when missing, so existing installs don't
// break. install.sh writes a dedicated key going forward.
const encryptionKey = process.env.ENCRYPTION_KEY ?? '';

// Comma-separated list of permitted browser origins for CORS. Empty = same-
// origin only (the most common deployment when the SPA is served by the
// backend itself).
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Bind address — default to 0.0.0.0 ONLY if the operator opts in via
// BIND_ADDRESS. We default to 127.0.0.1 so a public-IP install fronted by a
// reverse proxy is the default rather than the exception.
const bindAddress = process.env.BIND_ADDRESS ?? '127.0.0.1';

export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  bindAddress,
  storageRoot,
  templatesDir: process.env.TEMPLATES_DIR ?? path.join(storageRoot, 'templates'),
  isosDir: process.env.ISOS_DIR ?? path.join(storageRoot, 'isos'),
  vmsDir: process.env.VMS_DIR ?? path.join(storageRoot, 'vms'),
  cloudInitDir: process.env.CLOUD_INIT_DIR ?? path.join(storageRoot, 'cloud-init'),
  backupRoot: process.env.BACKUP_ROOT ?? path.join(storageRoot, 'backups'),
  defaultBridge: process.env.DEFAULT_BRIDGE ?? 'br0',
  libvirtUri: process.env.LIBVIRT_URI ?? 'qemu:///system',
  // Repo root for the self-upgrade flow. Falls back to process.cwd() so dev
  // workflows (where the systemd unit isn't running) still work.
  repoDir: process.env.VIRTPILOT_REPO_DIR ?? process.cwd(),
  authPasswordHash,
  authPasswordLegacy,
  jwtSecret,
  encryptionKey,
  allowedOrigins,
  tlsCertPath: process.env.TLS_CERT_PATH ?? path.join(storageRoot, 'tls', 'cert.pem'),
  tlsKeyPath: process.env.TLS_KEY_PATH ?? path.join(storageRoot, 'tls', 'key.pem'),
  // Dotted env file path so the auth route can rewrite the hash after a
  // successful legacy-plaintext login.
  envFilePath: path.resolve(__dirname, '..', '.env'),
};
