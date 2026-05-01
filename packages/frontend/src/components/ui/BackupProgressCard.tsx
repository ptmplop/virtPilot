import { useEffect, useState } from 'react';
import { Archive, CalendarClock, Loader2 } from 'lucide-react';
import { useRunningBackups } from '@/hooks/useBackups';
import { cn } from '@/lib/cn';
import type { BackupInProgress } from '@/types';

function useElapsed(startedAt: string): string {
  const [elapsed, setElapsed] = useState('');
  useEffect(() => {
    function tick() {
      const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      setElapsed(m > 0 ? `${m}m ${s}s` : `${s}s`);
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return elapsed;
}

function BackupItem({ backup }: { backup: BackupInProgress }) {
  const elapsed = useElapsed(backup.startedAt);
  return (
    <div className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
      <Loader2 size={13} className="shrink-0 animate-spin text-primary" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-semibold text-foreground">{backup.vmName}</p>
        <p className="font-mono text-[10px] text-muted-foreground">{elapsed}</p>
      </div>
      <span className={cn(
        'shrink-0 inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide',
        backup.triggerType === 'scheduled'
          ? 'border border-primary/20 bg-primary/10 text-primary'
          : 'border border-border bg-muted/50 text-muted-foreground',
      )}>
        {backup.triggerType === 'scheduled' ? <><CalendarClock size={8} />Scheduled</> : 'Manual'}
      </span>
    </div>
  );
}

export function BackupProgressCard() {
  const { data: running = [] } = useRunningBackups();

  if (running.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 w-72 overflow-hidden rounded-xl border border-border bg-card/95 shadow-lg backdrop-blur-sm">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <Archive size={12} className="text-primary" />
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          {running.length === 1 ? 'Backup in progress' : `${running.length} backups in progress`}
        </span>
      </div>
      <div className={cn('px-4', running.length > 1 && 'divide-y divide-border/60')}>
        {running.map((b) => (
          <BackupItem key={b.vmName} backup={b} />
        ))}
      </div>
    </div>
  );
}
