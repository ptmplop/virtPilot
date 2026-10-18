import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CopyPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { StorageDirSelect } from '@/components/StorageDirSelect';
import { useCloneVm } from '@/hooks/useVms';
import type { VmStatus } from '@/types';

interface Props {
  open: boolean;
  vmUuid: string;
  vmName: string;
  vmStatus: VmStatus;
  onClose: () => void;
}

function apiError(e: unknown): string {
  const err = e as { response?: { data?: { error?: string } }; message?: string };
  return String(err.response?.data?.error ?? err.message ?? e);
}

export function CloneVmDialog({ open, vmUuid, vmName, vmStatus, onClose }: Props) {
  const navigate = useNavigate();
  const clone = useCloneVm(vmUuid);
  const [name, setName] = useState(`${vmName}-clone`);
  const [storageDirId, setStorageDirId] = useState('');
  const [regenerateCloudInit, setRegenerateCloudInit] = useState(true);
  const [password, setPassword] = useState('');
  const [startAfter, setStartAfter] = useState(false);

  const running = vmStatus === 'running';

  function handleClone() {
    toast.promise(
      clone
        .mutateAsync({
          name: name.trim(),
          storageDirId: storageDirId || undefined,
          regenerateCloudInit,
          password: password.trim() || undefined,
          start: startAfter,
        })
        .then((created) => {
          onClose();
          created.warnings.forEach((w) => toast.warning(w));
          navigate(`/vms/${created.uuid}`);
          return created;
        }),
      {
        loading: 'Cloning - this copies the full disk, so it can take a while…',
        success: (created) => `Created "${created.name}"`,
        error: (e) => `Clone failed: ${apiError(e)}`,
      },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Clone virtual machine"
      description={`A complete, independent copy of ${vmName}`}
      size="md"
      note={!name.trim() ? 'Name the clone.' : undefined}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={handleClone} disabled={clone.isPending || !name.trim()}>
            <CopyPlus size={13} />
            Clone
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="New VM name" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-vm-clone" />

        <StorageDirSelect purpose="vmDisks" value={storageDirId} onChange={setStorageDirId} />

        {/* The copy goes through the same consistency machinery as a backup, so
            there is no need to shut the source down first — worth saying, since
            every other tool in this space requires it. */}
        {running && (
          <Callout lead={`${vmName} is running.`}>
            Its disks are copied from a point-in-time snapshot, so the guest keeps running throughout and is
            never paused for more than a moment. With the guest agent installed the copy is application-consistent;
            without it, treat the clone like a machine that lost power.
          </Callout>
        )}

        <label className="flex items-start gap-2 text-[13px] text-foreground">
          <input
            type="checkbox"
            checked={regenerateCloudInit}
            onChange={(e) => setRegenerateCloudInit(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Give the clone its own identity
            <span className="mt-0.5 block text-[12.5px] leading-5 text-muted-foreground">
              Rebuilds cloud-init so the guest boots with the new name as its hostname and its own IP address.
              Turn this off to keep an exact copy - but a duplicated static IP will take both machines off the
              network.
            </span>
          </span>
        </label>

        {regenerateCloudInit && (
          <Input
            label="Guest password (optional)"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Leave blank to keep the source's password"
          />
        )}

        <label className="flex items-center gap-2 text-[13px] text-foreground">
          <input type="checkbox" checked={startAfter} onChange={(e) => setStartAfter(e.target.checked)} />
          <span>Start the clone once it is created</span>
        </label>
      </div>
    </Dialog>
  );
}
