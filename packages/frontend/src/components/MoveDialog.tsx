import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { StorageDirSelect } from '@/components/StorageDirSelect';
import type { StorageDirPurpose } from '@/types';

interface Props {
  open: boolean;
  onClose: () => void;
  // What is being moved (used for the title and the picker's purpose filter).
  itemLabel: string;       // e.g. "ubuntu-24.04.qcow2"
  purpose: StorageDirPurpose;
  // Storage dir the item lives in today — excluded from the dropdown options
  // so the operator can never "move" the file to where it already lives.
  currentStorageDirId: string;
  // Caller-supplied notes shown above the picker — context-specific guardrails
  // (e.g. "VM must be stopped" for VM disks).
  notes?: React.ReactNode;
  // Async move action. Throws on failure; the dialog surfaces the error verbatim.
  onMove: (targetStorageDirId: string) => Promise<void>;
  busy?: boolean;
}

export function MoveDialog({ open, onClose, itemLabel, purpose, currentStorageDirId, notes, onMove, busy }: Props) {
  const [targetId, setTargetId] = useState('');

  // Reset the picker each time the dialog reopens — otherwise a stale target
  // from the last move sticks around.
  useEffect(() => {
    if (!open) setTargetId('');
  }, [open]);

  const submit = async () => {
    if (!targetId) { toast.error('Pick a destination'); return; }
    if (targetId === currentStorageDirId) { toast.error('Pick a different storage directory'); return; }
    try {
      await onMove(targetId);
      toast.success(`${itemLabel} moved`);
      onClose();
    } catch (err: unknown) {
      const apiMsg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(apiMsg ?? (err instanceof Error ? err.message : 'Move failed'));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Move ${itemLabel}`}
      description="Pick a destination storage directory. The file is physically moved on disk; nothing else is rewritten until references are updated automatically."
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={busy || !targetId || targetId === currentStorageDirId}>
            {busy ? 'Moving…' : 'Move'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {notes && <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">{notes}</div>}
        <StorageDirSelect
          purpose={purpose}
          value={targetId}
          onChange={setTargetId}
          label="Destination"
          excludeId={currentStorageDirId}
        />
      </div>
    </Dialog>
  );
}
