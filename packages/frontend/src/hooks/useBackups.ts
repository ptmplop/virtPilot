import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  BackupEntry,
  BackupSchedule,
  BackupVmSummary,
  BackupFrequency,
} from '@/types';

const KEYS = {
  summaries: ['backups'] as const,
  vm: (vmName: string) => ['backups', vmName] as const,
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

export function useVmBackups(vmName: string) {
  return useQuery({
    queryKey: KEYS.vm(vmName),
    queryFn: async () => {
      const { data } = await api.get<{ backups: BackupEntry[]; schedule: BackupSchedule | null }>(`/api/backups/${vmName}`);
      return data;
    },
    enabled: !!vmName,
    refetchInterval: 15_000,
  });
}

export function useCreateBackup(vmName: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<{ backup: BackupEntry }>(`/api/backups/${vmName}`);
      return data.backup;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.vm(vmName) });
      qc.invalidateQueries({ queryKey: KEYS.summaries });
    },
  });
}

export function useDeleteBackup(vmName: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (backupId: string) => {
      await api.delete(`/api/backups/${vmName}/${backupId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.vm(vmName) });
      qc.invalidateQueries({ queryKey: KEYS.summaries });
    },
  });
}

export function useRestoreBackup(vmName: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ backupId, newVmName }: { backupId: string; newVmName?: string }) => {
      await api.post(`/api/backups/${vmName}/${backupId}/restore`, { newVmName });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vms'] });
    },
  });
}

export function useSaveSchedule(vmName: string) {
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
      const { data } = await api.put<{ schedule: BackupSchedule }>(`/api/backups/schedules/${vmName}`, schedule);
      return data.schedule;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.vm(vmName) });
      qc.invalidateQueries({ queryKey: KEYS.summaries });
    },
  });
}

export function useDeleteSchedule(vmName: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.delete(`/api/backups/schedules/${vmName}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.vm(vmName) });
      qc.invalidateQueries({ queryKey: KEYS.summaries });
    },
  });
}
