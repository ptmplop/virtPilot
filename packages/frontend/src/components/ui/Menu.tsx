import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { Tooltip } from '@/components/ui/Tooltip';

export interface MenuItem {
  label: string;
  /** Quiet words after the label: how the command acts ("ACPI", "immediate"). */
  hint?: string;
  icon?: ReactNode;
  onSelect: () => void;
  /** Destructive commands are red, as on the buttons they stand in for. */
  danger?: boolean;
  disabled?: boolean;
  /** Draw a rule above this item, to set a group of commands apart. */
  separated?: boolean;
}

// A small command menu behind one icon button — a row's power actions, say. It is drawn
// in a portal, so a panel's rounded clipping can't cut it, and flips above its button
// when there is no room below. Keyboard as in any menu: Enter, Space or ↓ opens it on
// the first command, ↑/↓ move, Home/End jump, Escape closes it and returns to the
// button, Tab closes it and moves on. Scrolling or resizing closes it rather than
// leaving it floating away from its row.
export function Menu({
  label, tooltip, icon, items, buttonClassName, disabled,
}: {
  /** The button's accessible name. */
  label: string;
  /** Its hover hint. Owned here, not wrapped around <Menu> by the caller: React counts a
      portal as inside its parent, so focus moving into the open menu would re-show a
      tooltip wrapped around the whole component. */
  tooltip?: string;
  icon: ReactNode;
  items: MenuItem[];
  buttonClassName?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const itemEls = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);

  const close = (refocus: boolean) => {
    setOpen(false);
    setPos(null);
    if (refocus) buttonRef.current?.focus();
  };

  // Place it under the button's right edge (above, if it would run off the bottom),
  // measured once it exists so its real size is known; then move focus into it.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !listRef.current) return;
    const b = buttonRef.current.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = listRef.current;
    const below = b.bottom + 6;
    const top = below + h > window.innerHeight - 8 && b.top - 6 - h >= 8 ? b.top - 6 - h : below;
    const left = Math.min(Math.max(8, b.right - w), window.innerWidth - w - 8);
    setPos({ top, left });
  }, [open]);

  useEffect(() => {
    if (open && pos) itemEls()[0]?.focus();
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (listRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      close(false);
    };
    const onViewportChange = () => close(false);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange);
    };
  }, [open]);

  const onListKey = (e: React.KeyboardEvent) => {
    const els = itemEls();
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === 'ArrowDown' ? (i + 1) % els.length
      : e.key === 'ArrowUp' ? (i - 1 + els.length) % els.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? els.length - 1
      : null;
    if (to !== null) { e.preventDefault(); els[to]?.focus(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
    // Tab leaves from the button, so focus moves on to whatever follows it on the page.
    if (e.key === 'Tab') close(true);
  };

  const button = (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      disabled={disabled}
      onClick={() => (open ? close(false) : setOpen(true))}
      onKeyDown={(e) => {
        if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setOpen(true); }
      }}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40',
        open && 'bg-muted text-foreground',
        buttonClassName,
      )}
    >
      {icon}
    </button>
  );

  return (
    <>
      {tooltip ? <Tooltip label={tooltip}>{button}</Tooltip> : button}
      {open && createPortal(
        <div
          ref={listRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onListKey}
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          className="fixed z-[60] min-w-[12.5rem] animate-fade-in rounded-lg border border-border bg-card py-1 shadow-pop"
        >
          {items.map((item) => (
            <Fragment key={item.label}>
              {item.separated && <div role="separator" className="my-1 h-px bg-border" />}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                onClick={() => { close(true); item.onSelect(); }}
                className={cn(
                  'flex h-9 w-full items-center gap-2.5 px-3 text-left text-[13px] transition-colors',
                  'hover:bg-muted focus-visible:bg-muted focus-visible:outline-offset-[-2px] disabled:opacity-45',
                  item.danger ? 'text-destructive' : 'text-foreground',
                )}
              >
                {item.icon && (
                  <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center', item.danger ? 'text-destructive' : 'text-muted-foreground')}>
                    {item.icon}
                  </span>
                )}
                <span className="flex-1">{item.label}</span>
                {item.hint && <span className="text-[12px] text-muted-foreground">{item.hint}</span>}
              </button>
            </Fragment>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
