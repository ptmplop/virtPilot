import { useState, type ReactElement, cloneElement } from 'react';
import { cn } from '@/lib/cn';

interface TooltipProps {
  label: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  children: ReactElement<{ onMouseEnter?: () => void; onMouseLeave?: () => void }>;
}

const positionClasses: Record<NonNullable<TooltipProps['side']>, string> = {
  top:    'bottom-full left-1/2 mb-1.5 -translate-x-1/2',
  bottom: 'top-full left-1/2 mt-1.5 -translate-x-1/2',
  right:  'left-full top-1/2 ml-1.5 -translate-y-1/2',
  left:   'right-full top-1/2 mr-1.5 -translate-y-1/2',
};

export function Tooltip({ label, side = 'top', children }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="relative inline-flex">
      {cloneElement(children, {
        onMouseEnter: () => setVisible(true),
        onMouseLeave: () => setVisible(false),
      })}
      {visible && (
        <span
          className={cn(
            'pointer-events-none absolute z-50 animate-fade-in whitespace-nowrap rounded-md',
            'bg-foreground px-2 py-1 text-[11px] font-medium text-background shadow-md',
            positionClasses[side]
          )}
        >
          {label}
        </span>
      )}
    </span>
  );
}
