import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { HostNic, Network, NetworkIpStatus } from '@/types';

const KEYS = {
  networks: ['networks'] as const,
  network: (id: string) => ['networks', id] as const,
  systemNics: ['system', 'nics'] as const,
};

export function useNetworks() {
  return useQuery({
    queryKey: KEYS.networks,
    queryFn: async () => {
      const { data } = await api.get<{ networks: Network[] }>('/api/networks');
      return data.networks;
    },
  });
}

export function useNetwork(id: string) {
  return useQuery({
    queryKey: KEYS.network(id),
    queryFn: async () => {
      const { data } = await api.get<{ network: Network; ips: NetworkIpStatus[] }>(`/api/networks/${id}`);
      return data;
    },
    enabled: !!id,
  });
}

export function useSystemNics() {
  return useQuery({
    queryKey: KEYS.systemNics,
    queryFn: async () => {
      const { data } = await api.get<{ nics: HostNic[] }>('/api/system/nics');
      return data.nics;
    },
  });
}

export function useCreateNetwork() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      name: string;
      type: 'nat' | 'bridge' | 'existing-bridge';
      cidr: string;
      gateway?: string;
      dns?: string[];
      ipMode?: 'dhcp' | 'static';
      physicalNic?: string;
      bridge?: string;
    }) => {
      const { data } = await api.post<{ network: Network }>('/api/networks', payload);
      return data.network;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.networks }),
  });
}

export function useDeleteNetwork() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/networks/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.networks }),
  });
}
