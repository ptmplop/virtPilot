import { useState } from 'react';
import { HardDrive, Disc, Database, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { cn } from '@/lib/cn';
import { useTemplates } from '@/hooks/useTemplates';
import { useIsos } from '@/hooks/useIsos';
import { useVmDisks, useDeleteOrphanedVmDisk } from '@/hooks/useVmDisks';

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

export function StoragePage() {
  const { data: templates } = useTemplates();
  const { data: isos } = useIsos();
  const { data: vmDisks } = useVmDisks();
  const deleteOrphan = useDeleteOrphanedVmDisk();
  const [deleteTarget, setDeleteTarget] = useState<{ uuid: string; name: string } | null>(null);

  const totalTemplateGb = templates?.reduce((s, t) => s + t.sizeGb, 0) ?? 0;
  const totalIsoGb = isos?.reduce((s, i) => s + i.sizeGb, 0) ?? 0;
  const totalDiskGb = vmDisks?.reduce((s, d) => s + d.sizeGb, 0) ?? 0;

  const hasContent = !!(templates?.length || isos?.length || vmDisks?.length);

  return (
    <Layout title="Storage" subtitle="Overview of disk usage across templates, ISOs, and VMs.">
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

      {/* Templates table */}
      {!!templates?.length && (
        <section className="mb-5">
          <h2 className="mb-3 text-sm font-semibold text-foreground">Templates</h2>
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Name
                  </th>
                  <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    File
                  </th>
                  <th className="px-5 py-2.5 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Size
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {templates.map((t) => (
                  <tr key={t.filename} className="transition-colors hover:bg-muted/30">
                    <td className="px-5 py-3.5 text-sm font-medium text-foreground">{t.name}</td>
                    <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">{t.filename}</td>
                    <td className="px-5 py-3.5 text-right font-mono text-xs text-muted-foreground">
                      {t.sizeGb} GB
                    </td>
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
                  <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Name
                  </th>
                  <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    File
                  </th>
                  <th className="px-5 py-2.5 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Size
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isos.map((iso) => (
                  <tr key={iso.filename} className="transition-colors hover:bg-muted/30">
                    <td className="px-5 py-3.5 text-sm font-medium text-foreground">{iso.name}</td>
                    <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">{iso.filename}</td>
                    <td className="px-5 py-3.5 text-right font-mono text-xs text-muted-foreground">
                      {iso.sizeGb} GB
                    </td>
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
                  <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Virtual Machine
                  </th>
                  <th className="px-5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    File
                  </th>
                  <th className="px-5 py-2.5 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Size on Disk
                  </th>
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
                        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/50">
                          {d.vmUuid}
                        </p>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">{d.filename}</td>
                    <td className="px-5 py-3.5 text-right font-mono text-xs text-muted-foreground">
                      {d.sizeGb} GB
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      {!d.vmExists && (
                        <button
                          type="button"
                          onClick={() => setDeleteTarget({ uuid: d.vmUuid, name: d.vmName })}
                          title="Delete orphaned VM folder"
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
      {!hasContent && (
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
