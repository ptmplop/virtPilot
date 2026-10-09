import { Children, cloneElement, isValidElement, useState, useRef, useEffect, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

interface TooltipProps {
  label: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  children: ReactNode;
  /** A keyboard shortcut shown after the label, quieter than it. */
  shortcut?: string;
  /** Keeps the wrapper (so layout and focus never change) but shows nothing. */
  disabled?: boolean;
  /** Classes for the wrapper, e.g. to let a full-width child stay full width. */
  className?: string;
}

// True when a subtree renders any text of its own (so it already has a visible name).
function hasText(node: ReactNode): boolean {
  let found = false;
  Children.forEach(node, (c) => {
    if (found) return;
    if (typeof c === 'string' || typeof c === 'number') found = String(c).trim().length > 0;
    else if (isValidElement<{ children?: ReactNode }>(c)) found = hasText(c.props.children);
  });
  return found;
}

// An icon-only button or link wrapped in a tooltip is named by the tooltip: the label a
// sighted user sees on hover is the one a screen reader announces. Children that
// already carry text or an aria-label are left alone.
function withName(child: ReactNode, label: string): ReactNode {
  if (!isValidElement<{ children?: ReactNode; 'aria-label'?: string }>(child)) return child;
  if (typeof child.type !== 'string' || !['button', 'a'].includes(child.type)) return child;
  if (child.props['aria-label'] || hasText(child.props.children)) return child;
  return cloneElement(child as ReactElement<{ 'aria-label'?: string }>, { 'aria-label': label });
}

export function Tooltip({ label, side = 'top', children, shortcut, disabled, className }: TooltipProps) {
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
      // A disabled control fires no mouse events, so it lets them through to this
      // wrapper — otherwise the hint that explains *why* it is disabled never shows.
      className={cn('relative inline-flex [&>:disabled]:pointer-events-none', className)}
      onMouseEnter={() => !disabled && setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocusCapture={() => !disabled && setVisible(true)}
      onBlurCapture={() => setVisible(false)}
    >
      {Children.count(children) === 1 && !disabled ? withName(children, label) : children}
      {visible && !disabled &&
        createPortal(
          <span
            style={{ top: coords.top, left: coords.left, transform: transformMap[side] }}
            className={cn(
              'pointer-events-none fixed z-[9999] max-w-[20rem] animate-fade-in rounded-md',
              label.length > 48 ? 'w-max whitespace-normal leading-snug' : 'whitespace-nowrap',
              'bg-[#1B2433] px-2 py-1 text-[12px] font-medium text-[#F1F3F6] shadow-pop dark:bg-[#E6EAF0] dark:text-[#1B2433]'
            )}
          >
            {label}
            {shortcut && (
              <kbd className="ml-2 font-mono text-[11px] font-medium text-[#A9B2BF] dark:text-[#5D6779]">{shortcut}</kbd>
            )}
          </span>,
          document.body
        )}
    </span>
  );
}
