// Module-level orchestrator for the starter template-set bulk download.
//
// Lives outside any React component so the download loop continues running
// when the user navigates away from the Templates page. Mirrors the pattern
// used for single template/ISO downloads, where the backend keeps streaming
// regardless and the UI just reads job progress from the Zustand store.
//
// Anatomy of one run:
//   1. For each TemplateSetItem in TEMPLATE_SET.templates:
//      a. Skip if user cancelled.
//      b. POST /api/templates/download to start a backend job.
//      c. Pre-assign the OS logo for the resulting filename.
//      d. Poll GET /api/templates/download/:jobId until status leaves
//         'downloading' or the user cancels (in which case DELETE the job).
//      e. Update succeeded/failed counters in the store.
//      f. Invalidate the templates query so the table updates as files land.
//   2. On finish (natural or cancelled), clear the bulk state and emit a
//      summary toast.

import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryClient } from '@/main';
import { TEMPLATE_SET } from '@/data/templateSets';
import { useUploadProgressStore } from '@/store/uploadProgressStore';
import { useLogoStore } from '@/store/logoStore';

interface DownloadJobResponse {
  filename: string;
  bytesDownloaded: number;
  totalBytes: number;
  status: 'downloading' | 'done' | 'error' | 'cancelled';
  error?: string;
}

const POLL_INTERVAL_MS = 800;

export function isTemplateSetDownloadRunning(): boolean {
  return useUploadProgressStore.getState().templateBulk !== null;
}

export async function startTemplateSetDownload(): Promise<void> {
  const store = useUploadProgressStore.getState();
  // One run at a time. If a run is already in flight (e.g. the user navigated
  // away and clicked Download again on remount), bail out silently.
  if (store.templateBulk !== null) return;

  store.setTemplateBulkCancelled(false);

  const items = TEMPLATE_SET.templates;
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i++) {
    if (useUploadProgressStore.getState().templateBulkCancelled) break;
    const item = items[i];

    useUploadProgressStore.getState().setTemplateBulk({
      index: i,
      total: items.length,
      current: item,
      jobId: null,
      job: null,
      succeeded,
      failed,
    });

    let jobId: string | null = null;
    try {
      const { data } = await api.post<{ jobId: string; filename: string }>('/api/templates/download', {
        url: item.url, filename: item.filename, name: item.name,
      });
      jobId = data.jobId;
      useLogoStore.getState().setTemplateLogo(data.filename, item.logo);
      useUploadProgressStore.getState().updateTemplateBulk((b) => b ? { ...b, jobId } : null);
    } catch {
      failed++;
      useUploadProgressStore.getState().updateTemplateBulk((b) => b ? { ...b, failed } : null);
      continue;
    }

    // Poll until this job leaves 'downloading'. Bypasses the single-job
    // activeJob store so the existing manual "From URL" UI stays free for
    // an unrelated download started in parallel.
    while (true) {
      if (useUploadProgressStore.getState().templateBulkCancelled) break;
      try {
        const { data: job } = await api.get<DownloadJobResponse>(`/api/templates/download/${jobId}`);
        useUploadProgressStore.getState().updateTemplateBulk((b) => b ? { ...b, job } : null);
        if (job.status === 'done') { succeeded++; break; }
        if (job.status === 'error') { failed++; break; }
        if (job.status === 'cancelled') break;
      } catch {
        failed++;
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    // If the user cancelled mid-poll, abort the in-flight backend job too.
    if (useUploadProgressStore.getState().templateBulkCancelled && jobId) {
      api.delete(`/api/templates/download/${jobId}`).catch(() => { /* ignore */ });
    }

    queryClient.invalidateQueries({ queryKey: ['templates'] });
  }

  const cancelled = useUploadProgressStore.getState().templateBulkCancelled;
  useUploadProgressStore.getState().setTemplateBulk(null);
  useUploadProgressStore.getState().setTemplateBulkCancelled(false);
  queryClient.invalidateQueries({ queryKey: ['templates'] });

  if (cancelled) {
    toast.info(`Cancelled — ${succeeded} downloaded, ${items.length - succeeded - failed} skipped`);
  } else if (failed === 0) {
    toast.success(`Starter set downloaded — ${succeeded} template${succeeded === 1 ? '' : 's'}`);
  } else if (succeeded === 0) {
    toast.error(`Starter set failed — ${failed} download${failed === 1 ? '' : 's'} failed`);
  } else {
    toast.warning(`Starter set partial — ${succeeded} done, ${failed} failed`);
  }
}

export function cancelTemplateSetDownload(): void {
  useUploadProgressStore.getState().setTemplateBulkCancelled(true);
}
