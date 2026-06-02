import { useState, useRef, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

interface TooltipProps {
  label: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  children: ReactNode;
}

export function Tooltip({ label, side = 'top', children }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const anchorRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!visible || !anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const GAP = 6;
    let top = 0;
    let left = 0;
    if (side === 'top') {
      top = r.top + window.scrollY - GAP;
      left = r.left + window.scrollX + r.width / 2;
    } else if (side === 'bottom') {
      top = r.bottom + window.scrollY + GAP;
      left = r.left + window.scrollX + r.width / 2;
    } else if (side === 'right') {
      top = r.top + window.scrollY + r.height / 2;
      left = r.right + window.scrollX + GAP;
    } else {
      top = r.top + window.scrollY + r.height / 2;
      left = r.left + window.scrollX - GAP;
    }
    setCoords({ top, left });
  }, [visible, side]);

  const transformMap: Record<NonNullable<TooltipProps['side']>, string> = {
    top:    'translate(-50%, -100%)',
    bottom: 'translate(-50%, 0)',
    right:  'translate(0, -50%)',
    left:   'translate(-100%, -50%)',
  };

  return (
    <span
      ref={anchorRef}
      className="relative inline-flex"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocusCapture={() => setVisible(true)}
      onBlurCapture={() => setVisible(false)}
    >
      {children}
      {visible &&
        createPortal(
          <span
            style={{ top: coords.top, left: coords.left, transform: transformMap[side] }}
            className={cn(
              'pointer-events-none fixed z-[9999] animate-fade-in whitespace-nowrap rounded-md',
              'bg-foreground px-2 py-1 text-[11px] font-medium text-background shadow-md'
            )}
          >
            {label}
          </span>,
          document.body
        )}
    </span>
  );
}
