import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface SshKey {
  id: string;
  name: string;
  publicKey: string;
  createdAt: string;
}

export function useSshKeys() {
  return useQuery({
    queryKey: ['ssh-keys'],
    queryFn: async () => {
      const { data } = await api.get<{ keys: SshKey[] }>('/api/ssh-keys');
      return data.keys;
    },
  });
}

export function useAddSshKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { name: string; publicKey: string }) => {
      const { data } = await api.post<{ key: SshKey }>('/api/ssh-keys', payload);
      return data.key;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ssh-keys'] }),
  });
}

export function useDeleteSshKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/ssh-keys/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ssh-keys'] }),
  });
}
