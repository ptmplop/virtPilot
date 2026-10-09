import { useState } from 'react';
import { HardDrive, Download, Trash2, Plus, Pencil, FolderOpen, FolderInput } from 'lucide-react';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { formatBytes } from '@/lib/format';
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
import { SectionHeading } from '@/components/ui/SectionHeading';
import { Panel, Stat, StatStrip } from '@/components/ui/Panel';
import { WarnGlyph } from '@/components/ui/Badge';
import type { StorageDir, StorageDirPurpose, StorageDirWithUsage } from '@/types';

function PurposeChips({ purposes }: { purposes: StorageDirPurpose[] }) {
  const labels: Record<StorageDirPurpose, string> = {
    templates: 'templates',
    isos: 'ISOs',
    vmDisks: 'VM disks',
  };
  return (
    <span className="text-[12.5px] text-foreground">
      {purposes.map((p) => labels[p]).join(' · ')}
    </span>
  );
}

function DefaultChips({ dir }: { dir: StorageDir }) {
  const flags: Array<[boolean, string]> = [
    [dir.isDefaultTemplates, 'templates'],
    [dir.isDefaultIsos, 'ISOs'],
    [dir.isDefaultVmDisks, 'VM disks'],
  ];
  const active = flags.filter(([on]) => on).map(([, label]) => label);
  if (active.length === 0) return <span className="text-[12.5px] text-muted-foreground">—</span>;
  return (
    <span className="text-[12.5px] font-medium text-emerald-700 dark:text-emerald-300">
      {active.join(' · ')}
    </span>
  );
}

function UsageBar({ dir }: { dir: StorageDirWithUsage }) {
  const { usage } = dir;
  if (!usage.healthy) {
    return (
      <Tooltip label={usage.error ?? 'Storage directory is unhealthy'}>
        <div className="inline-flex items-center gap-1.5 text-[12.5px] text-amber-700 dark:text-amber-300">
          <WarnGlyph />
          Unavailable
        </div>
      </Tooltip>
    );
  }
  const usedPct = usage.totalBytes > 0
    ? Math.min(100, Math.round(((usage.totalBytes - usage.freeBytes) / usage.totalBytes) * 100))
    : 0;
  return (
    <div className="min-w-[160px]">
      <div className="flex items-baseline justify-between gap-3 text-[12px] tabular-nums text-muted-foreground">
        <span><span className="font-semibold text-foreground">{formatBytes(usage.totalBytes - usage.freeBytes)}</span> used</span>
        <span>{formatBytes(usage.totalBytes)}</span>
      </div>
      <div className="mt-1.5 h-[5px] overflow-hidden rounded-[2px] bg-gauge-track">
        <div
          className={cn('h-full transition-[width] duration-500', usedPct >= 90 ? 'bg-destructive' : 'bg-[#4F7CAC] dark:bg-[#86AEDA]')}
          style={{ width: `${usedPct}%` }}
        />
      </div>
      <p className="mt-1.5 text-[12px] text-muted-foreground">
        VirtPilot files: {formatBytes(usage.usedByVirtpilotBytes)}
      </p>
    </div>
  );
}

export function StoragePage() {
  const { data: templates } = useTemplates();
  const { data: isos } = useIsos();
  const { data: vmDisks, isError: vmDisksError } = useVmDisks();
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

  // A failed VM-disk query counts as content: it renders its own error card,
  // and without this the page would show the "nothing here yet" empty state
  // underneath it, which reads as "you have no disks" rather than "we can't
  // tell".
  const hasContent = !!(templates?.length || isos?.length || vmDisks?.length || vmDisksError);

  const openAdd = () => { setEditingDir(undefined); setDirDialogOpen(true); };
  const openEdit = (dir: StorageDir) => { setEditingDir(dir); setDirDialogOpen(true); };

  return (
    <Layout title="Storage" subtitle="Where templates, ISOs and VM disks are stored, and the space they use.">
      {/* Summary */}
      <StatStrip className="mb-8">
        <Stat label="Templates" value={templates?.length ?? 0} sub={`${totalTemplateGb.toFixed(1)} GB total`} />
        <Stat label="ISOs" value={isos?.length ?? 0} sub={`${totalIsoGb.toFixed(1)} GB total`} />
        <Stat
          label="VM disks"
          value={vmDisksError ? '—' : (vmDisks?.length ?? 0)}
          sub={vmDisksError ? 'libvirt unreachable' : `${totalDiskGb.toFixed(1)} GB on disk`}
        />
      </StatStrip>

      {/* Storage Directories */}
      <section className="mb-7">
        <div className="mb-3.5">
          <SectionHeading label="Storage directories">
            <Button variant="secondary" size="sm" onClick={openAdd}>
              <Plus size={14} /> Add directory
            </Button>
          </SectionHeading>
        </div>
        <Panel className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="table-head">
                <th className="px-5 py-2.5 text-left text-[12px] font-medium text-muted-foreground">Name</th>
                <th className="px-5 py-2.5 text-left text-[12px] font-medium text-muted-foreground">Path</th>
                <th className="px-5 py-2.5 text-left text-[12px] font-medium text-muted-foreground">Holds</th>
                <th className="px-5 py-2.5 text-left text-[12px] font-medium text-muted-foreground">Default for</th>
                <th className="px-5 py-2.5 text-left text-[12px] font-medium text-muted-foreground">Usage</th>
                <th className="px-5 py-2.5 text-right text-[12px] font-medium text-muted-foreground" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(storageDirs ?? []).map((dir) => (
                <tr key={dir.id} className="transition-colors hover:bg-surface/70">
                  <td className="px-5 py-3 align-top">
                    <div className="flex items-center gap-2">
                      <FolderOpen size={13} className="text-muted-foreground" />
                      <span className="text-sm font-medium text-foreground">{dir.name}</span>
                      {dir.usage?.warnings?.length > 0 && (
                        <Tooltip label={dir.usage.warnings.join(' • ')}>
                          <span className="inline-flex items-center gap-1 text-[12px] font-medium text-amber-700 dark:text-amber-300">
                            <WarnGlyph size={9} /> Warning
                          </span>
                        </Tooltip>
                      )}
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
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <Pencil size={13} />
                        </button>
                      </Tooltip>
                      <Tooltip label="Delete (must be empty)">
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteDir(dir)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
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
                  <td colSpan={6} className="px-5 py-8 text-center text-[13px] text-muted-foreground">
                    No storage directories yet. Add one to start uploading templates and ISOs.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Panel>
      </section>

      {/* Templates table */}
      {!!templates?.length && (
        <section className="mb-5">
          <div className="mb-3.5"><SectionHeading label="Templates" /></div>
          <div className="panel overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="table-head">
                  <th className="px-5 py-2.5 text-left text-[12px] font-medium text-muted-foreground">Name</th>
                  <th className="px-5 py-2.5 text-left text-[12px] font-medium text-muted-foreground">File</th>
                  <th className="px-5 py-2.5 text-left text-[12px] font-medium text-muted-foreground">Location</th>
                  <th className="px-5 py-2.5 text-right text-[12px] font-medium text-muted-foreground">Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {templates.map((t) => (
                  <tr key={t.filename} className="transition-colors hover:bg-surface/70">
                    <td className="px-5 py-3 text-sm font-medium text-foreground">{t.name}</td>
                    <td className="px-5 py-3 font-mono text-xs text-muted-foreground">{t.filename}</td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">{t.storageDirName}</td>
                    <td className="px-5 py-3 text-right font-mono text-xs text-muted-foreground">{t.sizeGb} GB</td>
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
          <div className="mb-3.5"><SectionHeading label="ISOs" /></div>
          <div className="panel overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="table-head">
                  <th className="px-5 py-2.5 text-left text-[12px] font-medium text-muted-foreground">Name</th>
                  <th className="px-5 py-2.5 text-left text-[12px] font-medium text-muted-foreground">File</th>
                  <th className="px-5 py-2.5 text-left text-[12px] font-medium text-muted-foreground">Location</th>
                  <th className="px-5 py-2.5 text-right text-[12px] font-medium text-muted-foreground">Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isos.map((iso) => (
                  <tr key={iso.filename} className="transition-colors hover:bg-surface/70">
                    <td className="px-5 py-3 text-sm font-medium text-foreground">{iso.name}</td>
                    <td className="px-5 py-3 font-mono text-xs text-muted-foreground">{iso.filename}</td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">{iso.storageDirName}</td>
                    <td className="px-5 py-3 text-right font-mono text-xs text-muted-foreground">{iso.sizeGb} GB</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* VM Disks — explicit failure state. The backend now 503s this endpoint
          when libvirt is unreachable rather than returning a partial list,
          because a partial list marks live VMs' disks as "orphaned" and the
          delete button next to them really does remove the file. Say plainly
          that orphan status is unknown instead of silently rendering nothing. */}
      {vmDisksError && (
        <section>
          <div className="mb-3.5"><SectionHeading label="VM disks" /></div>
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-5 py-4">
            <WarnGlyph size={12} className="mt-1" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">libvirt unreachable — orphan status unknown</p>
              <p className="mt-1 text-xs text-muted-foreground">
                VirtPilot cannot ask libvirt which VMs are defined, so it cannot tell which disk files are
                genuinely orphaned. The list is hidden rather than shown with unreliable orphan flags — deleting
                from a stale list would remove the disk of a running VM. Check the libvirt daemon
                (<code className="font-mono">systemctl status libvirtd</code>) and reload this page.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* VM Disks table */}
      {!vmDisksError && !!vmDisks?.length && (
        <section>
          <div className="mb-3.5"><SectionHeading label="VM disks" /></div>
          <div className="panel overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="table-head">
                  <th className="px-5 py-2.5 text-left text-[12px] font-medium text-muted-foreground">Virtual machine</th>
                  <th className="px-5 py-2.5 text-left text-[12px] font-medium text-muted-foreground">File</th>
                  <th className="px-5 py-2.5 text-left text-[12px] font-medium text-muted-foreground">Location</th>
                  <th className="px-5 py-2.5 text-right text-[12px] font-medium text-muted-foreground">Size on disk</th>
                  <th className="px-5 py-2.5 text-right text-[12px] font-medium text-muted-foreground" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {vmDisks.map((d) => (
                  <tr key={`${d.vmUuid}/${d.filename}`} className="transition-colors hover:bg-surface/70">
                    <td className="px-5 py-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">{d.vmName}</span>
                          {!d.vmExists && (
                            <span className="inline-flex items-center gap-1 text-[12px] font-medium text-amber-700 dark:text-amber-300">
                              orphaned
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{d.vmUuid}</p>
                      </div>
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-muted-foreground">{d.filename}</td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">{d.storageDirName}</td>
                    <td className="px-5 py-3 text-right font-mono text-xs text-muted-foreground">{d.sizeGb} GB</td>
                    <td className="px-5 py-3 text-right">
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
                                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
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
                                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
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
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
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
          <HardDrive className="mb-3 h-5 w-5 text-muted-foreground" />
          <p className="text-sm font-semibold text-foreground">No storage yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Upload templates and ISOs to see disk usage here.
          </p>
        </div>
      )}
    </Layout>
  );
}
