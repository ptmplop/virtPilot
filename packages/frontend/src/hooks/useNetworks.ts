import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { BridgeStatus, ConnectedVm, HostNic, Network, NetworkIpMode, NetworkIpStatus, VxlanIds, VxlanStatus } from '@/types';

const KEYS = {
  networks: ['networks'] as const,
  network: (id: string) => ['networks', id] as const,
  systemNics: ['system', 'nics'] as const,
  vxlanIds: ['networks', 'vxlan', 'ids'] as const,
  vxlanStatus: ['networks', 'vxlan', 'status'] as const,
  bridgeStatus: ['networks', 'bridge', 'status'] as const,
  connected: ['networks', 'connected'] as const,
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
      type: 'nat' | 'bridge' | 'existing-bridge' | 'vxlan';
      cidr?: string;
      gateway?: string;
      dns?: string[];
      ipMode?: NetworkIpMode;
      physicalNic?: string;
      bridge?: string;
      /** vxlan: absent means the next available ID */
      vni?: number;
      peers?: string[];
      mtu?: number;
      port?: number;
    }) => {
      const { data } = await api.post<{ network: Network }>('/api/networks', payload);
      return data.network;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.networks });
      qc.invalidateQueries({ queryKey: KEYS.systemNics });
    },
  });
}

export function useDeleteNetwork() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/networks/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.networks });
      qc.invalidateQueries({ queryKey: KEYS.systemNics });
    },
  });
}

/** Asked afresh whenever the form opens: an ID can be taken outside VirtPilot at any time. */
export function useVxlanIds(enabled: boolean) {
  return useQuery({
    queryKey: KEYS.vxlanIds,
    queryFn: async () => {
      const { data } = await api.get<VxlanIds>('/api/networks/vxlan/ids');
      return data;
    },
    enabled,
    staleTime: 0,
  });
}

export function useVxlanStatus(enabled: boolean) {
  return useQuery({
    queryKey: KEYS.vxlanStatus,
    queryFn: async () => {
      const { data } = await api.get<{ status: Record<string, VxlanStatus> }>('/api/networks/vxlan/status');
      return data.status;
    },
    enabled,
    refetchInterval: 10_000,
  });
}

export function useBridgeStatus(enabled: boolean) {
  return useQuery({
    queryKey: KEYS.bridgeStatus,
    queryFn: async () => {
      const { data } = await api.get<{ status: Record<string, BridgeStatus> }>('/api/networks/bridge/status');
      return data.status;
    },
    enabled,
    refetchInterval: 10_000,
  });
}

/**
 * The VMs on a network, for as long as something needs to know: it asks libvirt about every VM.
 * Keyed by network and kept for no time, so each opening starts afresh: an answer from before
 * a NIC was removed must not come back and disable the button. `checking` is the first answer
 * only, as a failed poll with no data goes back to pending and would keep flipping it.
 */
export function useConnectedVms(networkId: string | null) {
  const query = useQuery({
    queryKey: [...KEYS.connected, networkId],
    queryFn: async () => {
      const { data } = await api.get<{ connected: Record<string, ConnectedVm[]> }>('/api/networks/connected');
      return data.connected[networkId!] ?? [];
    },
    enabled: networkId !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: 5_000,
  });
  return { vms: query.data, checking: query.isLoading && !query.isFetched };
}

export function useSetVxlanPeers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, peers }: { id: string; peers: string[] }) => {
      const { data } = await api.put<{ network: Network }>(`/api/networks/${id}/peers`, { peers });
      return data.network;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.networks }),
  });
}

export function useConnectVm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ vmId, networkId, staticIp }: { vmId: string; networkId: string; staticIp?: string }) => {
      const { data } = await api.post<{ ok: boolean; mac: string }>(`/api/vms/${vmId}/nics`, { networkId, staticIp });
      return data;
    },
    onSuccess: (_data, { vmId }) => {
      void qc.invalidateQueries({ queryKey: KEYS.networks });
      void qc.invalidateQueries({ queryKey: ['vms', vmId] });
    },
  });
}
