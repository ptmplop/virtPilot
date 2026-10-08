import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerOutline';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

// The primary action is ink — the wordmark's colour — and frost in dark mode.
// Steel is kept for what the eye should follow: focus, selection, data.
const variantClasses: Record<Variant, string> = {
  primary:
    'bg-action text-action-foreground shadow-[0_1px_0_0_rgb(0_0_0/0.08)] hover:bg-action-hover disabled:opacity-45',
  secondary:
    'border border-input bg-card text-foreground shadow-[0_1px_0_0_rgb(27_36_51/0.04)] hover:border-muted-foreground/35 hover:bg-surface disabled:opacity-50',
  ghost:
    'text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50',
  // Solid red is reserved for confirming a destructive act (the button in the dialog).
  danger:
    'bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50',
  // A destructive act offered among ordinary ones (e.g. Force Off in the VM header).
  dangerOutline:
    'border border-input bg-card text-destructive hover:border-destructive/45 hover:bg-destructive/[0.06] disabled:opacity-50',
};

const sizeClasses: Record<Size, string> = {
  sm: 'h-8 px-3 text-[12.5px]',
  md: 'h-9 px-3.5 text-[13.5px]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className, type = 'button', ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium',
        'transition-[background-color,border-color,color] duration-150 disabled:cursor-not-allowed',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        variantClasses[variant],
        sizeClasses[size],
        className
      )}
      {...rest}
    />
  )
);
Button.displayName = 'Button';
