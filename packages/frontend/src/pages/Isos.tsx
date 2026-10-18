import { useRef, useState, useEffect, useCallback } from 'react';
import { Disc, Download, Pencil, Trash2, Upload, X, FolderInput } from 'lucide-react';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { formatBytes, formatDisk } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { StorageDirSelect } from '@/components/StorageDirSelect';
import { api } from '@/lib/api';
import {
  useIsos, useDeleteIso, useUploadIso, useRenameIso,
  useDownloadIsoFromUrl, useCancelIsoDownload, useMoveIso, type DownloadJob,
} from '@/hooks/useIsos';
import { MoveDialog } from '@/components/MoveDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import { useQueryClient } from '@tanstack/react-query';
import { OsLogoPicker, VmLogo } from '@/components/ui/OsLogoPicker';
import { useLogoStore } from '@/store/logoStore';
import { osSlugFromImage } from '@/data/templateSets';
import { useUploadProgressStore } from '@/store/uploadProgressStore';

// Mirrors the server's deriveIsoFilename (backend routes/isos.ts): compressed
// uploads are decompressed before being saved, so the file lands under the
// .iso name, not the name the browser sent. Logos are keyed on the filename
// the ISO list renders, so keying them on the client name meant every .iso.gz
// upload lost its logo. The upload response carries the real filename but
// useUploadIso's mutation resolves with void, so we derive it here instead.
function deriveIsoFilename(clientName: string): string {
  let name = clientName.replace(/^.*[\\/]/, '');
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz')) name = name.slice(0, -'.tar.gz'.length);
  else if (lower.endsWith('.tgz')) name = name.slice(0, -'.tgz'.length);
  else if (lower.endsWith('.gz')) name = name.slice(0, -'.gz'.length);
  if (!name.toLowerCase().endsWith('.iso')) name += '.iso';
  return name;
}

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
  const renameIso = useRenameIso();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setValue(name); }, [name]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === name) { setEditing(false); setValue(name); return; }
    try {
      await renameIso.mutateAsync({ filename, name: trimmed });
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

export function IsosPage() {
  const { data: isos, isLoading } = useIsos();
  const deleteIso = useDeleteIso();
  const moveIso = useMoveIso();
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<{ filename: string; storageDirId: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { isos: isoLogos, setIsoLogo } = useLogoStore();

  const {
    isoUploadPct: uploadPct,
    isoUploadName: uploadingName,
    isoActiveJob: activeJob,
    isoUploadAbort: uploadAbort,
    setIsoUploadPct: setUploadPct,
    setIsoUploadName: setUploadingName,
    setIsoActiveJob: setActiveJob,
    updateIsoActiveJob: updateActiveJob,
    setIsoUploadAbort: setUploadAbort,
  } = useUploadProgressStore();

  // Upload flow: pick file → name dialog → upload
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploadDisplayName, setUploadDisplayName] = useState('');
  const [uploadLogoSlug, setUploadLogoSlug] = useState<string | null>(null);
  const [uploadStorageDirId, setUploadStorageDirId] = useState('');
  const uploadIso = useUploadIso((pct) => setUploadPct(pct));

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingFile(file);
    setUploadDisplayName(file.name.replace(/\.(iso\.tar\.gz|iso\.tgz|iso\.gz|tar\.gz|tgz|gz|iso)$/i, ''));
    setUploadLogoSlug(null);
    e.target.value = '';
  };

  const handleUploadConfirm = async () => {
    if (!pendingFile) return;
    const file = pendingFile;
    const displayName = uploadDisplayName.trim() || file.name.replace(/\.(iso\.tar\.gz|iso\.tgz|iso\.gz|tar\.gz|tgz|gz|iso)$/i, '');
    const logoSlug = uploadLogoSlug;
    const ac = new AbortController();
    setPendingFile(null);
    setUploadLogoSlug(null);
    setUploadingName(displayName || file.name);
    setUploadPct(0);
    setUploadAbort(ac.abort.bind(ac));
    try {
      await uploadIso.mutateAsync({ file, displayName, storageDirId: uploadStorageDirId || undefined, signal: ac.signal });
      if (logoSlug) setIsoLogo(deriveIsoFilename(file.name), logoSlug);
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
  const downloadFromUrl = useDownloadIsoFromUrl();
  const cancelDownload = useCancelIsoDownload();
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
      if (downloadLogoSlug) setIsoLogo(result.filename, downloadLogoSlug);
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
      const { data } = await api.get<DownloadJob>(`/api/isos/download/${jobId}`);
      updateActiveJob((prev) => prev ? { ...prev, job: data } : null);
      if (data.status === 'done') {
        toast.success(`${data.filename} downloaded`);
        qc.invalidateQueries({ queryKey: ['isos'] });
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

  const totalIsoGb = isos?.reduce((s, i) => s + i.sizeGb, 0) ?? 0;

  const downloadPct = activeJob?.job.totalBytes
    ? Math.round((activeJob.job.bytesDownloaded / activeJob.job.totalBytes) * 100)
    : undefined;

  return (
    <Layout
      title="ISOs"
      subtitle="Install media to attach to VMs as CD-ROMs."
      actions={
        <>
          <input ref={fileRef} type="file" accept=".iso,.gz,.tgz" className="hidden" onChange={handleFilePick} />
          <Button variant="secondary" onClick={() => setUrlDialogOpen(true)}>
            <Download size={14} /> From URL
          </Button>
          <Tooltip label="Accepts .iso, .iso.gz and .iso.tar.gz — compressed files are unpacked on upload">
            <Button onClick={() => fileRef.current?.click()} disabled={uploadIso.isPending}>
              {uploadIso.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Upload size={14} />}
              Upload ISO
            </Button>
          </Tooltip>
        </>
      }
    >
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
              {activeJob.job.status === 'processing' ? 'Decompressing' : 'Downloading'} {activeJob.job.filename}
            </span>
            <div className="ml-4 flex shrink-0 items-center gap-3">
              {activeJob.job.status !== 'processing' && (
                <span className="font-mono text-xs text-muted-foreground">
                  {activeJob.job.totalBytes > 0
                    ? `${formatBytes(activeJob.job.bytesDownloaded)} / ${formatBytes(activeJob.job.totalBytes)}`
                    : formatBytes(activeJob.job.bytesDownloaded)}
                </span>
              )}
              {activeJob.job.status === 'downloading' && (
                <button
                  type="button"
                  onClick={() => cancelDownload.mutate(activeJob.jobId)}
                  title="Cancel download"
                  className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
          <ProgressBar
            pct={activeJob.job.status === 'processing' ? undefined : downloadPct}
            indeterminate={activeJob.job.status === 'processing' || downloadPct === undefined}
          />
        </div>
      )}

      {/* ISO list */}
      <div className="panel overflow-hidden">
        {isLoading ? (
          <div className="space-y-px p-3">
            {[1, 2].map((i) => <Skeleton key={i} className="h-[60px] rounded-lg" />)}
          </div>
        ) : !isos?.length ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Disc className="mb-3 h-5 w-5 text-muted-foreground" />
            <p className="text-sm font-semibold text-foreground">No ISOs yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Upload a .iso, .iso.gz or .iso.tar.gz file, or download one from a URL.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="table-head">
                {['Name', 'File', 'Location', 'Size', ''].map((h) => (
                  <th
                    key={h}
                    className={`px-5 py-2.5 text-[12px] font-medium text-muted-foreground ${h === '' || h === 'Size' ? 'text-right' : 'text-left'} ${h === 'File' ? 'hidden xl:table-cell' : ''}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isos.map((iso) => (
                <tr key={iso.filename} className="transition-colors hover:bg-surface/70">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <VmLogo slug={isoLogos[iso.filename] ?? osSlugFromImage(iso.filename)} size={24} fallbackIcon={Disc} />
                      <InlineName filename={iso.filename} name={iso.name} />
                    </div>
                  </td>
                  <td className="hidden px-5 py-3 font-mono text-xs text-muted-foreground xl:table-cell">{iso.filename}</td>
                  <td className="whitespace-nowrap px-5 py-3 text-[12.5px] text-muted-foreground">{iso.storageDirName}</td>
                  <td className="whitespace-nowrap px-5 py-3 text-right text-[12.5px] tabular-nums text-muted-foreground">{formatDisk(iso.sizeGb)}</td>
                  <td className="px-5 py-3 text-right">
                    <div className="inline-flex items-center gap-1">
                      <Tooltip label="Move to another storage directory">
                        <button
                          type="button"
                          onClick={() => setMoveTarget({ filename: iso.filename, storageDirId: iso.storageDirId })}
                          aria-label={`Move ${iso.name} to another storage directory`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <FolderInput size={13} />
                        </button>
                      </Tooltip>
                      <Tooltip label="Delete">
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(iso.filename)}
                          aria-label={`Delete ${iso.name}`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 size={13} />
                        </button>
                      </Tooltip>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            {/* The count and the total, set under their own columns. */}
            <tfoot>
              <tr className="border-t border-border bg-surface/60 text-[12px] text-muted-foreground">
                <td className="px-5 py-2.5 tabular-nums">{isos.length} {isos.length === 1 ? 'ISO' : 'ISOs'}</td>
                <td className="hidden xl:table-cell" />
                <td />
                <td className="whitespace-nowrap px-5 py-2.5 text-right font-medium tabular-nums text-foreground">{formatDisk(totalIsoGb)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {/* Upload name dialog */}
      <Dialog
        open={pendingFile !== null}
        onClose={() => { setPendingFile(null); setUploadDisplayName(''); setUploadLogoSlug(null); }}
        title="Name this ISO"
        size="md"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => { setPendingFile(null); setUploadDisplayName(''); setUploadLogoSlug(null); }}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleUploadConfirm} disabled={uploadIso.isPending}>
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
            placeholder="e.g. Debian 12 Network Install"
          />
          <StorageDirSelect purpose="isos" value={uploadStorageDirId} onChange={setUploadStorageDirId} />
          <p className="text-xs text-muted-foreground">
            File: <span className="font-mono">{pendingFile?.name}</span>
          </p>
          {pendingFile && /\.(gz|tgz)$/i.test(pendingFile.name) && (
            <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              This file will be decompressed on the server before being saved as a .iso.
            </p>
          )}
          <OsLogoPicker value={uploadLogoSlug} onChange={setUploadLogoSlug} />
        </div>
      </Dialog>

      {/* Download from URL dialog */}
      <Dialog
        open={urlDialogOpen}
        onClose={resetUrlDialog}
        title="Download ISO from URL"
        description="The server will fetch the file directly. Supports HTTP and HTTPS with redirects. Compressed .iso.gz and .iso.tar.gz URLs are decompressed automatically."
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
            placeholder="https://releases.ubuntu.com/24.04/ubuntu-24.04-live-server-amd64.iso"
            required
          />
          <Input
            label="Display name (optional)"
            value={downloadDisplayName}
            onChange={(e) => setDownloadDisplayName(e.target.value)}
            placeholder="e.g. Ubuntu 24.04 Server"
          />
          <Input
            label="Filename on disk (optional)"
            value={downloadFilename}
            onChange={(e) => setDownloadFilename(e.target.value)}
            placeholder="Leave blank to use filename from URL"
          />
          <StorageDirSelect purpose="isos" value={downloadStorageDirId} onChange={setDownloadStorageDirId} />
          <OsLogoPicker value={downloadLogoSlug} onChange={setDownloadLogoSlug} />
        </div>
      </Dialog>

      <MoveDialog
        open={moveTarget !== null}
        onClose={() => setMoveTarget(null)}
        itemLabel={moveTarget?.filename ?? ''}
        purpose="isos"
        currentStorageDirId={moveTarget?.storageDirId ?? ''}
        notes={
          <>
            ISOs attached as a CDROM to any VM will block the move — the VM's domain XML has the absolute path baked in.
            Detach the ISO from those VMs first, or leave it where it is.
          </>
        }
        busy={moveIso.isPending}
        onMove={async (storageDirId) => {
          if (!moveTarget) return;
          await moveIso.mutateAsync({ filename: moveTarget.filename, storageDirId });
        }}
      />

      {/* Delete confirm dialog */}
      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete ISO"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="danger"
              size="sm"
              disabled={deleteIso.isPending}
              onClick={async () => {
                if (!deleteTarget) return;
                try {
                  await deleteIso.mutateAsync(deleteTarget);
                  toast.success('ISO deleted');
                  setDeleteTarget(null);
                } catch { toast.error('Failed to delete'); }
              }}
            >
              {deleteIso.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-foreground">
          Remove <span className="font-mono">{deleteTarget}</span> from the ISOs library?
        </p>
      </Dialog>
    </Layout>
  );
}
