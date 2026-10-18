import { useState, useEffect, useRef } from 'react';
import { Save, Plus, X, ShieldCheck, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { Layout } from '@/components/layout/Layout';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Dialog } from '@/components/ui/Dialog';
import { useSettings } from '@/hooks/useSettings';
import { api } from '@/lib/api';
import type { Settings, BackupSettings } from '@/types';

type TotpSetupState = 'idle' | 'setup';

// Whether an allowlist entry (an address, or an IPv4 CIDR range) covers an address —
// so the page offers to add yours only when the list doesn't already let you in.
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!/^\d{1,3}$/.test(p) || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function entryCovers(entry: string, ip: string): boolean {
  if (entry === ip) return true;
  const [net, bitsText] = entry.split('/');
  if (bitsText === undefined) return false;
  const a = ipv4ToInt(net);
  const b = ipv4ToInt(ip);
  const bits = Number(bitsText);
  if (a === null || b === null || !(bits >= 0 && bits <= 32)) return false;
  const size = 2 ** (32 - bits);
  return Math.floor(a / size) === Math.floor(b / size);
}

function apiError(err: unknown): string | undefined {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
}

export function SettingsPage() {
  const { data: settings, isLoading } = useSettings();
  const queryClient = useQueryClient();

  const [maxLogs, setMaxLogs] = useState<string>('');
  useEffect(() => {
    if (settings?.maxLogs != null) setMaxLogs(String(settings.maxLogs));
  }, [settings?.maxLogs]);

  const [ipWhitelist, setIpWhitelist] = useState<string[]>([]);
  const [newIp, setNewIp] = useState('');
  const [ipError, setIpError] = useState<string | null>(null);
  const rawWhitelist = settings?.ipWhitelist;
  useEffect(() => {
    setIpWhitelist(rawWhitelist ?? []);
  }, [rawWhitelist]);

  const saveSettings = useMutation({
    mutationFn: async (values: { maxLogs: number }) => {
      const { data } = await api.put<{ settings: Settings }>('/api/settings', values);
      return data.settings;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['settings'], (prev: typeof settings) => prev ? { ...prev, ...updated } : prev);
      toast.success('Settings saved');
    },
    onError: () => toast.error('Failed to save settings'),
  });

  const saveIpWhitelist = useMutation({
    mutationFn: async (whitelist: string[]) => {
      const { data } = await api.put<{ settings: Settings }>('/api/settings', { ipWhitelist: whitelist });
      return data.settings;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['settings'], (prev: typeof settings) => prev ? { ...prev, ...updated } : prev);
      toast.success('IP whitelist saved');
    },
    // The server refuses a list that would shut you out, and says which address it saw.
    onError: (err) => toast.error(apiError(err) ?? 'Failed to save IP whitelist'),
  });

  function handleSaveMaxLogs() {
    const n = parseInt(maxLogs, 10);
    if (isNaN(n) || n < 10 || n > 10_000) {
      toast.error('Max logs must be between 10 and 10,000');
      return;
    }
    saveSettings.mutate({ maxLogs: n });
  }

  function isValidIpEntry(value: string): boolean {
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return true;
    if (/^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/.test(value)) return true;
    if (value.includes(':') && /^[0-9a-fA-F:]{2,}$/.test(value)) return true;
    return false;
  }

  function handleAddIp() {
    const value = newIp.trim();
    if (!value) return;
    if (!isValidIpEntry(value)) {
      setIpError('Invalid IP address or CIDR range');
      return;
    }
    if (ipWhitelist.includes(value)) {
      setIpError('Already in the list');
      return;
    }
    setIpWhitelist(prev => [...prev, value]);
    setNewIp('');
    setIpError(null);
  }

  // 2FA state
  const [totpSetupState, setTotpSetupState] = useState<TotpSetupState>('idle');
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpConfirmCode, setTotpConfirmCode] = useState('');
  const totpConfirmRef = useRef<HTMLInputElement>(null);

  const setup2fa = useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{ secret: string; qrCodeDataUrl: string }>('/api/2fa/setup');
      return data;
    },
    onSuccess: (data) => {
      setQrCodeDataUrl(data.qrCodeDataUrl);
      setTotpSecret(data.secret);
      setTotpSetupState('setup');
      setTimeout(() => totpConfirmRef.current?.focus(), 50);
    },
    onError: () => toast.error('Failed to start 2FA setup'),
  });

  const enable2fa = useMutation({
    mutationFn: async (code: string) => {
      await api.post('/api/2fa/enable', { code });
    },
    onSuccess: () => {
      queryClient.setQueryData(['settings'], (prev: typeof settings) =>
        prev ? { ...prev, totpEnabled: true } : prev,
      );
      setTotpSetupState('idle');
      setTotpConfirmCode('');
      setQrCodeDataUrl('');
      setTotpSecret('');
      toast.success('Two-factor authentication enabled');
    },
    onError: () => toast.error('Invalid code — please try again'),
  });

  // Removing 2FA clears the secret (the authenticator must be enrolled again), so it asks first.
  const [removeTotpOpen, setRemoveTotpOpen] = useState(false);
  const disable2fa = useMutation({
    mutationFn: async () => {
      await api.delete('/api/2fa');
    },
    onSuccess: () => {
      queryClient.setQueryData(['settings'], (prev: typeof settings) =>
        prev ? { ...prev, totpEnabled: false } : prev,
      );
      setRemoveTotpOpen(false);
      toast.success('Two-factor authentication removed');
    },
    onError: () => toast.error('Failed to remove 2FA'),
  });

  // Backup settings
  const [backupRetentionDays, setBackupRetentionDays] = useState<string>('');
  const [backupCompression, setBackupCompression] = useState(false);
  useEffect(() => {
    if (settings?.backup != null) {
      setBackupRetentionDays(String(settings.backup.retentionDays));
      setBackupCompression(settings.backup.compression);
    }
  }, [settings?.backup]);

  const saveBackupSettings = useMutation({
    mutationFn: async (backup: BackupSettings) => {
      const { data } = await api.put<{ settings: Settings }>('/api/settings', { backup });
      return data.settings;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['settings'], (prev: typeof settings) => prev ? { ...prev, ...updated } : prev);
      toast.success('Backup settings saved');
    },
    onError: () => toast.error('Failed to save backup settings'),
  });

  function handleSaveBackup() {
    const n = parseInt(backupRetentionDays, 10);
    if (isNaN(n) || n < 0) {
      toast.error('Retention days must be 0 or more (0 = keep forever)');
      return;
    }
    saveBackupSettings.mutate({ retentionDays: n, compression: backupCompression });
  }

  // A section's Save is live only when its fields differ from what is saved, and is
  // the ink action only then — at rest the page has nothing pending to commit.
  // Numbers, not the text typed: "0500" saves as 500 and must not stay "unsaved" after.
  const logsDirty = settings?.maxLogs != null && parseInt(maxLogs, 10) !== settings.maxLogs;
  const backupDirty = settings?.backup != null
    && (parseInt(backupRetentionDays, 10) !== settings.backup.retentionDays || backupCompression !== settings.backup.compression);
  const ipDirty = JSON.stringify(ipWhitelist) !== JSON.stringify(rawWhitelist ?? []);
  const clientIp = settings?.clientIp;
  const clientCovered = !!clientIp && ipWhitelist.some((e) => entryCovers(e, clientIp));

  const configRows: [string, string][] = settings ? [
    ['Storage root',        settings.storageRoot],
    ['Templates directory', settings.templatesDir],
    ['ISOs directory',      settings.isosDir],
    ['VMs directory',       settings.vmsDir],
    ['Backup root',         settings.backupRoot],
    ['Default bridge',      settings.defaultBridge],
    ['Libvirt URI',         settings.libvirtUri],
  ] : [];

  return (
    <Layout title="Settings" subtitle="Host configuration, log retention and access control.">
      <div className="space-y-8">

      {/* Host configuration */}
      <section className="space-y-3">
        <div>
          <SectionHeading label="Host configuration" />
          <p className="mt-2 text-xs text-muted-foreground">
            Read-only. Set via environment variables in the backend{' '}
            <span className="font-mono">.env</span> file.
          </p>
        </div>
        <div className="panel overflow-hidden">
          {isLoading ? (
            <div className="space-y-px p-4">
              {[1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-10 rounded-lg" />)}
            </div>
          ) : (
            <dl className="divide-y divide-border">
              {configRows.map(([label, value]) => (
                <div key={label} className="flex flex-col gap-1 px-5 py-3 transition-colors hover:bg-muted/20 sm:flex-row sm:items-baseline sm:gap-4">
                  <dt className="text-[12px] font-medium text-muted-foreground sm:w-44 sm:shrink-0">{label}</dt>
                  <dd className="min-w-0 truncate font-mono text-xs text-foreground" title={value}>{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>Point <span className="font-mono">BACKUP_ROOT</span> at a mount point for a second disk or NAS share (NFS, SMB, iSCSI) to keep backups off the primary storage pool.</p>
          <p>e.g. <span className="font-mono">/mnt/backups</span> — add it to <span className="font-mono">/etc/fstab</span> before starting VirtPilot.</p>
        </div>
      </section>

      {/* Log retention */}
      <section className="space-y-3">
        <div>
          <SectionHeading label="Log retention" />
          <p className="mt-2 text-xs text-muted-foreground">
            Maximum number of log entries to keep. Oldest entries are pruned automatically. Range: 10 – 10,000.
          </p>
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-card px-5 py-4">
          {isLoading ? (
            <Skeleton className="h-10 w-48 rounded-lg" />
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-48">
                <Input
                  label="Max log entries"
                  type="number"
                  min={10}
                  max={10000}
                  value={maxLogs}
                  onChange={(e) => setMaxLogs(e.target.value)}
                />
              </div>
              <Button
                variant={logsDirty ? 'primary' : 'secondary'}
                onClick={handleSaveMaxLogs}
                disabled={!logsDirty || saveSettings.isPending}
              >
                <Save className="h-3.5 w-3.5" />
                Save
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* Backup settings */}
      <section className="space-y-3">
        <div>
          <SectionHeading label="Backups" />
          <p className="mt-2 text-xs text-muted-foreground">
            Global defaults for all VM backups. Individual schedules can override the retention period.
            Set retention to <span className="font-mono">0</span> to keep backups forever.
          </p>
        </div>
        <div className="overflow-hidden rounded-xl border border-border bg-card px-5 py-4">
          {isLoading ? (
            <Skeleton className="h-10 rounded-lg" />
          ) : (
            <div className="flex flex-wrap items-end gap-4">
              <div className="w-48">
                <Input
                  label="Default retention (days)"
                  type="number"
                  min={0}
                  placeholder="7"
                  value={backupRetentionDays}
                  onChange={(e) => setBackupRetentionDays(e.target.value)}
                />
              </div>
              <label className="flex min-h-9 cursor-pointer flex-wrap items-center gap-x-2 text-[13.5px]">
                <input
                  type="checkbox"
                  checked={backupCompression}
                  onChange={(e) => setBackupCompression(e.target.checked)}
                  className="accent-primary"
                />
                <span className="text-foreground">Compress backups</span>
                <span className="text-[12.5px] text-muted-foreground">smaller files, slower to make</span>
              </label>
              <Button
                variant={backupDirty ? 'primary' : 'secondary'}
                onClick={handleSaveBackup}
                disabled={!backupDirty || saveBackupSettings.isPending}
              >
                <Save className="h-3.5 w-3.5" />
                Save
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* IP Access Control */}
      <section className="space-y-3">
        <div>
          <SectionHeading label="IP access control" />
          <p className="mt-2 text-xs text-muted-foreground">
            Restrict login and API access to specific IP addresses or CIDR ranges (e.g.{' '}
            <span className="font-mono">203.0.113.1</span> or{' '}
            <span className="font-mono">10.0.0.0/8</span>). Leave empty to allow all IPs.
          </p>
        </div>
        <div className="overflow-hidden rounded-xl border border-border bg-card px-5 py-4">
          {isLoading ? (
            <Skeleton className="h-24 rounded-lg" />
          ) : (
            <div className="space-y-3">
              {/* The fact that prevents a lock-out, stated before the list is touched. */}
              {clientIp && (
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <p className="text-[12.5px] text-muted-foreground">
                    You are connecting from{' '}
                    <span className="font-mono text-[12px] text-foreground">{clientIp}</span>
                    {ipWhitelist.length > 0 && (clientCovered ? ', which this list allows.' : ', which this list does not include yet.')}
                  </p>
                  {ipWhitelist.length > 0 && !clientCovered && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => { setIpWhitelist((prev) => [...prev, clientIp]); setIpError(null); }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add this address
                    </Button>
                  )}
                </div>
              )}
              {ipWhitelist.length > 0 ? (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {ipWhitelist.map((entry) => (
                    <li key={entry} className="flex items-center justify-between gap-3 py-1 pl-3 pr-1">
                      <span className="font-mono text-[12px] text-foreground">{entry}</span>
                      <button
                        type="button"
                        onClick={() => setIpWhitelist(prev => prev.filter(e => e !== entry))}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        aria-label={`Remove ${entry}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12.5px] text-muted-foreground">No restrictions: every IP address may sign in.</p>
              )}

              <div className="flex flex-wrap items-end justify-between gap-3 pt-1">
                <div className="flex min-w-0 flex-1 items-end gap-2">
                  <div className="min-w-0 flex-1 sm:w-64 sm:flex-none">
                    <Input
                      label="Add IP or CIDR"
                      type="text"
                      placeholder="e.g. 203.0.113.1 or 10.0.0.0/8"
                      value={newIp}
                      onChange={(e) => { setNewIp(e.target.value); setIpError(null); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddIp(); } }}
                      error={ipError ?? undefined}
                    />
                  </div>
                  <Button variant="secondary" onClick={handleAddIp}>
                    <Plus className="h-3.5 w-3.5" />
                    Add
                  </Button>
                </div>
                <Button
                  variant={ipDirty ? 'primary' : 'secondary'}
                  onClick={() => saveIpWhitelist.mutate(ipWhitelist)}
                  disabled={!ipDirty || saveIpWhitelist.isPending}
                >
                  <Save className="h-3.5 w-3.5" />
                  Save
                </Button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Two-factor authentication */}
      <section className="space-y-3">
        <div>
          <SectionHeading label="Two-factor authentication" />
          <p className="mt-2 text-xs text-muted-foreground">
            Require a time-based one-time code from an authenticator app (Google Authenticator, Authy, etc.) on every login.
          </p>
        </div>
        <div className="overflow-hidden rounded-xl border border-border bg-card px-5 py-4">
          {isLoading ? (
            <Skeleton className="h-10 rounded-lg" />
          ) : settings?.totpEnabled ? (
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <span className="text-sm font-medium text-foreground">2FA is enabled</span>
              </div>
              <Button
                variant="dangerOutline"
                onClick={() => setRemoveTotpOpen(true)}
                disabled={disable2fa.isPending}
              >
                <ShieldOff className="h-3.5 w-3.5" />
                Remove 2FA
              </Button>
            </div>
          ) : totpSetupState === 'idle' ? (
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <ShieldOff className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">2FA is not enabled</span>
              </div>
              <Button
                onClick={() => setup2fa.mutate()}
                disabled={setup2fa.isPending}
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                Set up authenticator
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Scan this QR code with your authenticator app, then enter the 6-digit code below to confirm.
              </p>
              <div className="flex gap-6">
                {qrCodeDataUrl && (
                  <img
                    src={qrCodeDataUrl}
                    alt="2FA QR code"
                    className="h-32 w-32 shrink-0 rounded-lg border border-border bg-white p-1"
                  />
                )}
                <div className="flex flex-col justify-center gap-2 min-w-0">
                  <p className="text-[12px] font-medium text-muted-foreground">Manual entry key</p>
                  <p className="break-all font-mono text-xs text-foreground select-all">{totpSecret}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-40">
                  <Input
                    ref={totpConfirmRef}
                    label="Confirm code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="000000"
                    value={totpConfirmCode}
                    onChange={(e) => setTotpConfirmCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && totpConfirmCode.length === 6) {
                        e.preventDefault();
                        enable2fa.mutate(totpConfirmCode);
                      }
                    }}
                  />
                </div>
                <Button
                  onClick={() => enable2fa.mutate(totpConfirmCode)}
                  disabled={enable2fa.isPending || totpConfirmCode.length !== 6}
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Activate
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => { setTotpSetupState('idle'); setTotpConfirmCode(''); }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </section>

      </div>

      <Dialog
        open={removeTotpOpen}
        onClose={() => setRemoveTotpOpen(false)}
        title="Remove two-factor authentication?"
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setRemoveTotpOpen(false)} disabled={disable2fa.isPending}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={() => disable2fa.mutate()} disabled={disable2fa.isPending}>
              {disable2fa.isPending ? 'Removing…' : 'Remove 2FA'}
            </Button>
          </>
        }
      >
        <p className="text-[13.5px] leading-6 text-muted-foreground">
          Signing in will need only the password. The authenticator's secret is deleted, so turning
          2FA back on means scanning a new code.
        </p>
      </Dialog>
    </Layout>
  );
}
