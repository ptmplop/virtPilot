import { forwardRef } from 'react';
import { CircleX, Power, RotateCw, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/** Why a pane's session ended, for its bar. */
export interface SessionEnd {
  /** "Session ended", "Couldn’t connect", "Reconnection failed". */
  title: string;
  reason: string | null;
  failed: boolean;
  /** The backend said the VM is off (whatever the polled VM list still says). */
  vmDown?: boolean;
}

interface SessionBarProps {
  /** The session ended (null while the VM has never been reachable). */
  ended: SessionEnd | null;
  /** The VM can't take a session right now: the bar offers to power it on. */
  stopped?: { message: string; onPowerOn?: () => void; pending?: boolean } | null;
  onReconnect: () => void;
  /** The pane shares its tab with others: keep clear of its close button. */
  split?: boolean;
}

// A floating bar at the top of a pane whose session has ended: what happened, and the
// one thing to do about it (Reconnect, or Power on when the VM is off). It lets the
// pointer through around it, so the kept scrollback can still be scrolled, selected and
// copied. The wrapper is a size container: in a narrow pane the button drops to its icon,
// then the words go (screen readers still hear them; the reason stays in the scrollback).
export const SessionBar = forwardRef<HTMLButtonElement, SessionBarProps>(function SessionBar(
  { ended, stopped, onReconnect, split },
  ref,
) {
  const off = !!stopped;
  const title = off ? stopped.message : ended?.title ?? 'Session ended';
  const detail = off ? null : ended?.reason ?? null;
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center pl-3 [container-type:inline-size]',
        split ? 'pr-11 [@media(pointer:coarse)]:pr-3' : 'pr-3',
      )}
    >
      <div
        role="status"
        className="pointer-events-auto flex min-w-0 max-w-full animate-fade-in items-center gap-2.5 overflow-hidden rounded-lg border border-border bg-card py-1.5 pl-3 pr-1.5 text-foreground shadow-pop [@container(max-width:11rem)]:gap-1.5 [@container(max-width:11rem)]:pl-2"
      >
        {/* The Power on button carries the power glyph, so a stopped bar has no leading one. */}
        {off ? null : ended?.failed ? (
          <CircleX aria-hidden size={15} className="shrink-0 text-red-300" />
        ) : (
          <Unplug aria-hidden size={15} className="shrink-0 text-muted-foreground" />
        )}
        <p
          className="min-w-0 truncate text-[13px] leading-[18px] [@container(max-width:11rem)]:sr-only"
          title={detail ? `${title}: ${detail}` : title}
        >
          <span className="font-medium">{title}</span>
          {detail && <span className="text-muted-foreground"> · {detail}</span>}
        </p>
        {off ? (
          stopped.onPowerOn && (
            <Button
              ref={ref}
              variant="secondary"
              size="sm"
              disabled={stopped.pending}
              onClick={stopped.onPowerOn}
              className="h-7 px-2.5 focus-visible:ring-offset-0 [@container(max-width:16rem)]:w-7 [@container(max-width:16rem)]:px-0 [@media(pointer:coarse)]:h-9"
            >
              <Power aria-hidden size={14} />
              <span className="[@container(max-width:16rem)]:sr-only">Power on</span>
            </Button>
          )
        ) : (
          <Button
            ref={ref}
            variant="secondary"
            size="sm"
            onClick={onReconnect}
            className="h-7 px-2.5 focus-visible:ring-offset-0 [@container(max-width:16rem)]:w-7 [@container(max-width:16rem)]:px-0 [@media(pointer:coarse)]:h-9"
          >
            <RotateCw aria-hidden size={14} />
            <span className="[@container(max-width:16rem)]:sr-only">Reconnect</span>
          </Button>
        )}
      </div>
    </div>
  );
});
