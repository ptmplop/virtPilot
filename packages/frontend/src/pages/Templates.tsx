import { useRef, useState, useEffect, useCallback } from 'react';
import { Download, HardDrive, PackageOpen, Pencil, Trash2, Upload, X, FolderInput } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Layout } from '@/components/layout/Layout';
import { formatDate, formatBytes } from '@/lib/format';
import { Stat, StatStrip } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { StorageDirSelect } from '@/components/StorageDirSelect';
import { api } from '@/lib/api';
import {
  useTemplates, useDeleteTemplate, useUploadTemplate, useRenameTemplate,
  useDownloadTemplateFromUrl, useCancelTemplateDownload, useMoveTemplate, type DownloadJob,
} from '@/hooks/useTemplates';
import { MoveDialog } from '@/components/MoveDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import { useSettings, useDismissTemplateSet } from '@/hooks/useSettings';
import { OsLogoPicker, VmLogo } from '@/components/ui/OsLogoPicker';
import { useLogoStore } from '@/store/logoStore';
import { useUploadProgressStore, type TemplateBulkState } from '@/store/uploadProgressStore';
import { TEMPLATE_SET } from '@/data/templateSets';
import { startTemplateSetDownload, cancelTemplateSetDownload } from '@/lib/templateSetDownloader';

function ProgressBar({ pct, indeterminate = false }: { pct?: number; indeterminate?: boolean }) {
  return (
    <div className="relative h-[5px] w-full overflow-hidden rounded-[2px] bg-gauge-track">
      {indeterminate ? (
        <div className="absolute inset-y-0 left-0 w-1/3 animate-[vp-progress_1.4s_ease-in-out_infinite] bg-[#4F7CAC] dark:bg-[#86AEDA]" />
      ) : (
        <div
          className="h-full bg-[#4F7CAC] transition-[width] duration-200 dark:bg-[#86AEDA]"
          style={{ width: `${pct ?? 0}%` }}
        />
      )}
    </div>
  );
}

function InlineName({
  filename,
  name,
}: {
  filename: string;
  name: string;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const renameTemplate = useRenameTemplate();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setValue(name); }, [name]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === name) { setEditing(false); setValue(name); return; }
    try {
      await renameTemplate.mutateAsync({ filename, name: trimmed });
      toast.success('Renamed');
    } catch {
      toast.error('Failed to rename');
      setValue(name);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setEditing(false); setValue(name); } }}
        className="w-full rounded border border-primary bg-transparent px-1 py-0.5 text-sm font-semibold text-foreground outline-none ring-1 ring-primary"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="group flex items-center gap-1.5 text-left"
    >
      <span className="text-sm font-semibold text-foreground">{name}</span>
      <Pencil size={11} className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

// ─── Starter template-set card ─────────────────────────────────────────────────
//
// Surfaced when the templates directory is empty (and the user hasn't dismissed
// the card). Sequentially downloads every entry in TEMPLATE_SET via the same
// background-download endpoint as the manual "From URL" flow — one at a time,
// so the user can keep working while it churns through the list. The bulk run
// is orchestrated by `lib/templateSetDownloader.ts` (module-level) with state
// in `uploadProgressStore`, so it survives navigation away from this page.

function TemplateSetCard({
  templatesEmpty,
  bulk,
  onStart,
  onCancel,
  onDismiss,
}: {
  templatesEmpty: boolean;
  bulk: TemplateBulkState | null;
  onStart: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const items = TEMPLATE_SET.templates;
  const downloading = bulk !== null;
  const pct = bulk?.job?.totalBytes
    ? Math.round((bulk.job.bytesDownloaded / bulk.job.totalBytes) * 100)
    : undefined;

  return (
    <div className="group relative mb-6 overflow-hidden rounded-xl border border-border shadow-airy transition-all duration-300 ease-out">

      {/* Dismiss button */}
      {!downloading && (
        <button
          type="button"
          onClick={onDismiss}
          title="Hide this card"
          className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X size={14} />
        </button>
      )}

      <div className="relative px-6 py-5">
        <div className="flex items-start gap-4">
          <PackageOpen className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[12.5px] font-medium text-muted-foreground">
                {templatesEmpty ? 'New install' : 'Starter set'}
              </span>
            </div>
            <p className="mt-1 text-[15px] font-semibold tracking-[-0.01em] text-foreground">
              {TEMPLATE_SET.name}
            </p>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {TEMPLATE_SET.description} {items.length} image{items.length === 1 ? '' : 's'}.
            </p>

            {/* Logo strip */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {items.map((t) => (
                <div key={t.filename} className="flex items-center gap-1.5 pr-2">
                  <VmLogo slug={t.logo} size={16} />
                  <span className="text-[12.5px] text-muted-foreground">{t.name}</span>
                </div>
              ))}
            </div>

            {/* Action row or progress */}
            {!downloading ? (
              <div className="mt-4">
                <Button size="sm" onClick={onStart}>
                  <Download size={13} /> Download starter set
                </Button>
              </div>
            ) : (
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="flex items-center gap-2 text-foreground">
                    <Spinner className="h-3 w-3" />
                    <span className="font-medium">
                      Downloading {bulk.index + 1} of {bulk.total}
                    </span>
                    <span className="truncate text-muted-foreground">— {bulk.current.name}</span>
                  </span>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="font-mono text-muted-foreground">
                      {pct !== undefined ? `${pct}%` : '…'}
                    </span>
                    <button
                      type="button"
                      onClick={onCancel}
                      title="Cancel remaining downloads"
                      aria-label="Cancel remaining downloads"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <X size={13} />
                    </button>
                  </div>
                </div>
                <ProgressBar pct={pct} indeterminate={pct === undefined} />
                {(bulk.succeeded > 0 || bulk.failed > 0) && (
                  <p className="text-[11px] text-muted-foreground">
                    {bulk.succeeded > 0 && <span className="text-emerald-600 dark:text-emerald-400">{bulk.succeeded} done</span>}
                    {bulk.succeeded > 0 && bulk.failed > 0 && ' · '}
                    {bulk.failed > 0 && <span className="text-amber-700 dark:text-amber-300">{bulk.failed} failed</span>}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function TemplatesPage() {
  const { data: templates, isLoading } = useTemplates();
  const deleteTemplate = useDeleteTemplate();
  const moveTemplate = useMoveTemplate();
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<{ filename: string; storageDirId: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { templates: templateLogos, setTemplateLogo } = useLogoStore();
  const [logoTarget, setLogoTarget] = useState<string | null>(null);

  const {
    templateUploadPct: uploadPct,
    templateUploadName: uploadingName,
    templateActiveJob: activeJob,
    templateUploadAbort: uploadAbort,
    setTemplateUploadPct: setUploadPct,
    setTemplateUploadName: setUploadingName,
    setTemplateActiveJob: setActiveJob,
    updateTemplateActiveJob: updateActiveJob,
    setTemplateUploadAbort: setUploadAbort,
  } = useUploadProgressStore();

  // Upload flow: pick file → name dialog → upload
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploadDisplayName, setUploadDisplayName] = useState('');
  const [uploadLogoSlug, setUploadLogoSlug] = useState<string | null>(null);
  const [uploadStorageDirId, setUploadStorageDirId] = useState('');
  const uploadTemplate = useUploadTemplate((pct) => setUploadPct(pct));

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingFile(file);
    setUploadDisplayName(file.name.replace(/\.(qcow2|img)$/i, ''));
    setUploadLogoSlug(null);
    e.target.value = '';
  };

  const handleUploadConfirm = async () => {
    if (!pendingFile) return;
    const file = pendingFile;
    const displayName = uploadDisplayName.trim() || file.name.replace(/\.(qcow2|img)$/i, '');
    const logoSlug = uploadLogoSlug;
    const ac = new AbortController();
    setPendingFile(null);
    setUploadLogoSlug(null);
    setUploadingName(displayName || file.name);
    setUploadPct(0);
    setUploadAbort(ac.abort.bind(ac));
    try {
      await uploadTemplate.mutateAsync({ file, displayName, storageDirId: uploadStorageDirId || undefined, signal: ac.signal });
      if (logoSlug) setTemplateLogo(file.name, logoSlug);
      toast.success(`${displayName || file.name} uploaded`);
    } catch (err: unknown) {
      if (ac.signal.aborted) {
        toast.info('Upload cancelled');
      } else {
        // Surface the backend's message verbatim — a 409 names the exact
        // filename already on disk, which the operator cannot guess from a
        // generic "Upload failed".
        toast.error(
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Upload failed'
        );
      }
    } finally {
      setUploadPct(null);
      setUploadingName('');
      setUploadAbort(null);
    }
  };

  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState('');
  const [downloadFilename, setDownloadFilename] = useState('');
  const [downloadDisplayName, setDownloadDisplayName] = useState('');
  const [downloadLogoSlug, setDownloadLogoSlug] = useState<string | null>(null);
  const [downloadStorageDirId, setDownloadStorageDirId] = useState('');
  const downloadFromUrl = useDownloadTemplateFromUrl();
  const cancelDownload = useCancelTemplateDownload();
  const qc = useQueryClient();

  const resetUrlDialog = () => {
    setUrlDialogOpen(false);
    setDownloadUrl('');
    setDownloadFilename('');
    setDownloadDisplayName('');
    setDownloadLogoSlug(null);
    setDownloadStorageDirId('');
  };

  const handleUrlDownload = async () => {
    try {
      const result = await downloadFromUrl.mutateAsync({
        url: downloadUrl,
        filename: downloadFilename || undefined,
        name: downloadDisplayName || undefined,
        storageDirId: downloadStorageDirId || undefined,
      });
      if (downloadLogoSlug) setTemplateLogo(result.filename, downloadLogoSlug);
      resetUrlDialog();
      setActiveJob({ jobId: result.jobId, job: { filename: result.filename, bytesDownloaded: 0, totalBytes: 0, status: 'downloading' } });
    } catch (err: unknown) {
      // 409 here means the resolved filename already exists — show which one.
      toast.error(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to start download'
      );
    }
  };

  const pollJob = useCallback(async (jobId: string) => {
    try {
      const { data } = await api.get<DownloadJob>(`/api/templates/download/${jobId}`);
      updateActiveJob((prev) => prev ? { ...prev, job: data } : null);
      if (data.status === 'done') {
        toast.success(`${data.filename} downloaded`);
        qc.invalidateQueries({ queryKey: ['templates'] });
        setActiveJob(null);
      } else if (data.status === 'error') {
        toast.error(`Download failed: ${data.error}`);
        setActiveJob(null);
      } else if (data.status === 'cancelled') {
        toast.info('Download cancelled');
        setActiveJob(null);
      }
    } catch {
      setActiveJob(null);
    }
  }, [qc, updateActiveJob, setActiveJob]);

  useEffect(() => {
    if (!activeJob || activeJob.job.status !== 'downloading') return;
    const id = setInterval(() => pollJob(activeJob.jobId), 800);
    return () => clearInterval(id);
  }, [activeJob, pollJob]);

  // ── Starter template-set card ────────────────────────────────────────────
  // Bulk-download state lives in the upload-progress store (not local React
  // state) so the run continues when the user navigates away and the
  // orchestration loop in `templateSetDownloader.ts` can keep running across
  // unmounts. The card just renders whatever the store says.
  const { data: settings } = useSettings();
  const dismissTemplateSet = useDismissTemplateSet();
  const bulk = useUploadProgressStore((s) => s.templateBulk);

  // Show the card while:
  //   - a bulk run is in flight (so progress UI doesn't vanish mid-download), OR
  //   - the user has zero templates AND hasn't dismissed it. The empty-state
  //     gate keeps the card out of the way once a user has any templates of
  //     their own — even if they haven't downloaded the full starter set.
  const templatesCount = templates?.length ?? 0;
  const showTemplateSet = bulk !== null
    || (!isLoading && templatesCount === 0 && settings?.templateSetDismissed === false);

  // Reset the dismiss flag whenever templates count is non-zero, so the card
  // re-appears next time the user empties the templates list. Otherwise the
  // flag is sticky forever once set, even after a full reset of the library.
  useEffect(() => {
    if (settings?.templateSetDismissed && templatesCount > 0) {
      void api.put('/api/settings', { templateSetDismissed: false })
        .then(() => qc.invalidateQueries({ queryKey: ['settings'] }));
    }
  }, [settings?.templateSetDismissed, templatesCount, qc]);

  const startBulkDownload = useCallback(() => {
    void startTemplateSetDownload();
  }, []);

  const cancelBulkDownload = useCallback(() => {
    cancelTemplateSetDownload();
  }, []);

  const handleDismissTemplateSet = useCallback(() => {
    dismissTemplateSet.mutate(undefined, {
      onError: () => toast.error('Failed to hide card'),
    });
  }, [dismissTemplateSet]);

  const totalTemplateGb = templates?.reduce((s, t) => s + t.sizeGb, 0) ?? 0;

  const downloadPct = activeJob?.job.totalBytes
    ? Math.round((activeJob.job.bytesDownloaded / activeJob.job.totalBytes) * 100)
    : undefined;

  return (
    <Layout
      title="Templates"
      subtitle="Base images (qcow2) that new VMs are built from."
      actions={
        <>
          <input ref={fileRef} type="file" accept=".qcow2,.img" className="hidden" onChange={handleFilePick} />
          <Button variant="secondary" onClick={() => setUrlDialogOpen(true)}>
            <Download size={14} /> From URL
          </Button>
          <Button onClick={() => fileRef.current?.click()} disabled={uploadTemplate.isPending}>
            {uploadTemplate.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Upload size={14} />}
            Upload template
          </Button>
        </>
      }
    >
      {/* Stats */}
      <StatStrip className="mb-6">
        <Stat label="Templates" value={isLoading ? '—' : String(templates?.length ?? 0)} />
        <Stat label="Total size" value={isLoading ? '—' : `${totalTemplateGb.toFixed(1)} GB`} />
      </StatStrip>

      {/* Starter template-set card (new installs only — auto-hides once any template exists or is dismissed) */}
      {showTemplateSet && (
        <TemplateSetCard
          templatesEmpty={(templates?.length ?? 0) === 0}
          bulk={bulk}
          onStart={startBulkDownload}
          onCancel={cancelBulkDownload}
          onDismiss={handleDismissTemplateSet}
        />
      )}

      {/* Upload progress */}
      {uploadPct !== null && (
        <div className="mb-5 rounded-xl border border-border bg-card px-5 py-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="max-w-xs truncate text-xs font-medium text-foreground">{uploadingName}</span>
            <div className="ml-4 flex shrink-0 items-center gap-3">
              <span className="font-mono text-xs text-muted-foreground">{uploadPct}%</span>
              {uploadAbort && (
                <button
                  type="button"
                  onClick={() => uploadAbort()}
                  title="Cancel upload"
                  className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
          <ProgressBar pct={uploadPct} />
        </div>
      )}

      {/* URL download progress */}
      {activeJob && (
        <div className="mb-5 rounded-xl border border-border bg-card px-5 py-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-2 text-xs font-medium text-foreground">
              <Spinner className="h-3 w-3" />
              Downloading {activeJob.job.filename}
            </span>
            <div className="ml-4 flex shrink-0 items-center gap-3">
              <span className="font-mono text-xs text-muted-foreground">
                {activeJob.job.totalBytes > 0
                  ? `${formatBytes(activeJob.job.bytesDownloaded)} / ${formatBytes(activeJob.job.totalBytes)}`
                  : formatBytes(activeJob.job.bytesDownloaded)}
              </span>
              <button
                type="button"
                onClick={() => cancelDownload.mutate(activeJob.jobId)}
                title="Cancel download"
                className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <X size={12} />
              </button>
            </div>
          </div>
          <ProgressBar pct={downloadPct} indeterminate={downloadPct === undefined} />
        </div>
      )}

      {/* Template list */}
      <div className="panel overflow-hidden">
        {isLoading ? (
          <div className="space-y-px p-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-[60px] rounded-lg" />)}
          </div>
        ) : !templates?.length ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <HardDrive className="mb-3 h-5 w-5 text-muted-foreground" />
            <p className="text-sm font-semibold text-foreground">No templates yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Upload a .qcow2 cloud image or download one from a URL.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="table-head">
                {['Name', 'File', 'Location', 'Size', 'Added', ''].map((h) => (
                  <th
                    key={h}
                    className={`px-5 py-2.5 text-[12px] font-medium text-muted-foreground ${h === '' ? 'text-right' : 'text-left'} ${h === 'File' ? 'hidden xl:table-cell' : ''}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {templates.map((t) => (
                <tr key={t.filename} className="transition-colors hover:bg-surface/70">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        title="Change logo"
                        onClick={() => setLogoTarget(t.filename)}
                        className="group relative shrink-0 rounded-md"
                      >
                        <VmLogo slug={templateLogos[t.filename]} size={24} />
                        <div className="absolute inset-0 flex items-center justify-center rounded-md bg-black/0 transition-colors group-hover:bg-black/40">
                          <Pencil size={9} className="text-white opacity-0 transition-opacity group-hover:opacity-100" />
                        </div>
                      </button>
                      <InlineName filename={t.filename} name={t.name} />
                    </div>
                  </td>
                  <td className="hidden px-5 py-3 font-mono text-xs text-muted-foreground xl:table-cell">{t.filename}</td>
                  <td className="whitespace-nowrap px-5 py-3 text-[12.5px] text-muted-foreground">{t.storageDirName}</td>
                  <td className="whitespace-nowrap px-5 py-3 font-mono text-xs tabular-nums text-muted-foreground">{t.sizeGb} GB</td>
                  <td className="whitespace-nowrap px-5 py-3 text-[12.5px] text-muted-foreground">
                    {formatDate(t.createdAt)}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="inline-flex items-center gap-1">
                      <Tooltip label="Move to another storage directory">
                        <button
                          type="button"
                          onClick={() => setMoveTarget({ filename: t.filename, storageDirId: t.storageDirId })}
                          aria-label={`Move ${t.name} to another storage directory`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <FolderInput size={13} />
                        </button>
                      </Tooltip>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(t.filename)}
                        aria-label={`Delete ${t.name}`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Upload name dialog */}
      <Dialog
        open={pendingFile !== null}
        onClose={() => { setPendingFile(null); setUploadDisplayName(''); setUploadLogoSlug(null); }}
        title="Name this template"
        size="md"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => { setPendingFile(null); setUploadDisplayName(''); setUploadLogoSlug(null); }}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleUploadConfirm} disabled={uploadTemplate.isPending}>
              <Upload size={13} /> Upload
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Display name"
            value={uploadDisplayName}
            onChange={(e) => setUploadDisplayName(e.target.value)}
            placeholder="e.g. Debian 13 Generic"
          />
          <StorageDirSelect purpose="templates" value={uploadStorageDirId} onChange={setUploadStorageDirId} />
          <p className="text-xs text-muted-foreground">
            File: <span className="font-mono">{pendingFile?.name}</span>
          </p>
          <OsLogoPicker value={uploadLogoSlug} onChange={setUploadLogoSlug} />
        </div>
      </Dialog>

      {/* Download from URL dialog */}
      <Dialog
        open={urlDialogOpen}
        onClose={resetUrlDialog}
        title="Download template from URL"
        description="The server will fetch the file directly. Supports HTTP and HTTPS with redirects."
        size="md"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={resetUrlDialog}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!downloadUrl.trim() || downloadFromUrl.isPending}
              onClick={handleUrlDownload}
            >
              {downloadFromUrl.isPending
                ? <><Spinner className="h-3.5 w-3.5" /> Starting…</>
                : <><Download size={13} /> Download</>}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="URL"
            type="url"
            value={downloadUrl}
            onChange={(e) => setDownloadUrl(e.target.value)}
            placeholder="https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img"
            required
          />
          <Input
            label="Display name (optional)"
            value={downloadDisplayName}
            onChange={(e) => setDownloadDisplayName(e.target.value)}
            placeholder="e.g. Ubuntu 24.04 Noble"
          />
          <Input
            label="Filename on disk (optional)"
            value={downloadFilename}
            onChange={(e) => setDownloadFilename(e.target.value)}
            placeholder="ubuntu-24.04.qcow2"
          />
          <StorageDirSelect purpose="templates" value={downloadStorageDirId} onChange={setDownloadStorageDirId} />
          <OsLogoPicker value={downloadLogoSlug} onChange={setDownloadLogoSlug} />
        </div>
      </Dialog>

      {/* Logo picker dialog */}
      <Dialog
        open={logoTarget !== null}
        onClose={() => setLogoTarget(null)}
        title="Change logo"
        size="sm"
        footer={
          <Button variant="secondary" size="sm" onClick={() => setLogoTarget(null)}>Done</Button>
        }
      >
        <OsLogoPicker
          value={logoTarget ? (templateLogos[logoTarget] ?? null) : null}
          onChange={(slug) => {
            if (logoTarget) setTemplateLogo(logoTarget, slug);
            setLogoTarget(null);
          }}
        />
      </Dialog>

      <MoveDialog
        open={moveTarget !== null}
        onClose={() => setMoveTarget(null)}
        itemLabel={moveTarget?.filename ?? ''}
        purpose="templates"
        currentStorageDirId={moveTarget?.storageDirId ?? ''}
        notes={
          <>
            Templates are referenced by absolute path in every VM's qcow2 backing chain. Moving a template
            that's already used as a backing image will be refused; delete those VMs first or leave the template in place.
          </>
        }
        busy={moveTemplate.isPending}
        onMove={async (storageDirId) => {
          if (!moveTarget) return;
          await moveTemplate.mutateAsync({ filename: moveTarget.filename, storageDirId });
        }}
      />

      {/* Delete confirm dialog */}
      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete template"
        description={`Remove ${deleteTarget} from the templates directory?`}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="danger"
              size="sm"
              disabled={deleteTemplate.isPending}
              onClick={async () => {
                if (!deleteTarget) return;
                try {
                  await deleteTemplate.mutateAsync(deleteTarget);
                  toast.success('Template deleted');
                  setDeleteTarget(null);
                } catch { toast.error('Failed to delete'); }
              }}
            >
              {deleteTemplate.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-foreground">
          This cannot be undone. VMs already created from this template are not affected.
        </p>
      </Dialog>
    </Layout>
  );
}
