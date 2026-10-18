import { useState } from 'react';
import { Check, KeyRound, Plus, Trash2, X } from 'lucide-react';
import axios from 'axios';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';
import { cn } from '@/lib/cn';
import { useSshKeys, useAddSshKey, useDeleteSshKey } from '@/hooks/useSshKeys';

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
    } catch (err) {
      // The server says why (not an OpenSSH key, or already saved under another name).
      const reason = axios.isAxiosError(err) ? (err.response?.data as { error?: string } | undefined)?.error : undefined;
      toast.error(reason ?? 'Failed to add SSH key');
    }
  };

  return (
    <div className="panel overflow-hidden">
      <div className="panel-head">
        <h3 className="panel-title">Add SSH key</h3>
        <button
          type="button"
          onClick={onDone}
          aria-label="Close"
          className="ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
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
          <label className="text-[13px] font-semibold text-foreground">Public key</label>
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
          Add key
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
    <div className="flex items-center gap-4 px-5 py-3.5">
      <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-semibold text-foreground">{name}</p>
        <p className="mt-0.5 truncate font-mono text-[11.5px] text-muted-foreground">{keyPreview}</p>
      </div>
      <p className="shrink-0 text-[12.5px] text-muted-foreground">{dateAdded}</p>
      <button
        type="button"
        onClick={handleDelete}
        disabled={deleteKey.isPending}
        className={cn(
          'inline-flex h-8 shrink-0 items-center justify-center rounded-md text-xs font-medium transition-colors',
          confirming
            ? 'bg-destructive/10 px-2.5 text-destructive hover:bg-destructive/15'
            : 'w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
        )}
        title={confirming ? 'Click again to confirm deletion' : 'Remove key'}
        aria-label={confirming ? `Confirm removing key ${name}` : `Remove key ${name}`}
      >
        {deleteKey.isPending ? (
          <Spinner className="h-3.5 w-3.5" />
        ) : confirming ? (
          <span className="flex items-center gap-1.5 text-[12px]"><Trash2 size={13} /> Confirm</span>
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

  return (
    <Layout
      title="SSH keys"
      subtitle="Public keys you can add to new VMs."
      actions={
        !showForm && (
          <Button onClick={() => setShowForm(true)}>
            <Plus size={14} /> Add key
          </Button>
        )
      }
    >
      <div className="space-y-4">
        {showForm && <AddKeyForm onDone={() => setShowForm(false)} />}

        <div className="panel overflow-hidden">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner className="h-5 w-5 text-muted-foreground" />
            </div>
          ) : !keys?.length ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <KeyRound className="mb-3 h-5 w-5 text-muted-foreground" />
              <p className="text-sm font-semibold text-foreground">No SSH keys saved</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Add a key above to use it when provisioning VMs.
              </p>
            </div>
          ) : (
            <>
              <div className="divide-y divide-border">
                {keys.map((key) => (
                  <KeyRow key={key.id} {...key} />
                ))}
              </div>
              <p className="border-t border-border bg-surface/60 px-5 py-2.5 text-[12px] tabular-nums text-muted-foreground">
                {keys.length} {keys.length === 1 ? 'key' : 'keys'}
              </p>
            </>
          )}
        </div>
      </div>
    </Layout>
  );
}
