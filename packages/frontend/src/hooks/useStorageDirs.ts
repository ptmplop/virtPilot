import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { StorageDir, StorageDirPurpose, StorageDirWithUsage } from '@/types';

export function useStorageDirs() {
  return useQuery({
    queryKey: ['storage-dirs'],
    queryFn: async () => {
      const { data } = await api.get<{ dirs: StorageDirWithUsage[] }>('/api/storage/dirs');
      return data.dirs;
    },
  });
}

interface SetDefault {
  templates?: boolean;
  isos?: boolean;
  vmDisks?: boolean;
}

export function useCreateStorageDir() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; path: string; purposes: StorageDirPurpose[]; setDefault?: SetDefault }) => {
      const { data } = await api.post<{ dir: StorageDir }>('/api/storage/dirs', input);
      return data.dir;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['storage-dirs'] });
      qc.invalidateQueries({ queryKey: ['templates'] });
      qc.invalidateQueries({ queryKey: ['isos'] });
    },
  });
}

export function useUpdateStorageDir() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...input }: { id: string; name?: string; purposes?: StorageDirPurpose[]; setDefault?: SetDefault }) => {
      const { data } = await api.patch<{ dir: StorageDir }>(`/api/storage/dirs/${id}`, input);
      return data.dir;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['storage-dirs'] });
      qc.invalidateQueries({ queryKey: ['templates'] });
      qc.invalidateQueries({ queryKey: ['isos'] });
    },
  });
}

export function useDeleteStorageDir() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/storage/dirs/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['storage-dirs'] });
    },
  });
}
