import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { DhcpReservation, FirewallConfig, Vm, VmMeta, VmSnapshot, VmSummary } from '@/types';

const KEYS = {
  vms: ['vms'] as const,
  vm: (name: string) => ['vms', name] as const,
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

export function useVmMeta(name: string) {
  return useQuery({
    queryKey: [...KEYS.vm(name), 'meta'] as const,
    queryFn: async () => {
      const { data } = await api.get<{ meta: VmMeta | null; ip: string | null }>(`/api/vms/${name}/meta`);
      return data;
    },
    refetchInterval: 10_000,
  });
}

export function useVm(name: string) {
  return useQuery({
    queryKey: KEYS.vm(name),
    queryFn: async () => {
      const { data } = await api.get<{ vm: Vm }>(`/api/vms/${name}`);
      return data.vm;
    },
    refetchInterval: 5_000,
  });
}

export function useVmIfAddrs(name: string) {
  return useQuery({
    queryKey: [...KEYS.vm(name), 'ifaddrs'] as const,
    queryFn: async () => {
      const { data } = await api.get<{ ips: Record<string, string> }>(`/api/vms/${name}/ifaddrs`);
      return data.ips;
    },
    enabled: !!name,
    refetchInterval: 10_000,
  });
}

export function useVmReservations(name: string) {
  return useQuery({
    queryKey: [...KEYS.vm(name), 'reservations'] as const,
    queryFn: async () => {
      const { data } = await api.get<{ reservations: DhcpReservation[] }>(`/api/vms/${name}/reservations`);
      return data.reservations;
    },
    enabled: !!name,
  });
}

export function useCreateVm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const { data } = await api.post('/api/vms', payload);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vms }),
  });
}

export function useDeleteVm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, deleteStorage }: { name: string; deleteStorage?: boolean }) => {
      await api.delete(`/api/vms/${name}`, { params: { deleteStorage } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vms }),
  });
}

export function useVmAction(name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ action, params }: { action: 'start' | 'stop' | 'reboot'; params?: Record<string, string> }) => {
      await api.post(`/api/vms/${name}/${action}`, null, { params });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.vms });
      qc.invalidateQueries({ queryKey: KEYS.vm(name) });
    },
  });
}

export function useAddDisk(name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { sizeGb: number; target?: string }) => {
      await api.post(`/api/vms/${name}/disks`, payload);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vm(name) }),
  });
}

export function useDetachDisk(name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (target: string) => {
      await api.delete(`/api/vms/${name}/disks/${target}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vm(name) }),
  });
}

export function useAttachCdrom(name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { isoFilename: string; target?: string }) => {
      await api.post(`/api/vms/${name}/cdrom`, payload);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vm(name) }),
  });
}

export function useDetachCdrom(name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (target: string) => {
      await api.delete(`/api/vms/${name}/cdrom/${target}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vm(name) }),
  });
}

export function useAddNic(name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { bridge: string; model?: string }) => {
      await api.post(`/api/vms/${name}/nics`, payload);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vm(name) }),
  });
}

export function useDetachNic(name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (mac: string) => {
      await api.delete(`/api/vms/${name}/nics/${mac}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vm(name) }),
  });
}

export function useSetBootOrder(name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (bootOrder: string[]) => {
      await api.put(`/api/vms/${name}/boot-order`, { bootOrder });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.vm(name) }),
  });
}

export function useBootOnce(name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (device: string) => {
      await api.post(`/api/vms/${name}/boot-once`, { device });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.vms });
      qc.invalidateQueries({ queryKey: KEYS.vm(name) });
    },
  });
}

export function useSnapshots(name: string) {
  return useQuery({
    queryKey: [...KEYS.vm(name), 'snapshots'] as const,
    queryFn: async () => {
      const { data } = await api.get<{ snapshots: VmSnapshot[] }>(`/api/vms/${name}/snapshots`);
      return data.snapshots;
    },
    refetchInterval: 10_000,
  });
}

export function useCreateSnapshot(name: string) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: [...KEYS.vm(name), 'snapshots'] });
  return useMutation({
    mutationFn: async (payload: { name: string; description?: string }) => {
      await api.post(`/api/vms/${name}/snapshots`, payload, { timeout: 3 * 60_000 });
    },
    onSuccess: invalidate,
    // Snapshot may have been created even if the request timed out — always refresh the list
    onError: invalidate,
  });
}

export function useDeleteSnapshot(name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (snapshotName: string) => {
      await api.delete(`/api/vms/${name}/snapshots/${snapshotName}`, { timeout: 3 * 60_000 });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEYS.vm(name), 'snapshots'] }),
  });
}

export function useRevertSnapshot(name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (snapshotName: string) => {
      await api.post(`/api/vms/${name}/snapshots/${snapshotName}/revert`, undefined, { timeout: 3 * 60_000 });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.vms });
      qc.invalidateQueries({ queryKey: KEYS.vm(name) });
      qc.invalidateQueries({ queryKey: [...KEYS.vm(name), 'snapshots'] });
    },
  });
}

export function useSnapshotToTemplate(vmName: string) {
  return useMutation({
    mutationFn: async ({ snapshotName, templateName }: { snapshotName: string; templateName: string }) => {
      const { data } = await api.post<{ ok: boolean; filename: string; sourceTemplateFilename?: string }>(
        `/api/vms/${vmName}/snapshots/${snapshotName}/to-template`,
        { templateName },
      );
      return data;
    },
  });
}

export function useVmFirewall(name: string) {
  return useQuery({
    queryKey: [...KEYS.vm(name), 'firewall'] as const,
    queryFn: async () => {
      const { data } = await api.get<FirewallConfig>(`/api/vms/${name}/firewall`);
      return data;
    },
  });
}

export function useSaveFirewall(name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (cfg: FirewallConfig) => {
      await api.put(`/api/vms/${name}/firewall`, cfg);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEYS.vm(name), 'firewall'] }),
  });
}

export function useApplyFirewall(name: string) {
  return useMutation({
    mutationFn: async () => {
      await api.post(`/api/vms/${name}/firewall/apply`);
    },
  });
}
