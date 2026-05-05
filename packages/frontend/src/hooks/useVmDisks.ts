import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { VmDiskFile } from '@/types';

export function useVmDisks() {
  return useQuery({
    queryKey: ['vm-disks'],
    queryFn: async () => {
      const { data } = await api.get<{ disks: VmDiskFile[] }>('/api/vms/disks');
      return data.disks;
    },
    refetchInterval: 10_000,
  });
}

export function useDeleteOrphanedVmDisk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vmUuid: string) => {
      await api.delete(`/api/vms/disks/${encodeURIComponent(vmUuid)}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vm-disks'] }),
  });
}

// Triggers a browser download of a VM's qcow2 disk. The flow is:
// 1) POST to mint a 60-second signed ticket
// 2) Click an anchor pointing at /api/downloads/disk?t=<ticket>
// The ticket carries auth in the URL so the browser can stream the file
// straight to disk — buffering multi-GB qcow2s into a Blob would blow up.
export function useDownloadVmDisk() {
  return useMutation({
    mutationFn: async ({ vmUuid, filename }: { vmUuid: string; filename: string }) => {
      const { data } = await api.post<{ url: string }>(
        `/api/vms/${encodeURIComponent(vmUuid)}/disk-files/${encodeURIComponent(filename)}/download-ticket`,
      );
      const a = document.createElement('a');
      a.href = data.url;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
  });
}

export function useMoveVmDisk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ vmUuid, filename, storageDirId }: { vmUuid: string; filename: string; storageDirId: string }) => {
      await api.post(
        `/api/vms/${encodeURIComponent(vmUuid)}/disk-files/${encodeURIComponent(filename)}/move`,
        { storageDirId },
      );
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['vm-disks'] });
      qc.invalidateQueries({ queryKey: ['storage-dirs'] });
      qc.invalidateQueries({ queryKey: ['vm', vars.vmUuid] });
    },
  });
}
