import { useRef, useState, useEffect, useCallback } from 'react';
import { Database, Disc, Download, Pencil, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { api } from '@/lib/api';
import {
  useIsos, useDeleteIso, useUploadIso, useRenameIso,
  useDownloadIsoFromUrl, useCancelIsoDownload, type DownloadJob,
} from '@/hooks/useIsos';
import { useQueryClient } from '@tanstack/react-query';
import { OsLogoPicker, VmLogo } from '@/components/ui/OsLogoPicker';
import { useLogoStore } from '@/store/logoStore';
import { useUploadProgressStore } from '@/store/uploadProgressStore';
import { cn } from '@/lib/cn';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function StatCard({ icon: Icon, label, value, iconClass }: {
  icon: React.ElementType;
  label: string;
  value: string;
  iconClass: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', iconClass)}>
          <Icon size={15} />
        </div>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</p>
          <p className="mt-0.5 text-xl font-bold tabular-nums leading-tight text-foreground">{value}</p>
        </div>
      </div>
    </div>
  );
}

function ProgressBar({ pct, indeterminate = false }: { pct?: number; indeterminate?: boolean }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      {indeterminate ? (
        <div className="h-full w-2/5 animate-pulse rounded-full bg-primary" />
      ) : (
        <div
          className="h-full rounded-full bg-primary transition-all duration-200"
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
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
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
  const uploadIso = useUploadIso((pct) => setUploadPct(pct));

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingFile(file);
    setUploadDisplayName(file.name.replace(/\.iso$/i, ''));
    setUploadLogoSlug(null);
    e.target.value = '';
  };

  const handleUploadConfirm = async () => {
    if (!pendingFile) return;
    const file = pendingFile;
    const displayName = uploadDisplayName.trim() || file.name.replace(/\.iso$/i, '');
    const logoSlug = uploadLogoSlug;
    const ac = new AbortController();
    setPendingFile(null);
    setUploadLogoSlug(null);
    setUploadingName(displayName || file.name);
    setUploadPct(0);
    setUploadAbort(ac.abort.bind(ac));
    try {
      await uploadIso.mutateAsync({ file, displayName, signal: ac.signal });
      if (logoSlug) setIsoLogo(file.name, logoSlug);
      toast.success(`${displayName || file.name} uploaded`);
    } catch {
      if (ac.signal.aborted) {
        toast.info('Upload cancelled');
      } else {
        toast.error('Upload failed');
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
  const downloadFromUrl = useDownloadIsoFromUrl();
  const cancelDownload = useCancelIsoDownload();
  const qc = useQueryClient();

  const resetUrlDialog = () => {
    setUrlDialogOpen(false);
    setDownloadUrl('');
    setDownloadFilename('');
    setDownloadDisplayName('');
    setDownloadLogoSlug(null);
  };

  const handleUrlDownload = async () => {
    try {
      const result = await downloadFromUrl.mutateAsync({
        url: downloadUrl,
        filename: downloadFilename || undefined,
        name: downloadDisplayName || undefined,
      });
      if (downloadLogoSlug) setIsoLogo(result.filename, downloadLogoSlug);
      resetUrlDialog();
      setActiveJob({ jobId: result.jobId, job: { filename: result.filename, bytesDownloaded: 0, totalBytes: 0, status: 'downloading' } });
    } catch {
      toast.error('Failed to start download');
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
      subtitle="Manage ISO images for attaching as CDROMs to VMs."
      actions={
        <>
          <input ref={fileRef} type="file" accept=".iso" className="hidden" onChange={handleFilePick} />
          <Button variant="secondary" onClick={() => setUrlDialogOpen(true)}>
            <Download size={14} /> From URL
          </Button>
          <Button onClick={() => fileRef.current?.click()} disabled={uploadIso.isPending}>
            {uploadIso.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Upload size={14} />}
            Upload ISO
          </Button>
        </>
      }
    >
      {/* Stats */}
      <div className="mb-6 grid grid-cols-2 gap-3">
        <StatCard icon={Disc} label="ISOs" value={isLoading ? '—' : String(isos?.length ?? 0)} iconClass="bg-blue-500/10 text-blue-500" />
        <StatCard icon={Database} label="Total Size" value={isLoading ? '—' : `${totalIsoGb.toFixed(1)} GB`} iconClass="bg-violet-500/10 text-violet-500" />
      </div>

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

      {/* ISO list */}
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {isLoading ? (
          <div className="space-y-px p-3">
            {[1, 2].map((i) => <Skeleton key={i} className="h-[60px] rounded-lg" />)}
          </div>
        ) : !isos?.length ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
              <Disc className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-semibold text-foreground">No ISOs yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Upload an ISO or download one from a URL.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {['Name', 'File', 'Size', ''].map((h) => (
                  <th
                    key={h}
                    className={`px-5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground ${h === '' ? 'text-right' : 'text-left'}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isos.map((iso) => (
                <tr key={iso.filename} className="transition-colors hover:bg-muted/30">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <VmLogo slug={isoLogos[iso.filename]} size={28} fallbackIcon={Disc} />
                      <InlineName filename={iso.filename} name={iso.name} />
                    </div>
                  </td>
                  <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">{iso.filename}</td>
                  <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">{iso.sizeGb} GB</td>
                  <td className="px-5 py-3.5 text-right">
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(iso.filename)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 size={13} />
                    </button>
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
        title="Download ISO from URL"
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
          <OsLogoPicker value={downloadLogoSlug} onChange={setDownloadLogoSlug} />
        </div>
      </Dialog>

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
