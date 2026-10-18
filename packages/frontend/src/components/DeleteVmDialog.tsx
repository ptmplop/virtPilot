import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

// Deleting a VM always asks the same question, from the list or from the VM's own page:
// undefine it, and keep or delete its disk images.
export function DeleteVmDialog({
  open, vmName, isPending, onClose, onConfirm,
}: {
  open: boolean;
  vmName: string;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (deleteStorage: boolean) => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Delete ${vmName}?`}
      description="This will undefine the VM in libvirt. Storage deletion is optional."
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onConfirm(false)} disabled={isPending}>
            Delete (keep storage)
          </Button>
          <Button variant="danger" size="sm" onClick={() => onConfirm(true)} disabled={isPending}>
            {isPending ? 'Deleting…' : 'Delete + storage'}
          </Button>
        </>
      }
    >
      <p className="text-[13.5px] text-foreground">
        The VM will be stopped and removed. Choose whether to also delete its disk images.
      </p>
    </Dialog>
  );
}
