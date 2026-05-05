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
    mutationFn: async ({ file, displayName, storageDirId, signal }: { file: File; displayName?: string; storageDirId?: string; signal?: AbortSignal }) => {
      const form = new FormData();
      form.append('file', file);
      if (displayName?.trim()) form.append('name', displayName.trim());
      if (storageDirId) form.append('storageDirId', storageDirId);
      await api.post('/api/isos/upload', form, {
        timeout: 0,
        signal,
        onUploadProgress: (e) => {
          if (e.total && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['isos'] });
      qc.invalidateQueries({ queryKey: ['storage-dirs'] });
    },
  });
}

export interface DownloadJob {
  filename: string;
  bytesDownloaded: number;
  totalBytes: number;
  status: 'downloading' | 'processing' | 'done' | 'error' | 'cancelled';
  error?: string;
}

export function useDownloadIsoFromUrl() {
  return useMutation({
    mutationFn: async ({ url, filename, name, storageDirId }: { url: string; filename?: string; name?: string; storageDirId?: string }) => {
      const { data } = await api.post<{ jobId: string; filename: string }>('/api/isos/download', { url, filename, name, storageDirId });
      return data;
    },
  });
}

export function useCancelIsoDownload() {
  return useMutation({
    mutationFn: async (jobId: string) => {
      await api.delete(`/api/isos/download/${jobId}`);
    },
  });
}

export function useMoveIso() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ filename, storageDirId }: { filename: string; storageDirId: string }) => {
      await api.post(`/api/isos/${encodeURIComponent(filename)}/move`, { storageDirId });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['isos'] });
      qc.invalidateQueries({ queryKey: ['storage-dirs'] });
    },
  });
}
