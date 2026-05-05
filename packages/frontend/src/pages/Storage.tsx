import { useState } from 'react';
import { HardDrive, Disc, Database, Download, Trash2, Plus, Pencil, FolderOpen, AlertTriangle, FolderInput } from 'lucide-react';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Tooltip } from '@/components/ui/Tooltip';
import { StorageDirDialog } from '@/components/StorageDirDialog';
import { cn } from '@/lib/cn';
import { useTemplates } from '@/hooks/useTemplates';
import { useIsos } from '@/hooks/useIsos';
import { useVmDisks, useDeleteOrphanedVmDisk, useDownloadVmDisk, useMoveVmDisk } from '@/hooks/useVmDisks';
import { useStorageDirs, useDeleteStorageDir } from '@/hooks/useStorageDirs';
import { MoveDialog } from '@/components/MoveDialog';
import type { StorageDir, StorageDirPurpose, StorageDirWithUsage } from '@/types';

function ResourceCard({
  label,
  count,
  detail,
  icon: Icon,
  iconClass,
}: {
  label: string;
  count: number;
  detail?: string;
  icon: typeof HardDrive;
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
          <p className="mt-0.5 text-xl font-bold tabular-nums leading-tight text-foreground">{count}</p>
          {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
        </div>
      </div>
    </div>
  );
}

function PurposeChips({ purposes }: { purposes: StorageDirPurpose[] }) {
  const labels: Record<StorageDirPurpose, string> = {
    templates: 'templates',
    isos: 'ISOs',
    vmDisks: 'VM disks',
  };
  return (
    <div className="flex flex-wrap gap-1">
      {purposes.map((p) => (
        <span key={p} className="inline-flex items-center rounded-full border border-border bg-muted/40 px-1.5 py-px text-[10px] font-medium text-muted-foreground">
          {labels[p]}
        </span>
      ))}
    </div>
  );
}

function DefaultChips({ dir }: { dir: StorageDir }) {
  const flags: Array<[boolean, string]> = [
    [dir.isDefaultTemplates, 'templates'],
    [dir.isDefaultIsos, 'ISOs'],
    [dir.isDefaultVmDisks, 'VM disks'],
  ];
  const active = flags.filter(([on]) => on).map(([, label]) => label);
  if (active.length === 0) return <span className="text-xs text-muted-foreground/60">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {active.map((label) => (
        <span key={label} className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-px text-[10px] font-semibold text-emerald-400">
          {label}
        </span>
      ))}
    </div>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function UsageBar({ dir }: { dir: StorageDirWithUsage }) {
  const { usage } = dir;
  if (!usage.healthy) {
    return (
      <Tooltip label={usage.error ?? 'Storage directory is unhealthy'}>
        <div className="inline-flex items-center gap-1 text-xs text-amber-400">
          <AlertTriangle size={12} />
          unavailable
        </div>
      </Tooltip>
    );
  }
  const usedPct = usage.totalBytes > 0
    ? Math.min(100, Math.round(((usage.totalBytes - usage.freeBytes) / usage.totalBytes) * 100))
    : 0;
  return (
    <div className="min-w-[140px]">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{formatBytes(usage.totalBytes - usage.freeBytes)} used</span>
        <span>{formatBytes(usage.totalBytes)}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full transition-all', usedPct >= 90 ? 'bg-destructive' : 'bg-primary')}
          style={{ width: `${usedPct}%` }}
        />
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground/70">
        VirtPilot files: {formatBytes(usage.usedByVirtpilotBytes)}
      </p>
    </div>
  );
}

export function StoragePage() {
  const { data: templates } = useTemplates();
  const { data: isos } = useIsos();
  const { data: vmDisks } = useVmDisks();
  const { data: storageDirs } = useStorageDirs();
  const deleteOrphan = useDeleteOrphanedVmDisk();
  const downloadDisk = useDownloadVmDisk();
  const moveVmDisk = useMoveVmDisk();
  const deleteStorageDir = useDeleteStorageDir();
  const [deleteTarget, setDeleteTarget] = useState<{ uuid: string; name: string } | null>(null);
  const [dirDialogOpen, setDirDialogOpen] = useState(false);
  const [editingDir, setEditingDir] = useState<StorageDir | undefined>(undefined);
  const [confirmDeleteDir, setConfirmDeleteDir] = useState<StorageDir | null>(null);
  const [moveDiskTarget, setMoveDiskTarget] = useState<{ vmUuid: string; vmName: string; filename: string; storageDirId: string; vmStatus: string | null } | null>(null);

  const totalTemplateGb = templates?.reduce((s, t) => s + t.sizeGb, 0) ?? 0;
  const totalIsoGb = isos?.reduce((s, i) => s + i.sizeGb, 0) ?? 0;
  const totalDiskGb = vmDisks?.reduce((s, d) => s + d.sizeGb, 0) ?? 0;

  const hasContent = !!(templates?.length || isos?.length || vmDisks?.length);

  const openAdd = () => { setEditingDir(undefined); setDirDialogOpen(true); };
  const openEdit = (dir: StorageDir) => { setEditingDir(dir); setDirDialogOpen(true); };

  return (
    <Layout title="Storage" subtitle="Configure storage directories and review disk usage across templates, ISOs, and VMs.">
      {/* Summary cards */}
      <div className="mb-7 grid grid-cols-3 gap-4">
        <ResourceCard
          label="Templates"
          count={templates?.length ?? 0}
          detail={`${totalTemplateGb.toFixed(1)} GB total`}
          icon={HardDrive}
          iconClass="bg-violet-500/10 text-violet-500"
        />
        <ResourceCard
          label="ISOs"
          count={isos?.length ?? 0}
          detail={`${totalIsoGb.toFixed(1)} GB total`}
          icon={Disc}
          iconClass="bg-blue-500/10 text-blue-500"
        />
        <ResourceCard
          label="VM Disks"
          count={vmDisks?.length ?? 0}
          detail={`${totalDiskGb.toFixed(1)} GB on disk`}
          icon={Database}
          iconClass="bg-emerald-500/10 text-emerald-500"
        />
      </div>

      {/* Storage Directories */}
      <section className="mb-7">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Storage Directories</h2>
          <Button variant="primary" size="sm" onClick={openAdd}>
            <Plus size={14} /> Add directory
          </Button>
        </div>
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Name</th>
                <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Path</th>
                <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Holds</th>
                <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Default for</th>
                <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Usage</th>
                <th className="px-5 py-2.5 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(storageDirs ?? []).map((dir) => (
                <tr key={dir.id} className="transition-colors hover:bg-muted/30">
                  <td className="px-5 py-3 align-top">
                    <div className="flex items-center gap-2">
                      <FolderOpen size={13} className="text-muted-foreground" />
                      <span className="text-sm font-medium text-foreground">{dir.name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 align-top font-mono text-xs text-muted-foreground">{dir.path}</td>
                  <td className="px-5 py-3 align-top"><PurposeChips purposes={dir.purposes} /></td>
                  <td className="px-5 py-3 align-top"><DefaultChips dir={dir} /></td>
                  <td className="px-5 py-3 align-top"><UsageBar dir={dir} /></td>
                  <td className="px-5 py-3 align-top text-right">
                    <div className="inline-flex items-center gap-1">
                      <Tooltip label="Edit">
                        <button
                          type="button"
                          onClick={() => openEdit(dir)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                        >
                          <Pencil size={13} />
                        </button>
                      </Tooltip>
                      <Tooltip label="Delete (must be empty)">
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteDir(dir)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 size={13} />
                        </button>
                      </Tooltip>
                    </div>
                  </td>
                </tr>
              ))}
              {(storageDirs?.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-6 text-center text-xs text-muted-foreground">
                    No storage directories yet. Add one to start uploading templates and ISOs.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Templates table */}
      {!!templates?.length && (
        <section className="mb-5">
          <h2 className="mb-3 text-sm font-semibold text-foreground">Templates</h2>
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Name</th>
                  <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">File</th>
                  <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Location</th>
                  <th className="px-5 py-2.5 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {templates.map((t) => (
                  <tr key={t.filename} className="transition-colors hover:bg-muted/30">
                    <td className="px-5 py-3.5 text-sm font-medium text-foreground">{t.name}</td>
                    <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">{t.filename}</td>
                    <td className="px-5 py-3.5 text-xs text-muted-foreground">{t.storageDirName}</td>
                    <td className="px-5 py-3.5 text-right font-mono text-xs text-muted-foreground">{t.sizeGb} GB</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ISOs table */}
      {!!isos?.length && (
        <section className="mb-5">
          <h2 className="mb-3 text-sm font-semibold text-foreground">ISOs</h2>
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Name</th>
                  <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">File</th>
                  <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Location</th>
                  <th className="px-5 py-2.5 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isos.map((iso) => (
                  <tr key={iso.filename} className="transition-colors hover:bg-muted/30">
                    <td className="px-5 py-3.5 text-sm font-medium text-foreground">{iso.name}</td>
                    <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">{iso.filename}</td>
                    <td className="px-5 py-3.5 text-xs text-muted-foreground">{iso.storageDirName}</td>
                    <td className="px-5 py-3.5 text-right font-mono text-xs text-muted-foreground">{iso.sizeGb} GB</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* VM Disks table */}
      {!!vmDisks?.length && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-foreground">VM Disks</h2>
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Virtual Machine</th>
                  <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">File</th>
                  <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Location</th>
                  <th className="px-5 py-2.5 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Size on Disk</th>
                  <th className="px-5 py-2.5 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {vmDisks.map((d) => (
                  <tr key={`${d.vmUuid}/${d.filename}`} className="transition-colors hover:bg-muted/30">
                    <td className="px-5 py-3.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">{d.vmName}</span>
                          {!d.vmExists && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-px text-[10px] font-semibold text-amber-400">
                              orphaned
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/50">{d.vmUuid}</p>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">{d.filename}</td>
                    <td className="px-5 py-3.5 text-xs text-muted-foreground">{d.storageDirName}</td>
                    <td className="px-5 py-3.5 text-right font-mono text-xs text-muted-foreground">{d.sizeGb} GB</td>
                    <td className="px-5 py-3.5 text-right">
                      <div className="inline-flex items-center gap-1">
                        {(() => {
                          // Same gate as download: VM must be stopped (or undefined). Moving
                          // a live qcow2 underneath qemu would corrupt the disk, and libvirt
                          // refuses to redefine a running domain's storage path.
                          const movable = !d.vmExists || d.vmStatus === 'stopped';
                          const tooltip = movable ? 'Move to another storage directory' : 'Stop the VM before moving its disk';
                          return (
                            <Tooltip label={tooltip}>
                              <button
                                type="button"
                                disabled={!movable}
                                onClick={() => setMoveDiskTarget({
                                  vmUuid: d.vmUuid,
                                  vmName: d.vmName,
                                  filename: d.filename,
                                  storageDirId: d.storageDirId,
                                  vmStatus: d.vmStatus,
                                })}
                                className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                              >
                                <FolderInput size={13} />
                              </button>
                            </Tooltip>
                          );
                        })()}
                        {(() => {
                          const downloadable = !d.vmExists || d.vmStatus === 'stopped';
                          const tooltip = downloadable ? 'Download disk image' : 'Stop the VM before downloading its disk';
                          return (
                            <Tooltip label={tooltip}>
                              <button
                                type="button"
                                disabled={!downloadable || downloadDisk.isPending}
                                onClick={async () => {
                                  try {
                                    await downloadDisk.mutateAsync({ vmUuid: d.vmUuid, filename: d.filename });
                                  } catch (err: unknown) {
                                    toast.error(err instanceof Error ? err.message : 'Failed to start download');
                                  }
                                }}
                                className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                              >
                                <Download size={13} />
                              </button>
                            </Tooltip>
                          );
                        })()}
                        {!d.vmExists && (
                          <Tooltip label="Delete orphaned VM folder">
                            <button
                              type="button"
                              onClick={() => setDeleteTarget({ uuid: d.vmUuid, name: d.vmName })}
                              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                            >
                              <Trash2 size={13} />
                            </button>
                          </Tooltip>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <MoveDialog
        open={moveDiskTarget !== null}
        onClose={() => setMoveDiskTarget(null)}
        itemLabel={moveDiskTarget ? `${moveDiskTarget.vmName} / ${moveDiskTarget.filename}` : ''}
        purpose="vmDisks"
        currentStorageDirId={moveDiskTarget?.storageDirId ?? ''}
        notes={
          <>
            The disk file is moved on disk and the VM's domain XML is rewritten to point at the new path.
            VM must be stopped — moving a live qcow2 underneath QEMU would corrupt it.
          </>
        }
        busy={moveVmDisk.isPending}
        onMove={async (storageDirId) => {
          if (!moveDiskTarget) return;
          await moveVmDisk.mutateAsync({
            vmUuid: moveDiskTarget.vmUuid,
            filename: moveDiskTarget.filename,
            storageDirId,
          });
        }}
      />

      <StorageDirDialog open={dirDialogOpen} onClose={() => setDirDialogOpen(false)} editing={editingDir} />

      <Dialog
        open={confirmDeleteDir !== null}
        onClose={() => setConfirmDeleteDir(null)}
        title="Remove storage directory"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setConfirmDeleteDir(null)}>Cancel</Button>
            <Button
              variant="danger"
              size="sm"
              disabled={deleteStorageDir.isPending}
              onClick={async () => {
                if (!confirmDeleteDir) return;
                try {
                  await deleteStorageDir.mutateAsync(confirmDeleteDir.id);
                  toast.success(`${confirmDeleteDir.name} removed`);
                  setConfirmDeleteDir(null);
                } catch (err: unknown) {
                  const apiMsg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
                  toast.error(apiMsg ?? 'Failed to remove directory');
                }
              }}
            >
              {deleteStorageDir.isPending ? 'Removing…' : 'Remove'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-foreground">
          Unregister <span className="font-mono">{confirmDeleteDir?.name}</span> from VirtPilot? Files on disk are left in place — only the registration is removed.
          The directory must be empty of templates, ISOs, and VM disks before it can be removed.
        </p>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete orphaned VM folder"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="danger"
              size="sm"
              disabled={deleteOrphan.isPending}
              onClick={async () => {
                if (!deleteTarget) return;
                try {
                  await deleteOrphan.mutateAsync(deleteTarget.uuid);
                  toast.success(`${deleteTarget.name} folder deleted`);
                  setDeleteTarget(null);
                } catch { toast.error('Failed to delete folder'); }
              }}
            >
              {deleteOrphan.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-foreground">
          Permanently delete the <span className="font-mono">{deleteTarget?.name}</span> folder and all of its contents (qcow2 disks, cloud-init seed.iso, leftover scaffolding)? This cannot be undone.
        </p>
      </Dialog>

      {/* Empty state */}
      {!hasContent && (storageDirs?.length ?? 0) > 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
            <HardDrive className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="text-sm font-semibold text-foreground">No storage yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Upload templates and ISOs to see disk usage here.
          </p>
        </div>
      )}
    </Layout>
  );
}
