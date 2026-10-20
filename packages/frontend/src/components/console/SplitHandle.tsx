import { useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

// A drag can't squeeze a split terminal below about 15 columns or 3 rows.
const MIN_PANE_WIDTH = 120;
const MIN_PANE_HEIGHT = 64;

interface SplitHandleProps {
  /** `vertical`: the line between side-by-side panes (dragged along x); `horizontal`: between rows. */
  orientation: 'vertical' | 'horizontal';
  /** The flex weights of the two neighbours it sits between. */
  weights: [number, number];
  onResize: (first: number, second: number) => void;
}

// The divider between split panes: a hairline with a 9px grab area that turns into a 2px
// steel line while it is dragged or focused (the arrow keys move it, Shift for bigger
// steps; Enter or a double-click evens the split). While dragging it writes the two
// panes' flex weights straight onto them and hands React the result once, on release.
export function SplitHandle({ orientation, weights, onResize }: SplitHandleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const alongX = orientation === 'vertical';
  const min = alongX ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT;
  const total = weights[0] + weights[1];

  const neighbours = (): [HTMLElement, HTMLElement] | null => {
    const a = ref.current?.previousElementSibling;
    const b = ref.current?.nextElementSibling;
    return a instanceof HTMLElement && b instanceof HTMLElement ? [a, b] : null;
  };
  const extent = (el: HTMLElement) => {
    const box = el.getBoundingClientRect();
    return alongX ? box.width : box.height;
  };
  // The first pane's share of the pair, keeping both at or above their minimum where there's room.
  const clamp = (share: number, span: number) => {
    const floor = Math.min(0.5, min / span);
    return Math.min(Math.max(share, floor), 1 - floor);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const pair = neighbours();
    if (!pair) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const [a, b] = pair;
    const start = alongX ? e.clientX : e.clientY;
    const first = extent(a);
    const span = first + extent(b);
    let share = first / span;
    setDragging(true);

    const move = (ev: PointerEvent) => {
      share = clamp((first + (alongX ? ev.clientX : ev.clientY) - start) / span, span);
      a.style.flexGrow = String(share * total);
      b.style.flexGrow = String((1 - share) * total);
    };
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.removeEventListener('lostpointercapture', end);
      setDragging(false);
      onResize(share * total, (1 - share) * total);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const pair = neighbours();
    if (!pair) return;
    const span = extent(pair[0]) + extent(pair[1]);
    const current = extent(pair[0]) / span;
    const step = (e.shiftKey ? 64 : 16) / span;
    let share: number;
    if (e.key === (alongX ? 'ArrowLeft' : 'ArrowUp')) share = current - step;
    else if (e.key === (alongX ? 'ArrowRight' : 'ArrowDown')) share = current + step;
    else if (e.key === 'Home') share = 0;
    else if (e.key === 'End') share = 1;
    else if (e.key === 'Enter') share = 0.5;
    else return;
    e.preventDefault();
    share = clamp(share, span);
    onResize(share * total, (1 - share) * total);
  };

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation={orientation}
      aria-label={alongX ? 'Resize the panes on either side' : 'Resize the rows above and below'}
      aria-valuenow={Math.round((weights[0] / total) * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResize(total / 2, total / 2)}
      className={cn(
        'relative z-20 shrink-0 touch-none bg-border outline-none transition-colors duration-100 hover:bg-muted-foreground/50',
        // A 9px grab area (13px on touch screens) around the 1px line.
        alongX
          ? 'w-px cursor-col-resize before:absolute before:-inset-x-1 before:inset-y-0 [@media(pointer:coarse)]:before:-inset-x-1.5'
          : 'h-px cursor-row-resize before:absolute before:inset-x-0 before:-inset-y-1 [@media(pointer:coarse)]:before:-inset-y-1.5',
        // Dragged, or focused from the keyboard: a 2px steel line.
        'after:pointer-events-none after:absolute after:bg-ring after:opacity-0',
        alongX ? 'after:-left-px after:inset-y-0 after:w-0.5' : 'after:inset-x-0 after:-top-px after:h-0.5',
        'focus-visible:after:opacity-100',
        dragging && 'after:opacity-100',
      )}
    >
      {/* While dragging, the resize cursor holds over the terminals (xterm sets its own). */}
      {dragging &&
        createPortal(
          <div aria-hidden className={cn('fixed inset-0 z-50', alongX ? 'cursor-col-resize' : 'cursor-row-resize')} />,
          document.body,
        )}
    </div>
  );
}
