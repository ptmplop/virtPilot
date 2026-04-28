import { useState, useEffect } from 'react';
import { Save } from 'lucide-react';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Layout } from '@/components/layout/Layout';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useSettings } from '@/hooks/useSettings';
import { api } from '@/lib/api';

export function SettingsPage() {
  const { data: settings, isLoading } = useSettings();
  const queryClient = useQueryClient();

  const [maxLogs, setMaxLogs] = useState<string>('');
  useEffect(() => {
    if (settings?.maxLogs != null) setMaxLogs(String(settings.maxLogs));
  }, [settings?.maxLogs]);

  const saveSettings = useMutation({
    mutationFn: async (values: { maxLogs: number }) => {
      const { data } = await api.put<{ settings: { maxLogs: number } }>('/api/settings', values);
      return data.settings;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['settings'], (prev: typeof settings) => prev ? { ...prev, ...updated } : prev);
      toast.success('Settings saved');
    },
    onError: () => toast.error('Failed to save settings'),
  });

  function handleSaveMaxLogs() {
    const n = parseInt(maxLogs, 10);
    if (isNaN(n) || n < 10 || n > 10_000) {
      toast.error('Max logs must be between 10 and 10,000');
      return;
    }
    saveSettings.mutate({ maxLogs: n });
  }

  return (
    <Layout title="Settings" subtitle="Log retention and host requirements.">
      {/* Log retention */}
      <section className="mb-5">
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-foreground">Log Retention</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Maximum number of log entries to keep. Oldest entries are pruned automatically. Range: 10 – 10,000.
          </p>
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-card px-5 py-4">
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

      {/* Requirements */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-foreground">Host Requirements</h2>
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="divide-y divide-border">
            <div className="px-5 py-4">
              <p className="mb-3 text-xs text-muted-foreground">
                The following packages must be installed on the host (Debian/Ubuntu):
              </p>
              <ul className="space-y-1.5">
                {['libvirt-daemon-system', 'libvirt-clients', 'qemu-system-x86', 'qemu-utils', 'genisoimage'].map((pkg) => (
                  <li key={pkg} className="flex items-center gap-2.5">
                    <span className="flex h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                    <span className="font-mono text-xs text-foreground">{pkg}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="px-5 py-4 text-xs text-muted-foreground">
              For KVM acceleration, ensure the host CPU supports virtualisation and{' '}
              <span className="font-mono text-foreground">/dev/kvm</span> is present.
              The backend process user must be in the{' '}
              <span className="font-mono text-foreground">libvirt</span> group.
            </div>
          </div>
        </div>
      </section>
    </Layout>
  );
}
