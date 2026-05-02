import { useRef, useState, useEffect, useCallback } from 'react';
import { Database, Download, HardDrive, Pencil, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { api } from '@/lib/api';
import {
  useTemplates, useDeleteTemplate, useUploadTemplate, useRenameTemplate,
  useDownloadTemplateFromUrl, useCancelTemplateDownload, type DownloadJob,
} from '@/hooks/useTemplates';
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

export function TemplatesPage() {
  const { data: templates, isLoading } = useTemplates();
  const deleteTemplate = useDeleteTemplate();
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
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
      await uploadTemplate.mutateAsync({ file, displayName, signal: ac.signal });
      if (logoSlug) setTemplateLogo(file.name, logoSlug);
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
  const downloadFromUrl = useDownloadTemplateFromUrl();
  const cancelDownload = useCancelTemplateDownload();
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
      if (downloadLogoSlug) setTemplateLogo(result.filename, downloadLogoSlug);
      resetUrlDialog();
      setActiveJob({ jobId: result.jobId, job: { filename: result.filename, bytesDownloaded: 0, totalBytes: 0, status: 'downloading' } });
    } catch {
      toast.error('Failed to start download');
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

  const totalTemplateGb = templates?.reduce((s, t) => s + t.sizeGb, 0) ?? 0;

  const downloadPct = activeJob?.job.totalBytes
    ? Math.round((activeJob.job.bytesDownloaded / activeJob.job.totalBytes) * 100)
    : undefined;

  return (
    <Layout
      title="Templates"
      subtitle="Manage qcow2 base images used for VM provisioning."
      actions={
        <>
          <input ref={fileRef} type="file" accept=".qcow2,.img" className="hidden" onChange={handleFilePick} />
          <Button variant="secondary" onClick={() => setUrlDialogOpen(true)}>
            <Download size={14} /> From URL
          </Button>
          <Button onClick={() => fileRef.current?.click()} disabled={uploadTemplate.isPending}>
            {uploadTemplate.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Upload size={14} />}
            Upload Template
          </Button>
        </>
      }
    >
      {/* Stats */}
      <div className="mb-6 grid grid-cols-2 gap-3">
        <StatCard icon={HardDrive} label="Templates" value={isLoading ? '—' : String(templates?.length ?? 0)} iconClass="bg-violet-500/10 text-violet-500" />
        <StatCard icon={Database} label="Total Size" value={isLoading ? '—' : `${totalTemplateGb.toFixed(1)} GB`} iconClass="bg-blue-500/10 text-blue-500" />
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

      {/* Template list */}
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {isLoading ? (
          <div className="space-y-px p-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-[60px] rounded-lg" />)}
          </div>
        ) : !templates?.length ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
              <HardDrive className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-semibold text-foreground">No templates yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Upload a .qcow2 cloud image or download one from a URL.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {['Name', 'File', 'Size', 'Added', ''].map((h) => (
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
              {templates.map((t) => (
                <tr key={t.filename} className="transition-colors hover:bg-muted/30">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        title="Change logo"
                        onClick={() => setLogoTarget(t.filename)}
                        className="group relative shrink-0 rounded-md"
                      >
                        <VmLogo slug={templateLogos[t.filename]} size={28} />
                        <div className="absolute inset-0 flex items-center justify-center rounded-md bg-black/0 transition-colors group-hover:bg-black/40">
                          <Pencil size={9} className="text-white opacity-0 transition-opacity group-hover:opacity-100" />
                        </div>
                      </button>
                      <InlineName filename={t.filename} name={t.name} />
                    </div>
                  </td>
                  <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">{t.filename}</td>
                  <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">{t.sizeGb} GB</td>
                  <td className="px-5 py-3.5 text-xs text-muted-foreground">
                    {new Date(t.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(t.filename)}
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
        title="Download Template from URL"
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
          <OsLogoPicker value={downloadLogoSlug} onChange={setDownloadLogoSlug} />
        </div>
      </Dialog>

      {/* Logo picker dialog */}
      <Dialog
        open={logoTarget !== null}
        onClose={() => setLogoTarget(null)}
        title="Change Logo"
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

      {/* Delete confirm dialog */}
      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete Template"
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
