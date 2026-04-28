import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { PortForward } from '@/types';

const KEYS = {
  forNetwork: (networkId: string) => ['port-forwards', 'network', networkId] as const,
  forVm: (vmName: string) => ['port-forwards', 'vm', vmName] as const,
};

export function useNetworkPortForwards(networkId: string) {
  return useQuery({
    queryKey: KEYS.forNetwork(networkId),
    queryFn: async () => {
      const { data } = await api.get<{ forwards: PortForward[] }>(`/api/networks/${networkId}/port-forwards`);
      return data.forwards;
    },
    enabled: !!networkId,
  });
}

export function useVmPortForwards(vmName: string) {
  return useQuery({
    queryKey: KEYS.forVm(vmName),
    queryFn: async () => {
      const { data } = await api.get<{ forwards: PortForward[] }>(`/api/vms/${vmName}/port-forwards`);
      return data.forwards;
    },
    enabled: !!vmName,
  });
}

export function useCreatePortForward(networkId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      vmName: string;
      mac: string;
      protocol: 'tcp' | 'udp';
      hostPort: number;
      vmPort: number;
      description?: string;
    }) => {
      const { data } = await api.post<{ forward: PortForward }>(
        `/api/networks/${networkId}/port-forwards`,
        payload
      );
      return data.forward;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: KEYS.forNetwork(networkId) });
      qc.invalidateQueries({ queryKey: KEYS.forVm(variables.vmName) });
    },
  });
}

export function useDeletePortForward(networkId: string, vmName: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (forwardId: string) => {
      await api.delete(`/api/networks/${networkId}/port-forwards/${forwardId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.forNetwork(networkId) });
      qc.invalidateQueries({ queryKey: KEYS.forVm(vmName) });
    },
  });
}

export function useReserveIp(networkId: string, vmName: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (mac: string) => {
      const { data } = await api.post<{ ip: string }>(`/api/networks/${networkId}/reserve`, { vmName, mac });
      return data.ip;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vms', vmName, 'reservations'] });
      qc.invalidateQueries({ queryKey: KEYS.forVm(vmName) });
    },
  });
}
