import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { LogEntry } from '@/types';

export function useLogs() {
  return useQuery({
    queryKey: ['logs'],
    queryFn: async () => {
      const { data } = await api.get<{ logs: LogEntry[] }>('/api/logs');
      return data.logs;
    },
    refetchInterval: 10_000,
  });
}

export function useClearLogs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.delete('/api/logs');
    },
    onSuccess: () => {
      queryClient.setQueryData(['logs'], []);
    },
  });
}
