import { useQuery } from '@tanstack/react-query';
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
