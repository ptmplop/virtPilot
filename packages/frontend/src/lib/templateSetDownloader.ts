// Module-level orchestrator for the starter template-set bulk download.
//
// Lives outside any React component so the download loop continues running
// when the user navigates away from the Templates page. Bulk state is
// persisted to localStorage by `uploadProgressStore`, so the run also
// survives a full page reload, tab close + reopen, or browser restart —
// `resumeTemplateSetDownloadIfNeeded` (called from App.tsx on mount) picks
// up where we left off.
//
// Anatomy of one run:
//   1. Snapshot existing templates so we don't re-download anything that
//      already landed (e.g. a successful download whose state-write was
//      lost when the page died, or a manual upload of the same filename).
//   2. For each TemplateSetItem from the configured starting index:
//      a. Skip if user cancelled.
//      b. Skip if filename already exists on disk (count as succeeded).
//      c. POST /api/templates/download to start a backend job.
//      d. Pre-assign the OS logo for the resulting filename.
//      e. Poll GET /api/templates/download/:jobId until status leaves
//         'downloading' or the user cancels (in which case DELETE the job).
//      f. Update succeeded/failed counters in the store.
//      g. Invalidate the templates query so the table updates as files land.
//   3. On finish (natural or cancelled), clear the bulk state and emit a
//      summary toast.

import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryClient } from '@/main';
import { TEMPLATE_SET, type TemplateSetItem } from '@/data/templateSets';
import { useUploadProgressStore } from '@/store/uploadProgressStore';
import { useLogoStore } from '@/store/logoStore';
import type { Template } from '@/types';

interface DownloadJobResponse {
  filename: string;
  bytesDownloaded: number;
  totalBytes: number;
  status: 'downloading' | 'done' | 'error' | 'cancelled';
  error?: string;
}

const POLL_INTERVAL_MS = 800;
// Per-item retry policy for transient failures (TLS handshake blip, mirror
// momentarily 5xx, redirector-of-the-day pointing at a half-broken mirror).
// 3 attempts total with a brief backoff — most transient issues resolve in
// well under a minute.
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 5_000;

// Single-instance guard. Without this, `resumeTemplateSetDownloadIfNeeded`
// firing on App mount and the user clicking "Download starter set" could
// both spin up loops in parallel — racing each other and double-counting.
let orchestratorRunning = false;

// ...but the flag is per-document while the state it guards is in
// localStorage, shared origin-wide. Opening the VM console in a popup (or just
// a second tab) mounts ProtectedRoute, which calls
// `resumeTemplateSetDownloadIfNeeded` in a document where the flag is false —
// so two orchestrators pick up the same persisted run and race each other.
// Web Locks are shared across same-origin documents, so a named lock is the
// only cross-document guard available to us.
const LOCK_NAME = 'virtpilot-template-set';

export function isTemplateSetDownloadRunning(): boolean {
  return orchestratorRunning || useUploadProgressStore.getState().templateBulk !== null;
}

async function fetchExistingFilenames(): Promise<Set<string>> {
  try {
    const { data } = await api.get<{ templates: Template[] }>('/api/templates');
    return new Set(data.templates.map((t) => t.filename));
  } catch {
    // Worst case: we re-issue a download for a file that's already there.
    // The backend now refuses to clobber an existing template and answers
    // 409 — `downloadOne` treats that as success (the file we wanted is on
    // disk), so the only cost is one wasted round-trip.
    return new Set();
  }
}

export async function startTemplateSetDownload(): Promise<void> {
  if (orchestratorRunning) return;
  orchestratorRunning = true;
  try {
    await withCrossDocumentLock(runOrchestrator);
  } finally {
    orchestratorRunning = false;
  }
}

// `ifAvailable` makes the losing document bail immediately rather than queue
// behind the winner and re-run the whole set once it finishes.
//
// Caveat: navigator.locks is a secure-context API, and VirtPilot is commonly
// served over plain HTTP on a LAN IP where it's simply undefined. There we
// fall back to the module flag alone, which does nothing across documents —
// the backend downloading to a job-unique temp path is what actually keeps a
// concurrent run from clobbering the file.
async function withCrossDocumentLock(fn: () => Promise<void>): Promise<void> {
  if (!navigator.locks) return fn();
  await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    await fn();
  });
}

export async function resumeTemplateSetDownloadIfNeeded(): Promise<void> {
  // Called from App.tsx on mount. If a run was in-flight when the page died,
  // localStorage will have a non-null templateBulk and we pick it back up.
  if (orchestratorRunning) return;
  if (useUploadProgressStore.getState().templateBulk === null) return;
  await startTemplateSetDownload();
}

export function cancelTemplateSetDownload(): void {
  useUploadProgressStore.getState().setTemplateBulkCancelled(true);
}

async function runOrchestrator(): Promise<void> {
  const items = TEMPLATE_SET.templates;
  const store = useUploadProgressStore.getState();
  store.setTemplateBulkCancelled(false);

  // Resume vs fresh start. The persisted `templateBulk.index` is the item we
  // were processing when the page died; `succeeded`/`failed` are the totals
  // for items 0..index-1 (we update them at the *start* of each iteration so
  // they're always one-behind on the in-flight item).
  const resuming = store.templateBulk;
  let startIndex = resuming?.index ?? 0;
  let succeeded = resuming?.succeeded ?? 0;
  let failed = resuming?.failed ?? 0;

  // If the persisted index is past the end of the current set (config got
  // shorter between runs), discard the stale state and bail out.
  if (startIndex >= items.length) {
    store.setTemplateBulk(null);
    return;
  }

  const existingBefore = await fetchExistingFilenames();
  const failures: { name: string; reason: string }[] = [];

  for (let i = startIndex; i < items.length; i++) {
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

    // Skip items already on disk. Covers two cases: (1) the resumed item
    // actually finished downloading right before the page died, and (2) the
    // user has manually uploaded a file with the same name.
    if (existingBefore.has(item.filename)) {
      succeeded++;
      useUploadProgressStore.getState().updateTemplateBulk((b) => b ? { ...b, succeeded } : null);
      continue;
    }

    const result = await downloadWithRetries(item);
    if (result.ok) {
      succeeded++;
    } else {
      failed++;
      failures.push({ name: item.name, reason: result.error ?? 'unknown error' });
    }

    useUploadProgressStore.getState().updateTemplateBulk((b) => b ? { ...b, succeeded, failed } : null);
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
  } else {
    // Stick the failure summary on screen until the user dismisses it — the
    // default 3.5s duration was too short to read and easy to miss while on
    // another page. Include each failed item with its reason so the user
    // doesn't have to dig through journalctl to figure out what happened.
    const description = failures.map((f) => `${f.name}: ${f.reason}`).join('\n');
    const headline = succeeded === 0
      ? `Starter set failed — ${failed} download${failed === 1 ? '' : 's'} failed`
      : `Starter set partial — ${succeeded} done, ${failed} failed`;
    if (succeeded === 0) {
      toast.error(headline, { description, duration: Infinity });
    } else {
      toast.warning(headline, { description, duration: Infinity });
    }
  }
}

// Result of one (possibly retried) per-item download attempt.
type ItemResult = { ok: true } | { ok: false; error: string; cancelled?: boolean };

// Wrap downloadOne with bounded retries for transient failures (TLS handshake
// blip, mirror momentarily 5xx, redirector-of-the-day pointing at a half-
// broken mirror). Cancelled bulk runs short-circuit immediately — we don't
// keep retrying after the user hit Cancel.
async function downloadWithRetries(item: TemplateSetItem): Promise<ItemResult> {
  let last: ItemResult = { ok: false, error: 'no attempt made' };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (useUploadProgressStore.getState().templateBulkCancelled) return { ok: false, error: 'cancelled', cancelled: true };
    last = await downloadOne(item);
    if (last.ok) return last;
    if (last.cancelled) return last;
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    }
  }
  return last;
}

// Single-attempt download. Manages the per-item store updates (jobId, job
// progress) so the card can render live progress, and returns the failure
// reason from the backend (job.error) when one is available.
async function downloadOne(item: TemplateSetItem): Promise<ItemResult> {
  let jobId: string | null = null;
  try {
    const { data } = await api.post<{ jobId: string; filename: string }>('/api/templates/download', {
      url: item.url, filename: item.filename, name: item.name,
    });
    jobId = data.jobId;
    useLogoStore.getState().setTemplateLogo(data.filename, item.logo);
    useUploadProgressStore.getState().updateTemplateBulk((b) => b ? { ...b, jobId } : null);
  } catch (err: unknown) {
    // 409 = the destination filename is already on disk. For the starter set
    // that is exactly the desired end state, so count it as a success rather
    // than burning three retries and reporting a failure. The pre-flight
    // filename snapshot catches most of these; this covers the cases it
    // can't (listing failed, or a file landed mid-run).
    if (isConflict(err)) return { ok: true };
    return { ok: false, error: extractApiError(err, 'failed to start download') };
  }

  // Poll until this job leaves 'downloading'. Bypasses the single-job
  // activeJob store so the existing manual "From URL" UI stays free for
  // an unrelated download started in parallel.
  while (true) {
    if (useUploadProgressStore.getState().templateBulkCancelled) {
      if (jobId) api.delete(`/api/templates/download/${jobId}`).catch(() => { /* ignore */ });
      return { ok: false, error: 'cancelled', cancelled: true };
    }
    try {
      const { data: job } = await api.get<DownloadJobResponse>(`/api/templates/download/${jobId}`);
      useUploadProgressStore.getState().updateTemplateBulk((b) => b ? { ...b, job } : null);
      if (job.status === 'done') return { ok: true };
      if (job.status === 'error') return { ok: false, error: job.error ?? 'download failed' };
      if (job.status === 'cancelled') return { ok: false, error: 'cancelled', cancelled: true };
    } catch (err: unknown) {
      // Includes 404 if the backend was restarted mid-download and dropped
      // the in-memory job map.
      return { ok: false, error: extractApiError(err, 'lost contact with backend mid-download') };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

function isConflict(err: unknown): boolean {
  return !!err && typeof err === 'object'
    && (err as { response?: { status?: number } }).response?.status === 409;
}

function extractApiError(err: unknown, fallback: string): string {
  if (err && typeof err === 'object') {
    const e = err as { response?: { data?: { error?: string } }; message?: string };
    return e.response?.data?.error ?? e.message ?? fallback;
  }
  return fallback;
}
