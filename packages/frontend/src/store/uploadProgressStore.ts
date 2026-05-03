import { create } from 'zustand';
import type { TemplateSetItem } from '@/data/templateSets';

interface JobState {
  filename: string;
  bytesDownloaded: number;
  totalBytes: number;
  status: 'downloading' | 'processing' | 'done' | 'error' | 'cancelled';
  error?: string;
}

interface ActiveJob {
  jobId: string;
  job: JobState;
}

// Per-item state for the starter template-set bulk download. Lives in the
// store (not the component) so the run survives navigation away from the
// Templates page — same pattern as the single-template/single-ISO download
// state above.
export interface TemplateBulkState {
  index: number;             // 0-based index of the item currently being processed
  total: number;
  current: TemplateSetItem;
  jobId: string | null;      // backend job id (for cancel)
  job: JobState | null;      // latest poll result for the current item
  succeeded: number;
  failed: number;
}

interface UploadProgressState {
  templateUploadPct: number | null;
  templateUploadName: string;
  templateActiveJob: ActiveJob | null;
  templateUploadAbort: (() => void) | null;
  isoUploadPct: number | null;
  isoUploadName: string;
  isoActiveJob: ActiveJob | null;
  isoUploadAbort: (() => void) | null;
  templateBulk: TemplateBulkState | null;
  templateBulkCancelled: boolean;

  setTemplateUploadPct: (pct: number | null) => void;
  setTemplateUploadName: (name: string) => void;
  setTemplateActiveJob: (job: ActiveJob | null) => void;
  updateTemplateActiveJob: (updater: (prev: ActiveJob | null) => ActiveJob | null) => void;
  setTemplateUploadAbort: (fn: (() => void) | null) => void;

  setIsoUploadPct: (pct: number | null) => void;
  setIsoUploadName: (name: string) => void;
  setIsoActiveJob: (job: ActiveJob | null) => void;
  updateIsoActiveJob: (updater: (prev: ActiveJob | null) => ActiveJob | null) => void;
  setIsoUploadAbort: (fn: (() => void) | null) => void;

  setTemplateBulk: (b: TemplateBulkState | null) => void;
  updateTemplateBulk: (updater: (prev: TemplateBulkState | null) => TemplateBulkState | null) => void;
  setTemplateBulkCancelled: (cancelled: boolean) => void;
}

export const useUploadProgressStore = create<UploadProgressState>((set) => ({
  templateUploadPct: null,
  templateUploadName: '',
  templateActiveJob: null,
  templateUploadAbort: null,
  isoUploadPct: null,
  isoUploadName: '',
  isoActiveJob: null,
  isoUploadAbort: null,
  templateBulk: null,
  templateBulkCancelled: false,

  setTemplateUploadPct: (pct) => set({ templateUploadPct: pct }),
  setTemplateUploadName: (name) => set({ templateUploadName: name }),
  setTemplateActiveJob: (job) => set({ templateActiveJob: job }),
  updateTemplateActiveJob: (updater) =>
    set((s) => ({ templateActiveJob: updater(s.templateActiveJob) })),
  setTemplateUploadAbort: (fn) => set({ templateUploadAbort: fn }),

  setIsoUploadPct: (pct) => set({ isoUploadPct: pct }),
  setIsoUploadName: (name) => set({ isoUploadName: name }),
  setIsoActiveJob: (job) => set({ isoActiveJob: job }),
  updateIsoActiveJob: (updater) =>
    set((s) => ({ isoActiveJob: updater(s.isoActiveJob) })),
  setIsoUploadAbort: (fn) => set({ isoUploadAbort: fn }),

  setTemplateBulk: (b) => set({ templateBulk: b }),
  updateTemplateBulk: (updater) => set((s) => ({ templateBulk: updater(s.templateBulk) })),
  setTemplateBulkCancelled: (cancelled) => set({ templateBulkCancelled: cancelled }),
}));
