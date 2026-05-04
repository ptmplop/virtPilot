import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { DhcpReservation, FirewallConfig, Vm, VmCredentials, VmMeta, VmMetricsRange, VmMetricsResponse, VmSnapshot, VmStatsResponse, VmSummary } from '@/types';

const KEYS = {
  vms: ['vms'] as const,
  vm: (uuid: string) => ['vms', uuid] as const,
};

export function useVms() {
  return useQuery({
    queryKey: KEYS.vms,
    queryFn: async () => {
      const { data } = await api.get<{ vms: VmSummary[] }>('/api/vms');
      return data.vms;
    },
    refetchInterval: 5_000,
  });
}

export function useVmMeta(uuid: string) {
  return useQuery({
    queryKey: [...KEYS.vm(uuid), 'meta'] as const,
    queryFn: async () => {
      const { data } = await api.get<{ meta: VmMeta | null; ip: string | null }>(`/api/vms/${uuid}/meta`);
      return data;
    },
    refetchInterval: 10_000,
  });
}

// On-demand fetch for the guest password. Kept off the routine meta poll so
// the secret doesn't sit in the React Query cache or trail through request
// logs unless the operator explicitly asked to see/copy it.
export function useVmCredentials(uuid: string) {
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.get<VmCredentials>(`/api/vms/${uuid}/credentials`);
      return data;
    },
  });
}

export function useVm(uuid: string) {
  return useQuery({
    queryKey: KEYS.vm(uuid),
    queryFn: async () => {
      const { data } = await api.get<{ vm: Vm }>(`/api/vms/${uuid}`);
      return data.vm;
    },
    refetchInterval: 5_000,
  });
}

export function useVmIfAddrs(uuid: string) {
  return useQuery({
    queryKey: [...KEYS.vm(uuid), 'ifaddrs'] as const,
    queryFn: async () => {
      const { data } = await api.get<{ ips: Record<string, string> }>(`/api/vms/${uuid}/ifaddrs`);
      return data.ips;
    },
    enabled: !!uuid,
    refetchInterval: 10_000,
  });
}

export function useVmReservations(uuid: string) {
  return useQuery({
    queryKey: [...KEYS.vm(uuid), 'reservations'] as const,
    queryFn: async () => {
      const { data } = await api.get<{ reservations: DhcpReservation[] }>(`/api/vms/${uuid}/reservations`);
      return data.reservations;
    },
    enabled: !!uuid,
  });
}

export function useCreateVm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const { data } = await api.post<{ uuid: string; name: string }>('/api/vms', payload);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vms }),
  });
}

export function useDeleteVm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ uuid, deleteStorage }: { uuid: string; deleteStorage?: boolean }) => {
      await api.delete(`/api/vms/${uuid}`, { params: { deleteStorage } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vms }),
  });
}

export function useVmAction(uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ action, params }: { action: 'start' | 'stop' | 'reboot'; params?: Record<string, string> }) => {
      await api.post(`/api/vms/${uuid}/${action}`, null, { params });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.vms });
      qc.invalidateQueries({ queryKey: KEYS.vm(uuid) });
    },
  });
}

export function useAddDisk(uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { sizeGb: number; target?: string }) => {
      await api.post(`/api/vms/${uuid}/disks`, payload);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vm(uuid) }),
  });
}

export function useDetachDisk(uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (target: string) => {
      await api.delete(`/api/vms/${uuid}/disks/${target}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vm(uuid) }),
  });
}

export function useAttachCdrom(uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { isoFilename: string; target?: string }) => {
      await api.post(`/api/vms/${uuid}/cdrom`, payload);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vm(uuid) }),
  });
}

export function useDetachCdrom(uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (target: string) => {
      await api.delete(`/api/vms/${uuid}/cdrom/${target}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vm(uuid) }),
  });
}

export function useAddNic(uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      networkId: string;
      model?: string;
      staticIp?: string;
      inboundKbps?: number;
      outboundKbps?: number;
    }) => {
      const { data } = await api.post<{ ok: boolean; mac: string }>(`/api/vms/${uuid}/nics`, payload);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vm(uuid) }),
  });
}

export function useDetachNic(uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (mac: string) => {
      await api.delete(`/api/vms/${uuid}/nics/${mac}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vm(uuid) }),
  });
}

export function useSetNicBandwidth(uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { mac: string; inboundKbps: number; outboundKbps: number }) => {
      const { mac, ...body } = payload;
      await api.put(`/api/vms/${uuid}/nics/${mac}/bandwidth`, body);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vm(uuid) }),
  });
}

export function useSetBootOrder(uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (bootOrder: string[]) => {
      await api.put(`/api/vms/${uuid}/boot-order`, { bootOrder });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vm(uuid) }),
  });
}

export function useBootOnce(uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (device: string) => {
      await api.post(`/api/vms/${uuid}/boot-once`, { device });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.vms });
      qc.invalidateQueries({ queryKey: KEYS.vm(uuid) });
    },
  });
}

export function useSnapshots(uuid: string) {
  return useQuery({
    queryKey: [...KEYS.vm(uuid), 'snapshots'] as const,
    queryFn: async () => {
      const { data } = await api.get<{ snapshots: VmSnapshot[] }>(`/api/vms/${uuid}/snapshots`);
      return data.snapshots;
    },
    refetchInterval: 10_000,
  });
}

export function useCreateSnapshot(uuid: string) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: [...KEYS.vm(uuid), 'snapshots'] });
  return useMutation({
    mutationFn: async (payload: { name: string; description?: string }) => {
      await api.post(`/api/vms/${uuid}/snapshots`, payload, { timeout: 3 * 60_000 });
    },
    onSuccess: invalidate,
    onError: invalidate,
  });
}

export function useDeleteSnapshot(uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (snapshotName: string) => {
      await api.delete(`/api/vms/${uuid}/snapshots/${snapshotName}`, { timeout: 3 * 60_000 });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEYS.vm(uuid), 'snapshots'] }),
  });
}

export function useRevertSnapshot(uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (snapshotName: string) => {
      await api.post(`/api/vms/${uuid}/snapshots/${snapshotName}/revert`, undefined, { timeout: 3 * 60_000 });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.vms });
      qc.invalidateQueries({ queryKey: KEYS.vm(uuid) });
      qc.invalidateQueries({ queryKey: [...KEYS.vm(uuid), 'snapshots'] });
    },
  });
}

export function useSnapshotToTemplate(uuid: string) {
  return useMutation({
    mutationFn: async ({ snapshotName, templateName }: { snapshotName: string; templateName: string }) => {
      const { data } = await api.post<{ ok: boolean; filename: string; sourceTemplateFilename?: string }>(
        `/api/vms/${uuid}/snapshots/${snapshotName}/to-template`,
        { templateName },
      );
      return data;
    },
  });
}

export function useVmFirewall(uuid: string) {
  return useQuery({
    queryKey: [...KEYS.vm(uuid), 'firewall'] as const,
    queryFn: async () => {
      const { data } = await api.get<FirewallConfig>(`/api/vms/${uuid}/firewall`);
      return data;
    },
  });
}

export function useSaveFirewall(uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (cfg: FirewallConfig) => {
      await api.put(`/api/vms/${uuid}/firewall`, cfg);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEYS.vm(uuid), 'firewall'] }),
  });
}

export function useApplyFirewall(uuid: string) {
  return useMutation({
    mutationFn: async () => {
      await api.post(`/api/vms/${uuid}/firewall/apply`);
    },
  });
}

export function useSetAutostart(uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      await api.put(`/api/vms/${uuid}/autostart`, { enabled });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vm(uuid) }),
  });
}

export function useResizeDisk(uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ target, addGb }: { target: string; addGb: number }) => {
      await api.post(`/api/vms/${uuid}/disks/${target}/resize`, { addGb }, { timeout: 120_000 });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vm(uuid) }),
  });
}

export function useUpdateVmResources(uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ cpus, memoryMb }: { cpus: number; memoryMb: number }) => {
      await api.put(`/api/vms/${uuid}/resources`, { cpus, memoryMb });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.vms });
      qc.invalidateQueries({ queryKey: KEYS.vm(uuid) });
    },
  });
}

export function useRenameVm(uuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (newName: string) => {
      const { data } = await api.put<{ ok: boolean; newName: string }>(`/api/vms/${uuid}/rename`, { newName });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.vms });
      qc.invalidateQueries({ queryKey: KEYS.vm(uuid) });
    },
  });
}

export function useVmStats(uuid: string, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.vm(uuid), 'stats'] as const,
    queryFn: async () => {
      const { data } = await api.get<VmStatsResponse>(`/api/vms/${uuid}/stats`);
      return data;
    },
    enabled,
    refetchInterval: 3_000,
    retry: false,
  });
}

export function useVmMetricsHistory(uuid: string, range: VmMetricsRange, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.vm(uuid), 'metrics', range] as const,
    queryFn: async () => {
      const { data } = await api.get<VmMetricsResponse>(`/api/vms/${uuid}/metrics`, { params: { range } });
      return data;
    },
    enabled,
    refetchInterval: range === '1h' ? 30_000 : 5 * 60_000,
    retry: false,
  });
}
