import { create } from 'zustand';

interface JobState {
  filename: string;
  bytesDownloaded: number;
  totalBytes: number;
  status: 'downloading' | 'done' | 'error';
  error?: string;
}

interface ActiveJob {
  jobId: string;
  job: JobState;
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
}));
