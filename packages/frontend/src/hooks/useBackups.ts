import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  BackupEntry,
  BackupInProgress,
  BackupKindRequest,
  BackupSchedule,
  BackupScheduleMode,
  BackupVmSummary,
  BackupFrequency,
  BackupAlert,
  BackupVerifyResult,
  IncrementalStatus,
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
      const { data } = await api.get<{
        backups: BackupEntry[];
        schedule: BackupSchedule | null;
        incremental: IncrementalStatus;
      }>(`/api/backups/${vmUuid}`);
      return data;
    },
    enabled: !!vmUuid,
    refetchInterval: 15_000,
  });
}

// Backups that have quietly stopped working are the failure mode that matters,
// so this is polled rather than waiting for someone to open a VM's page.
export function useBackupAlerts() {
  return useQuery({
    queryKey: ['backups', 'alerts'] as const,
    queryFn: async () => {
      const { data } = await api.get<{ alerts: BackupAlert[] }>('/api/backups/alerts');
      return data.alerts;
    },
    refetchInterval: 60_000,
  });
}

export function useVerifyBackup(vmUuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (backupId: string) => {
      // Reads every image in the chain, so it can take a while on a big backup.
      const { data } = await api.post<{ result: BackupVerifyResult }>(
        `/api/backups/${vmUuid}/${backupId}/verify`, undefined, { timeout: 0 },
      );
      return data.result;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.vm(vmUuid) });
      qc.invalidateQueries({ queryKey: ['backups', 'alerts'] });
    },
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
    mutationFn: async (kind: BackupKindRequest = 'full') => {
      const { data } = await api.post<{ backup: BackupEntry }>(`/api/backups/${vmUuid}`, { kind }, { timeout: 0 });
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
    mutationFn: async ({ backupId, cascade }: { backupId: string; cascade?: boolean }) => {
      await api.delete(`/api/backups/${vmUuid}/${backupId}${cascade ? '?cascade=true' : ''}`);
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

export interface RestoreAsNewInput {
  backupId: string;
  name: string;
  storageDirId?: string;
  regenerateCloudInit?: boolean;
  password?: string;
  start?: boolean;
}

export function useRestoreBackupAsNewVm(vmUuid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ backupId, ...body }: RestoreAsNewInput) => {
      const { data } = await api.post<{ uuid: string; name: string; warnings: string[] }>(
        `/api/backups/${vmUuid}/${backupId}/restore-as-new`,
        body,
        { timeout: 0 },
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vms'] });
      qc.invalidateQueries({ queryKey: KEYS.summaries });
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
      mode?: BackupScheduleMode;
      fullEvery?: number;
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
