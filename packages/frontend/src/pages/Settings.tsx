import { useState, useEffect, useRef } from 'react';
import { Save, Plus, X, ShieldCheck, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Layout } from '@/components/layout/Layout';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useSettings } from '@/hooks/useSettings';
import { api } from '@/lib/api';
import type { Settings, BackupSettings } from '@/types';

type TotpSetupState = 'idle' | 'setup';

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
    onError: () => toast.error('Failed to save IP whitelist'),
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

  const disable2fa = useMutation({
    mutationFn: async () => {
      await api.delete('/api/2fa');
    },
    onSuccess: () => {
      queryClient.setQueryData(['settings'], (prev: typeof settings) =>
        prev ? { ...prev, totpEnabled: false } : prev,
      );
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

  const configRows: [string, string][] = settings ? [
    ['Storage Root',        settings.storageRoot],
    ['Templates Directory', settings.templatesDir],
    ['ISOs Directory',      settings.isosDir],
    ['VMs Directory',       settings.vmsDir],
    ['Backup Root',         settings.backupRoot],
    ['Default Bridge',      settings.defaultBridge],
    ['Libvirt URI',         settings.libvirtUri],
  ] : [];

  return (
    <Layout title="Settings" subtitle="Host configuration, log retention, and access control.">
      {/* Host configuration */}
      <section className="mb-5">
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-foreground">Host Configuration</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Read-only. Set via environment variables in the backend{' '}
            <span className="font-mono">.env</span> file.
          </p>
        </div>
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          {isLoading ? (
            <div className="space-y-px p-4">
              {[1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-10 rounded-lg" />)}
            </div>
          ) : (
            <dl className="divide-y divide-border">
              {configRows.map(([label, value]) => (
                <div key={label} className="flex items-baseline gap-4 px-5 py-3 hover:bg-muted/20 transition-colors">
                  <dt className="w-44 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">{label}</dt>
                  <dd className="min-w-0 truncate font-mono text-xs text-foreground" title={value}>{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </section>

      {/* Log retention */}
      <section className="mb-5">
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-foreground">Log Retention</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Maximum number of log entries to keep. Oldest entries are pruned automatically. Range: 10 – 10,000.
          </p>
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-card px-5 py-4 shadow-sm">
          {isLoading ? (
            <Skeleton className="h-10 w-48 rounded-lg" />
          ) : (
            <div className="flex items-end gap-3">
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
                size="sm"
                onClick={handleSaveMaxLogs}
                disabled={saveSettings.isPending}
                className="gap-1.5"
              >
                <Save className="h-3.5 w-3.5" />
                Save
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* Backup settings */}
      <section className="mb-5">
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-foreground">Backups</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Global defaults for all VM backups. Individual schedules can override the retention period.
            Set retention to <span className="font-mono">0</span> to keep backups forever.
          </p>
        </div>
        <div className="overflow-hidden rounded-xl border border-border bg-card px-5 py-4 shadow-sm">
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
              <label className="flex cursor-pointer items-center gap-2 pb-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={backupCompression}
                  onChange={(e) => setBackupCompression(e.target.checked)}
                  className="accent-primary"
                />
                <span className="text-foreground">Compress backups</span>
                <span className="text-xs text-muted-foreground">(smaller files, slower)</span>
              </label>
              <Button
                size="sm"
                onClick={handleSaveBackup}
                disabled={saveBackupSettings.isPending}
                className="gap-1.5"
              >
                <Save className="h-3.5 w-3.5" />
                Save
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* IP Access Control */}
      <section className="mb-5">
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-foreground">IP Access Control</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Restrict login and API access to specific IP addresses or CIDR ranges (e.g.{' '}
            <span className="font-mono">203.0.113.1</span> or{' '}
            <span className="font-mono">10.0.0.0/8</span>). Leave empty to allow all IPs.
          </p>
          <p className="mt-1 text-xs text-amber-500 dark:text-amber-400 font-medium">
            Ensure your own IP is listed before saving, or you will be locked out.
          </p>
        </div>
        <div className="overflow-hidden rounded-xl border border-border bg-card px-5 py-4 shadow-sm">
          {isLoading ? (
            <Skeleton className="h-24 rounded-lg" />
          ) : (
            <div className="space-y-3">
              {ipWhitelist.length > 0 ? (
                <ul className="space-y-1.5">
                  {ipWhitelist.map((entry) => (
                    <li key={entry} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
                      <span className="font-mono text-xs text-foreground">{entry}</span>
                      <button
                        type="button"
                        onClick={() => setIpWhitelist(prev => prev.filter(e => e !== entry))}
                        className="text-muted-foreground hover:text-destructive transition-colors"
                        aria-label={`Remove ${entry}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground italic">No restrictions — all IPs are allowed.</p>
              )}

              <div className="flex items-end justify-between gap-3 pt-1">
                <div className="flex items-end gap-2 min-w-0">
                  <div className="w-64 shrink-0">
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
                  <Button size="sm" variant="secondary" onClick={handleAddIp} className="gap-1.5 shrink-0">
                    <Plus className="h-3.5 w-3.5" />
                    Add
                  </Button>
                </div>
                <Button
                  size="sm"
                  onClick={() => saveIpWhitelist.mutate(ipWhitelist)}
                  disabled={saveIpWhitelist.isPending}
                  className="gap-1.5 shrink-0"
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
      <section className="mb-5">
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-foreground">Two-Factor Authentication</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Require a time-based one-time code from an authenticator app (Google Authenticator, Authy, etc.) on every login.
          </p>
        </div>
        <div className="overflow-hidden rounded-xl border border-border bg-card px-5 py-4 shadow-sm">
          {isLoading ? (
            <Skeleton className="h-10 rounded-lg" />
          ) : settings?.totpEnabled ? (
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <ShieldCheck className="h-4 w-4 text-emerald-500" />
                <span className="text-sm font-medium text-foreground">2FA is enabled</span>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => disable2fa.mutate()}
                disabled={disable2fa.isPending}
                className="gap-1.5 text-destructive hover:text-destructive"
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
                size="sm"
                onClick={() => setup2fa.mutate()}
                disabled={setup2fa.isPending}
                className="gap-1.5"
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
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">Manual entry key</p>
                  <p className="break-all font-mono text-xs text-foreground select-all">{totpSecret}</p>
                </div>
              </div>
              <div className="flex items-end gap-3">
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
                  size="sm"
                  onClick={() => enable2fa.mutate(totpConfirmCode)}
                  disabled={enable2fa.isPending || totpConfirmCode.length !== 6}
                  className="gap-1.5"
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Activate
                </Button>
                <Button
                  size="sm"
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

    </Layout>
  );
}
