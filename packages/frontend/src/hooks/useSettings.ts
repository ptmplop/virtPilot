import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Settings } from '@/types';

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const { data } = await api.get<{ settings: Settings }>('/api/settings');
      return data.settings;
    },
  });
}

export function useDismissTemplateSet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.put('/api/settings', { templateSetDismissed: true });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
}
