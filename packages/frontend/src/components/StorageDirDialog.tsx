import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useCreateStorageDir, useUpdateStorageDir } from '@/hooks/useStorageDirs';
import type { StorageDir, StorageDirPurpose } from '@/types';

interface Props {
  open: boolean;
  onClose: () => void;
  // When editing, pass the existing dir; create dialog leaves this undefined.
  editing?: StorageDir;
}

const ALL_PURPOSES: { id: StorageDirPurpose; label: string; hint: string }[] = [
  { id: 'templates', label: 'Templates', hint: 'qcow2/img cloud images used as VM backing files' },
  { id: 'isos',      label: 'ISOs',      hint: 'installer ISOs attached to VMs at install time' },
  { id: 'vmDisks',   label: 'VM Disks',  hint: 'qcow2 files for VM primary and extra disks' },
];

export function StorageDirDialog({ open, onClose, editing }: Props) {
  const create = useCreateStorageDir();
  const update = useUpdateStorageDir();

  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [purposes, setPurposes] = useState<Set<StorageDirPurpose>>(new Set(['templates', 'isos', 'vmDisks']));
  const [setDefaultTemplates, setSetDefaultTemplates] = useState(false);
  const [setDefaultIsos, setSetDefaultIsos] = useState(false);
  const [setDefaultVmDisks, setSetDefaultVmDisks] = useState(false);

  // Re-seed form fields whenever the dialog opens for a new target.
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setPath(editing?.path ?? '');
    setPurposes(new Set(editing?.purposes ?? ['templates', 'isos', 'vmDisks']));
    setSetDefaultTemplates(editing?.isDefaultTemplates ?? false);
    setSetDefaultIsos(editing?.isDefaultIsos ?? false);
    setSetDefaultVmDisks(editing?.isDefaultVmDisks ?? false);
  }, [open, editing]);

  const togglePurpose = (p: StorageDirPurpose) => {
    setPurposes((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) { toast.error('Name is required'); return; }
    if (!path.trim() && !editing) { toast.error('Path is required'); return; }
    if (purposes.size === 0) { toast.error('Pick at least one purpose'); return; }

    try {
      if (editing) {
        await update.mutateAsync({
          id: editing.id,
          name: trimmed,
          purposes: [...purposes],
          setDefault: {
            templates: setDefaultTemplates,
            isos: setDefaultIsos,
            vmDisks: setDefaultVmDisks,
          },
        });
        toast.success(`Updated ${trimmed}`);
      } else {
        await create.mutateAsync({
          name: trimmed,
          path: path.trim(),
          purposes: [...purposes],
          setDefault: {
            templates: setDefaultTemplates,
            isos: setDefaultIsos,
            vmDisks: setDefaultVmDisks,
          },
        });
        toast.success(`Added ${trimmed}`);
      }
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Operation failed';
      // Surface the backend's validation error verbatim — it usually says
      // exactly what's wrong (path missing, not writable, name in use…).
      const apiMsg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(apiMsg ?? msg);
    }
  };

  const busy = create.isPending || update.isPending;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? `Edit ${editing.name}` : 'Add storage directory'}
      description={
        editing
          ? 'Rename, change which content this directory holds, or move the default flags.'
          : 'Register a folder that VirtPilot can use for templates, ISOs, or VM disks. Mount your iSCSI/NFS/local volume and point to it here.'
      }
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Add directory'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. iSCSI-Vol-1"
          autoFocus
        />
        {!editing && (
          <Input
            label="Path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/mnt/iscsi-vol-1"
            spellCheck={false}
          />
        )}
        {editing && (
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground">Path</label>
            <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-muted-foreground">
              {editing.path}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Path is fixed once registered — delete and re-add to point at a different folder.
            </p>
          </div>
        )}

        <div className="space-y-2">
          <label className="text-xs font-medium text-foreground">Holds</label>
          <div className="space-y-1.5">
            {ALL_PURPOSES.map((p) => (
              <label key={p.id} className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm transition-colors hover:bg-muted/30">
                <input
                  type="checkbox"
                  checked={purposes.has(p.id)}
                  onChange={() => togglePurpose(p.id)}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-foreground">{p.label}</p>
                  <p className="text-[11px] text-muted-foreground">{p.hint}</p>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-foreground">Use as default for</label>
          <div className="flex flex-wrap gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
              <input
                type="checkbox"
                checked={setDefaultTemplates}
                onChange={(e) => setSetDefaultTemplates(e.target.checked)}
                disabled={!purposes.has('templates')}
              />
              Templates
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
              <input
                type="checkbox"
                checked={setDefaultIsos}
                onChange={(e) => setSetDefaultIsos(e.target.checked)}
                disabled={!purposes.has('isos')}
              />
              ISOs
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
              <input
                type="checkbox"
                checked={setDefaultVmDisks}
                onChange={(e) => setSetDefaultVmDisks(e.target.checked)}
                disabled={!purposes.has('vmDisks')}
              />
              VM disks
            </label>
          </div>
          <p className="text-[11px] text-muted-foreground">
            The default for a purpose is pre-selected when uploading or creating a VM. Tick to make this directory the default; it'll replace whatever currently holds that flag.
          </p>
        </div>
      </div>
    </Dialog>
  );
}
