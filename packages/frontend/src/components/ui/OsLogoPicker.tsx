import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Server } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { OS_LOGOS, findLogo } from '@/lib/osLogos';
import { cn } from '@/lib/cn';

// ─── Inline SVG from simple-icons path data ───────────────────────────────

function OsIcon({ path, hex, size }: { path: string; hex: string; size: number }) {
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      fill={`#${hex}`}
    >
      <path d={path} />
    </svg>
  );
}

// ─── Logo picker dropdown ─────────────────────────────────────────────────

interface OsLogoPickerProps {
  value: string | null;
  onChange: (slug: string | null) => void;
}

export function OsLogoPicker({ value, onChange }: OsLogoPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = value ? findLogo(value) : null;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const select = (slug: string | null) => {
    onChange(slug);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">OS Logo (optional)</p>

      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg border bg-card px-3 py-2 text-sm transition-all',
          'hover:border-border/80 focus:outline-none focus:ring-2 focus:ring-ring',
          open ? 'border-primary ring-2 ring-primary/20' : 'border-border'
        )}
      >
        {selected ? (
          <>
            <div
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
              style={{ background: `#${selected.hex}1e` }}
            >
              <OsIcon path={selected.path} hex={selected.hex} size={12} />
            </div>
            <span className="text-foreground">{selected.name}</span>
          </>
        ) : (
          <>
            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted">
              <Server size={11} className="text-muted-foreground" />
            </div>
            <span className="text-muted-foreground">None</span>
          </>
        )}
        <ChevronDown
          size={14}
          className={cn('ml-auto shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1.5 w-full overflow-hidden rounded-xl border border-border bg-card shadow-lg shadow-black/20">
          <div className="p-2">
            {/* None option */}
            <button
              type="button"
              onClick={() => select(null)}
              className={cn(
                'mb-1.5 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
                value === null
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted">
                <Server size={11} className="text-muted-foreground" />
              </div>
              None
            </button>

            <div className="mb-1 h-px bg-border" />

            {/* Logo grid */}
            <div className="grid grid-cols-5 gap-1 pt-1">
              {OS_LOGOS.map((logo) => {
                const isSelected = value === logo.slug;
                return (
                  <button
                    key={logo.slug}
                    type="button"
                    onClick={() => select(logo.slug)}
                    title={logo.name}
                    className={cn(
                      'flex flex-col items-center gap-1 rounded-lg border p-2 transition-all',
                      isSelected
                        ? 'border-primary bg-primary/10 ring-1 ring-primary/20'
                        : 'border-transparent hover:border-border hover:bg-muted/60'
                    )}
                  >
                    <div
                      className="flex h-7 w-7 items-center justify-center rounded-md"
                      style={{ background: `#${logo.hex}1e` }}
                    >
                      <OsIcon path={logo.path} hex={logo.hex} size={16} />
                    </div>
                    <span className="text-center text-[9px] leading-tight text-muted-foreground">
                      {logo.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Small inline logo for VM list ───────────────────────────────────────

interface VmLogoProps {
  slug: string | undefined;
  size?: number;
  fallbackIcon?: LucideIcon;
}

export function VmLogo({ slug, size = 20, fallbackIcon: FallbackIcon = Server }: VmLogoProps) {
  const logo = slug ? findLogo(slug) : undefined;

  const containerStyle = {
    width: size,
    height: size,
    background: logo ? `#${logo.hex}1e` : undefined,
  };

  if (!logo) {
    return (
      <div
        className="flex shrink-0 items-center justify-center rounded-md bg-muted"
        style={containerStyle}
      >
        <FallbackIcon size={size * 0.55} className="text-muted-foreground/50" />
      </div>
    );
  }

  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-md"
      style={containerStyle}
    >
      <OsIcon path={logo.path} hex={logo.hex} size={size * 0.65} />
    </div>
  );
}
