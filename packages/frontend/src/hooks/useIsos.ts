import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Iso } from '@/types';

export function useIsos() {
  return useQuery({
    queryKey: ['isos'],
    queryFn: async () => {
      const { data } = await api.get<{ isos: Iso[] }>('/api/isos');
      return data.isos;
    },
  });
}

export function useDeleteIso() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (filename: string) => {
      await api.delete(`/api/isos/${encodeURIComponent(filename)}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['isos'] }),
  });
}

export function useRenameIso() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ filename, name }: { filename: string; name: string }) => {
      await api.patch(`/api/isos/${encodeURIComponent(filename)}`, { name });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['isos'] }),
  });
}

export function useUploadIso(onProgress?: (pct: number) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, displayName }: { file: File; displayName?: string }) => {
      const form = new FormData();
      form.append('file', file);
      if (displayName?.trim()) form.append('name', displayName.trim());
      await api.post('/api/isos/upload', form, {
        timeout: 0,
        onUploadProgress: (e) => {
          if (e.total && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
        },
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['isos'] }),
  });
}

export interface DownloadJob {
  filename: string;
  bytesDownloaded: number;
  totalBytes: number;
  status: 'downloading' | 'done' | 'error';
  error?: string;
}

export function useDownloadIsoFromUrl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ url, filename, name }: { url: string; filename?: string; name?: string }) => {
      const { data } = await api.post<{ jobId: string; filename: string }>('/api/isos/download', { url, filename, name });
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['isos'] }),
  });
}
