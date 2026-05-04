import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  BackupEntry,
  BackupInProgress,
  BackupSchedule,
  BackupVmSummary,
  BackupFrequency,
} from '@/types';

const KEYS = {
  summaries: ['backups'] as const,
  vm: (vmUuid: string) => ['backups', vmUuid] as const,
};

export function useBackupSummaries() {
  return useQuery({
    queryKey: KEYS.summaries,
    queryFn: async () => {
      const { data } = await api.get<{ summaries: BackupVmSummary[] }>('/api/backups');
      return data.summaries;
    },
    refetchInterval: 30_000,
  });
}

export function useVmBackups(vmUuid: string) {
  return useQuery({
    queryKey: KEYS.vm(vmUuid),
    queryFn: async () => {
      const { data } = await api.get<{ backups: BackupEntry[]; schedule: BackupSchedule | null }>(`/api/backups/${vmUuid}`);
      return data;
    },
    enabled: !!vmUuid,
    refetchInterval: 15_000,
  });
}

export function useRunningBackups() {
  return useQuery({
    queryKey: ['backups', 'running'],
    queryFn: async () => {
      const { data } = await api.get<{ running: BackupInProgress[] }>('/api/backups/running');
      return data.running;
    },
    refetchInterval: (query) => (query.state.data?.length ? 3_000 : 10_000),
  });
}

export function useCreateBackup(vmUuid: string, vmName: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{ backup: BackupEntry }>(`/api/backups/${vmUuid}`, undefined, { timeout: 0 });
      return data.backup;
    },
    onMutate: () => {
      const prev = qc.getQueryData<BackupInProgress[]>(['backups', 'running']) ?? [];
      qc.setQueryData<BackupInProgress[]>(['backups', 'running'], [
        ...prev,
        { vmUuid, vmName, startedAt: new Date().toISOString(), triggerType: 'manual' },
      ]);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.vm(vmUuid) });
      qc.invalidateQueries({ queryKey: KEYS.summaries });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['backups', 'running'] });
    },
  });
}

export function useDeleteBackup(vmUuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (backupId: string) => {
      await api.delete(`/api/backups/${vmUuid}/${backupId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.vm(vmUuid) });
      qc.invalidateQueries({ queryKey: KEYS.summaries });
    },
  });
}

export function useRestoreBackup(vmUuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ backupId, targetVmUuid }: { backupId: string; targetVmUuid?: string }) => {
      await api.post(`/api/backups/${vmUuid}/${backupId}/restore`, { targetVmUuid }, { timeout: 0 });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vms'] });
    },
  });
}

export function useSaveSchedule(vmUuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (schedule: {
      frequency: BackupFrequency;
      hour?: number;
      minute?: number;
      dayOfWeek?: number;
      dayOfMonth?: number;
      retentionDays?: number | null;
      enabled?: boolean;
    }) => {
      const { data } = await api.put<{ schedule: BackupSchedule }>(`/api/backups/schedules/${vmUuid}`, schedule);
      return data.schedule;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.vm(vmUuid) });
      qc.invalidateQueries({ queryKey: KEYS.summaries });
    },
  });
}

export function useDeleteSchedule(vmUuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.delete(`/api/backups/schedules/${vmUuid}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.vm(vmUuid) });
      qc.invalidateQueries({ queryKey: KEYS.summaries });
    },
  });
}
