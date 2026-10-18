import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Why the footer's confirm is disabled, said beside it (as the wizard's Continue does). */
  note?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const sizeClasses = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' };

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

// Open dialogs, innermost last: only the top one answers Escape and Tab, and the page
// scrolls again only when the last one closes.
const openStack: string[] = [];

export function Dialog({ open, onClose, title, description, children, footer, note, size = 'md' }: DialogProps) {
  // Unique per instance: a fixed id made nested/stacked dialogs label each other.
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // A modal dialog holds the keyboard: focus moves in when it opens — to its first text
  // field, so a form can be typed into at once, or else to the panel itself, so Enter
  // can never confirm a destructive act by accident — Tab stays inside, and closing
  // returns focus to whatever opened it.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      const field = panel.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not(:disabled), textarea:not(:disabled)',
      );
      (field ?? panel).focus();
    }
    openStack.push(titleId);
    const isTop = () => openStack[openStack.length - 1] === titleId;

    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === 'Escape') { closeRef.current(); return; }
      if (e.key !== 'Tab' || !panel) return;
      const stops = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!stops.length) { e.preventDefault(); return; }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active) || (e.shiftKey && (active === first || active === panel))) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = openStack.lastIndexOf(titleId);
      if (i >= 0) openStack.splice(i, 1);
      if (openStack.length === 0) document.body.style.overflow = '';
      if (opener?.isConnected) opener.focus();
    };
  }, [open, titleId]);

  if (!open) return null;

  // Portalled to <body>: no ancestor's transform or overflow can box the overlay in.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-16 animate-fade-in"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="fixed inset-0 bg-[#1B2433]/40 dark:bg-black/70" />

      {/* Panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          'relative w-full rounded-[10px] border border-border bg-card outline-none animate-slide-up',
          'shadow-pop',
          sizeClasses[size]
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 pb-1 pt-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[16px] font-semibold leading-6 tracking-[-0.01em] text-foreground">
              {title}
            </h2>
            {description && (
              <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{description}</p>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mr-2 -mt-0.5 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 pb-5 pt-4">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 rounded-b-[10px] border-t border-border bg-surface px-6 py-3.5">
            {note && (
              <p className="mr-auto min-w-0 basis-full truncate text-[12.5px] text-muted-foreground sm:basis-auto">{note}</p>
            )}
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
