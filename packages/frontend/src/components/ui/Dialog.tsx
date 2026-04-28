import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const sizeClasses = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' };

export function Dialog({ open, onClose, title, description, children, footer, size = 'md' }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-16 animate-fade-in"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="fixed inset-0 bg-background/75 backdrop-blur-sm" />

      {/* Panel */}
      <div
        className={cn(
          'relative w-full rounded-xl border border-border bg-card animate-slide-up',
          'shadow-[0_24px_64px_rgba(0,0,0,0.35),0_4px_16px_rgba(0,0,0,0.2)]',
          sizeClasses[size]
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-border px-6 py-4">
          <div>
            <h2 id="dialog-title" className="text-base font-semibold text-foreground">
              {title}
            </h2>
            {description && (
              <p className="mt-1 text-xs text-muted-foreground">{description}</p>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-all hover:bg-muted hover:text-foreground active:scale-95"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="flex items-center justify-end gap-2 rounded-b-xl border-t border-border bg-[hsl(var(--surface))] px-6 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
