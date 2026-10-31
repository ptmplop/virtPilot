import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { buildNetplanSnippet } from '@/lib/netplan';
import type { Network } from '@/types';

// Shown once a NIC has been added to an existing VM: cloud-init won't run for it,
// so the guest has to be told about it by hand.
export function NicConfigHelp({ mac, network, staticIp }: { mac: string; network: Network; staticIp?: string }) {
  const snippet = buildNetplanSnippet(mac, network, staticIp);
  return (
    <div className="space-y-3">
      <p className="text-[13.5px] text-foreground">
        <span className="font-semibold">{network.name}</span> attached with MAC{' '}
        <span className="font-mono text-[12.5px]">{mac}</span>.
      </p>
      <p className="text-[12.5px] leading-5 text-muted-foreground">
        Cloud-init will not run again for this NIC - configure it inside the VM using your OS's
        network tools. The example below is for <span className="font-medium text-foreground">Ubuntu / Debian</span> (netplan);
        adapt as needed for other distributions or Windows.
      </p>
      <div className="relative">
        <pre className="overflow-x-auto rounded-md border border-border bg-surface px-4 py-3 font-mono text-[12px] leading-relaxed text-foreground">
          {snippet}
        </pre>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(snippet);
            toast.success('Copied to clipboard');
          }}
          className="absolute right-2 top-2 inline-flex h-7 items-center gap-1.5 rounded-md border border-input bg-card px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-surface"
        >
          <Copy className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          Copy
        </button>
      </div>
    </div>
  );
}
