import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Template } from '@/types';

export function useTemplates() {
  return useQuery({
    queryKey: ['templates'],
    queryFn: async () => {
      const { data } = await api.get<{ templates: Template[] }>('/api/templates');
      return data.templates;
    },
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (filename: string) => {
      await api.delete(`/api/templates/${encodeURIComponent(filename)}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  });
}

export function useRenameTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ filename, name }: { filename: string; name: string }) => {
      await api.patch(`/api/templates/${encodeURIComponent(filename)}`, { name });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  });
}

export function useUploadTemplate(onProgress?: (pct: number) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, displayName, signal }: { file: File; displayName?: string; signal?: AbortSignal }) => {
      const form = new FormData();
      form.append('file', file);
      if (displayName?.trim()) form.append('name', displayName.trim());
      await api.post('/api/templates/upload', form, {
        timeout: 0,
        signal,
        onUploadProgress: (e) => {
          if (e.total && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
        },
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  });
}

export interface DownloadJob {
  filename: string;
  bytesDownloaded: number;
  totalBytes: number;
  status: 'downloading' | 'done' | 'error' | 'cancelled';
  error?: string;
}

export function useDownloadTemplateFromUrl() {
  return useMutation({
    mutationFn: async ({ url, filename, name }: { url: string; filename?: string; name?: string }) => {
      const { data } = await api.post<{ jobId: string; filename: string }>('/api/templates/download', { url, filename, name });
      return data;
    },
  });
}

export function useCancelTemplateDownload() {
  return useMutation({
    mutationFn: async (jobId: string) => {
      await api.delete(`/api/templates/download/${jobId}`);
    },
  });
}
