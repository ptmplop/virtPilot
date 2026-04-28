import { HardDrive, Disc, Database } from 'lucide-react';
import { Layout } from '@/components/layout/Layout';
import { useTemplates } from '@/hooks/useTemplates';
import { useIsos } from '@/hooks/useIsos';
import { useVmDisks } from '@/hooks/useVmDisks';

function ResourceCard({
  label,
  count,
  detail,
  icon: Icon,
}: {
  label: string;
  count: number;
  detail?: string;
  icon: typeof HardDrive;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </span>
      </div>
      <p className="font-mono text-2xl font-bold text-foreground">{count}</p>
      {detail && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

export function StoragePage() {
  const { data: templates } = useTemplates();
  const { data: isos } = useIsos();
  const { data: vmDisks } = useVmDisks();

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
        />
        <ResourceCard
          label="ISOs"
          count={isos?.length ?? 0}
          detail={`${totalIsoGb.toFixed(1)} GB total`}
          icon={Disc}
        />
        <ResourceCard
          label="VM Disks"
          count={vmDisks?.length ?? 0}
          detail={`${totalDiskGb.toFixed(1)} GB on disk`}
          icon={Database}
        />
      </div>

      {/* Templates table */}
      {!!templates?.length && (
        <section className="mb-5">
          <h2 className="mb-3 text-sm font-semibold text-foreground">Templates</h2>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
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
          <div className="overflow-hidden rounded-xl border border-border bg-card">
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
          <div className="overflow-hidden rounded-xl border border-border bg-card">
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
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {vmDisks.map((d) => (
                  <tr key={`${d.vmName}/${d.filename}`} className="transition-colors hover:bg-muted/30">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{d.vmName}</span>
                        {!d.vmExists && (
                          <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                            orphaned
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">{d.filename}</td>
                    <td className="px-5 py-3.5 text-right font-mono text-xs text-muted-foreground">
                      {d.sizeGb} GB
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
