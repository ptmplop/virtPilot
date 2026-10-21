import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { DeviceChangeResult, DeviceInventory, VmDevicesView } from '@/types';

const KEYS = {
  inventory: ['devices'] as const,
  vm: (uuid: string) => ['vm-devices', uuid] as const,
};

/** What the host can pass through, what it can't and why, and whether passthrough works here. */
export function useDeviceInventory(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: KEYS.inventory,
    queryFn: async () => (await api.get<DeviceInventory>('/api/devices')).data,
    refetchInterval: 15_000,
    staleTime: 10_000,
    enabled: opts.enabled ?? true,
  });
}

/** What one VM has been given, from its own definition (pending and missing devices included). */
export function useVmDevices(uuid: string) {
  return useQuery({
    queryKey: KEYS.vm(uuid),
    queryFn: async () => (await api.get<VmDevicesView>(`/api/vms/${uuid}/devices`)).data,
    // A start or a stop changes what a pending device means.
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

function useInvalidateDevices(uuid?: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: KEYS.inventory });
    if (uuid) qc.invalidateQueries({ queryKey: KEYS.vm(uuid) });
    else qc.invalidateQueries({ queryKey: ['vm-devices'] });
  };
}

export function useAttachDevice(vmUuid: string) {
  const invalidate = useInvalidateDevices(vmUuid);
  return useMutation({
    mutationFn: async (deviceId: string) => (await api.post<DeviceChangeResult>(`/api/vms/${vmUuid}/devices`, { deviceId }, { timeout: 120_000 })).data,
    onSettled: invalidate,
  });
}

export function useDetachDevice(vmUuid: string) {
  const invalidate = useInvalidateDevices(vmUuid);
  return useMutation({
    mutationFn: async (key: string) => (await api.delete<DeviceChangeResult>(`/api/vms/${vmUuid}/devices/${key}`, { timeout: 120_000 })).data,
    onSettled: invalidate,
  });
}

/** Undo a detach that is waiting for the VM to stop. */
export function useKeepAttached(vmUuid: string) {
  const invalidate = useInvalidateDevices(vmUuid);
  return useMutation({
    mutationFn: async (key: string) => (await api.post<DeviceChangeResult>(`/api/vms/${vmUuid}/devices/${key}/keep`, null, { timeout: 120_000 })).data,
    onSettled: invalidate,
  });
}

export function useKeepDevice() {
  const invalidate = useInvalidateDevices();
  return useMutation({
    mutationFn: async ({ id, keep }: { id: string; keep: boolean }) => {
      await api.post(`/api/devices/${id}/keep`, { keep }, { timeout: 150_000 });
    },
    onSettled: invalidate,
  });
}

export function useVirtualFunctions() {
  const invalidate = useInvalidateDevices();
  return useMutation({
    mutationFn: async ({ id, count }: { id: string; count: number }) => {
      await api.post(`/api/devices/${id}/virtual-functions`, { count }, { timeout: 150_000 });
    },
    onSettled: invalidate,
  });
}

export async function fetchPassthroughReport(): Promise<string> {
  const { data } = await api.get<string>('/api/devices/report', { responseType: 'text', timeout: 60_000 });
  return data;
}
