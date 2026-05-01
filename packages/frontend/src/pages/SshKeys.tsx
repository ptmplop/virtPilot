import { useState } from 'react';
import { Check, Clock, KeyRound, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';
import { cn } from '@/lib/cn';
import { useSshKeys, useAddSshKey, useDeleteSshKey } from '@/hooks/useSshKeys';

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, iconClass }: {
  icon: React.ElementType;
  label: string;
  value: string;
  iconClass: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', iconClass)}>
          <Icon size={15} />
        </div>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</p>
          <p className="mt-0.5 text-xl font-bold tabular-nums leading-tight text-foreground">{value}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Add key form ──────────────────────────────────────────────────────────────

function AddKeyForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const addKey = useAddSshKey();

  const valid = name.trim() && publicKey.trim();

  const handleSubmit = async () => {
    if (!valid) return;
    try {
      await addKey.mutateAsync({ name: name.trim(), publicKey: publicKey.trim() });
      toast.success('SSH key added');
      onDone();
    } catch {
      toast.error('Failed to add SSH key');
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b border-border bg-[hsl(var(--surface))] px-5 py-3">
        <p className="text-sm font-semibold text-foreground">Add SSH Key</p>
        <button
          type="button"
          onClick={onDone}
          className="rounded p-1 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          <X size={14} />
        </button>
      </div>
      <div className="space-y-4 p-5">
        <Input
          label="Friendly name"
          placeholder="e.g. My MacBook"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground">Public key</label>
          <textarea
            className={cn(
              'block w-full resize-none rounded-lg border border-input bg-background px-3 py-2.5',
              'font-mono text-xs text-foreground placeholder:text-muted-foreground/35',
              'focus:outline-none focus:ring-2 focus:ring-ring'
            )}
            rows={3}
            placeholder="ssh-ed25519 AAAA... or ssh-rsa AAAA..."
            value={publicKey}
            onChange={(e) => setPublicKey(e.target.value)}
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-border bg-[hsl(var(--surface))] px-5 py-3">
        <Button type="button" variant="secondary" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!valid || addKey.isPending}
          onClick={handleSubmit}
        >
          {addKey.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Check size={13} />}
          Add Key
        </Button>
      </div>
    </div>
  );
}

// ─── Key row ──────────────────────────────────────────────────────────────────

function KeyRow({ id, name, publicKey, createdAt }: { id: string; name: string; publicKey: string; createdAt: string }) {
  const deleteKey = useDeleteSshKey();
  const [confirming, setConfirming] = useState(false);

  const handleDelete = async () => {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    try {
      await deleteKey.mutateAsync(id);
      toast.success(`Key "${name}" removed`);
    } catch {
      toast.error('Failed to remove key');
    }
  };

  const keyPreview = publicKey.length > 60
    ? `${publicKey.slice(0, 30)}…${publicKey.slice(-20)}`
    : publicKey;

  const dateAdded = new Date(createdAt).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });

  return (
    <div className="flex items-center gap-4 px-5 py-4">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
        <KeyRound className="h-3.5 w-3.5 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">{name}</p>
        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground/60 truncate">{keyPreview}</p>
      </div>
      <p className="shrink-0 text-xs text-muted-foreground/50">{dateAdded}</p>
      <button
        type="button"
        onClick={handleDelete}
        disabled={deleteKey.isPending}
        className={cn(
          'shrink-0 rounded p-1.5 text-xs font-medium transition-colors',
          confirming
            ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
            : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
        )}
        title={confirming ? 'Click again to confirm deletion' : 'Remove key'}
      >
        {deleteKey.isPending ? (
          <Spinner className="h-3.5 w-3.5" />
        ) : confirming ? (
          <span className="flex items-center gap-1 text-[11px]"><Trash2 size={12} /> Confirm</span>
        ) : (
          <Trash2 size={14} />
        )}
      </button>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function SshKeysPage() {
  const { data: keys, isLoading } = useSshKeys();
  const [showForm, setShowForm] = useState(false);

  const lastAdded = keys?.length
    ? new Date(Math.max(...keys.map((k) => new Date(k.createdAt).getTime()))).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
      })
    : '—';

  return (
    <Layout
      title="SSH Keys"
      subtitle="Manage public keys available for VM provisioning."
      actions={
        !showForm && (
          <Button size="sm" onClick={() => setShowForm(true)}>
            <Plus size={13} /> Add Key
          </Button>
        )
      }
    >
      {/* Stats */}
      <div className="mb-6 grid grid-cols-2 gap-3">
        <StatCard icon={KeyRound} label="Saved Keys" value={isLoading ? '—' : String(keys?.length ?? 0)} iconClass="bg-violet-500/10 text-violet-500" />
        <StatCard icon={Clock} label="Last Added" value={isLoading ? '—' : lastAdded} iconClass="bg-blue-500/10 text-blue-500" />
      </div>

      <div className="space-y-4">
        {showForm && <AddKeyForm onDone={() => setShowForm(false)} />}

        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner className="h-5 w-5 text-muted-foreground" />
            </div>
          ) : !keys?.length ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
                <KeyRound className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-semibold text-foreground">No SSH keys saved</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Add a key above to use it when provisioning VMs.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {keys.map((key) => (
                <KeyRow key={key.id} {...key} />
              ))}
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
