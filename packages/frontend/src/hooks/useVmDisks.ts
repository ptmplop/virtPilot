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
    mutationFn: async (vmName: string) => {
      await api.delete(`/api/vms/disks/${encodeURIComponent(vmName)}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vm-disks'] }),
  });
}
