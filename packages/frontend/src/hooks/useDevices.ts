import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { HostDevice } from '@/types';

const KEYS = {
  devices: ['devices'] as const,
};

export function useHostDevices() {
  return useQuery({
    queryKey: KEYS.devices,
    queryFn: async () => {
      const { data } = await api.get<{ devices: HostDevice[] }>('/api/devices');
      return data.devices;
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}

export function useAttachDevice(vmUuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (deviceId: string) => {
      await api.post(`/api/vms/${vmUuid}/devices`, { deviceId });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.devices }),
  });
}

export function useDetachDevice(vmUuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (deviceId: string) => {
      await api.delete(`/api/vms/${vmUuid}/devices/${deviceId}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.devices }),
  });
}
