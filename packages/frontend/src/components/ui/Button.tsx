import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerOutline';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variantClasses: Record<Variant, string> = {
  primary:
    'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50 disabled:shadow-none',
  secondary:
    'border border-input bg-card text-foreground shadow-card hover:border-muted-foreground/30 hover:bg-surface disabled:opacity-50',
  ghost:
    'text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50',
  // Solid red is reserved for confirming a destructive act (the button in the dialog).
  danger:
    'bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50',
  // A destructive act offered among ordinary ones (e.g. Force Off in the VM header).
  dangerOutline:
    'border border-input bg-card text-destructive shadow-card hover:border-destructive/40 hover:bg-destructive/[0.06] disabled:opacity-50',
};

const sizeClasses: Record<Size, string> = {
  sm: 'h-8 px-3 text-[12.5px]',
  md: 'h-9 px-4 text-[13.5px]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className, type = 'button', ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium',
        'transition-colors duration-150 disabled:cursor-not-allowed',
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
