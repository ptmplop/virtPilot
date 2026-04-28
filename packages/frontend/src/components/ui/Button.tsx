import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variantClasses: Record<Variant, string> = {
  primary:
    'bg-primary text-primary-foreground hover:bg-primary/90 hover:shadow-glow-primary active:scale-95 disabled:opacity-50 disabled:shadow-none',
  secondary:
    'border border-input bg-background text-foreground hover:bg-muted active:scale-95 disabled:opacity-50',
  ghost:
    'text-muted-foreground hover:bg-muted hover:text-foreground active:scale-95',
  danger:
    'bg-destructive text-destructive-foreground hover:bg-destructive/90 active:scale-95 disabled:opacity-50',
};

const sizeClasses: Record<Size, string> = {
  sm: 'px-2.5 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className, type = 'button', ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium',
        'transition-all duration-150 disabled:cursor-not-allowed',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        variantClasses[variant],
        sizeClasses[size],
        className
      )}
      {...rest}
    />
  )
);
Button.displayName = 'Button';
