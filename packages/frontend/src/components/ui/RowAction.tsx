import type { ReactNode } from 'react';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/cn';

// A row action: a quiet icon button that names itself twice — aria-label for assistive
// tech, a tooltip for the pointer. `tooltip` may differ from the label (e.g. to say why
// the action is unavailable); the label always says what the button does.
export function RowAction({
  label, tooltip, onClick, disabled, danger, children,
}: {
  label: string;
  tooltip?: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip label={tooltip ?? label}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={cn(
          'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground',
          danger ? 'hover:bg-destructive/10 hover:text-destructive' : 'hover:bg-muted hover:text-foreground',
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}
