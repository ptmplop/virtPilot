import { useQuery } from '@tanstack/react-query';
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
