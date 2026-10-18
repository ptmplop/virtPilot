import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, Server, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  OS_LOGOS,
  findLogo,
  isDarkHex,
  type OsLogo,
  type OsLogoCategory,
} from '@/lib/osLogos';
import { cn } from '@/lib/cn';

// ─── Inline SVG from simple-icons path data ───────────────────────────────

interface OsIconProps {
  path: string;
  hex: string;
  size: number;
  // When true, render the icon in `currentColor` instead of the brand colour.
  // Used for very dark brand colours that vanish against the tinted tile.
  useCurrentColor?: boolean;
}

function OsIcon({ path, hex, size, useCurrentColor = false }: OsIconProps) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      fill={useCurrentColor ? 'currentColor' : `#${hex}`}
    >
      <path d={path} />
    </svg>
  );
}

// In the picker, where recognising a distro is the point, a logo keeps its brand colour
// (or the text colour, for brands too dark to read on a dark theme) — on no tile.
function LogoTile({ logo, size }: { logo: OsLogo; size: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center text-foreground" style={{ width: size, height: size }}>
      <OsIcon path={logo.path} hex={logo.hex} size={Math.round(size * 0.8)} useCurrentColor={isDarkHex(logo.hex)} />
    </span>
  );
}

// ─── Logo picker dropdown ─────────────────────────────────────────────────

interface OsLogoPickerProps {
  value: string | null;
  onChange: (slug: string | null) => void;
  /** The mark the file name implies, shown when nothing is picked — so the picker names
      what the list will actually show ("Automatic · Alpine Linux"), not "None". */
  automatic?: string;
}

export function OsLogoPicker({ value, onChange, automatic }: OsLogoPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = value ? findLogo(value) : null;
  const implied = automatic ? findLogo(automatic) : undefined;
  const noneLabel = implied ? `Automatic · ${implied.name}` : 'None';

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery('');
      // Focus the search box when the panel opens
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [open]);

  const select = (slug: string | null) => {
    onChange(slug);
    setOpen(false);
  };

  // Filtered + grouped view
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? OS_LOGOS.filter((l) => l.name.toLowerCase().includes(q) || l.slug.toLowerCase().includes(q))
      : OS_LOGOS;
    const buckets = new Map<OsLogoCategory, OsLogo[]>();
    for (const logo of matches) {
      const bucket = buckets.get(logo.category) ?? [];
      bucket.push(logo);
      buckets.set(logo.category, bucket);
    }
    return CATEGORY_ORDER.flatMap((cat) => {
      const items = buckets.get(cat);
      if (!items || items.length === 0) return [];
      return [{ category: cat, items }];
    });
  }, [query]);

  const totalMatches = grouped.reduce((acc, g) => acc + g.items.length, 0);

  return (
    <div ref={ref} className="relative">
      {/* The same label and 36px field as every other form control. */}
      <p className="mb-1.5 text-[13px] font-semibold text-foreground">OS logo <span className="font-normal text-muted-foreground">(optional)</span></p>

      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          'flex h-9 w-full items-center gap-2.5 rounded-md border bg-field px-3 text-[13.5px] transition-[border-color,box-shadow] duration-150',
          'focus:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20',
          open ? 'border-ring ring-[3px] ring-ring/20' : 'border-input hover:border-muted-foreground/40'
        )}
      >
        {selected ? (
          <>
            <LogoTile logo={selected} size={18} />
            <span className="text-foreground">{selected.name}</span>
          </>
        ) : implied ? (
          <>
            <LogoTile logo={implied} size={18} />
            <span className="text-muted-foreground">Automatic · <span className="text-foreground">{implied.name}</span></span>
          </>
        ) : (
          <>
            <Server size={15} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
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
        // Escape closes this popup and returns to its field — it must not reach the
        // dialog the picker sits in, which would close and clear the whole form.
        <div
          role="dialog"
          aria-label="Choose an OS logo"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            triggerRef.current?.focus();
          }}
          className="absolute left-0 top-full z-50 mt-1.5 w-full overflow-hidden rounded-lg border border-border bg-card shadow-pop"
        >
          {/* Search */}
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                className={cn(
                  'w-full rounded-md border border-border bg-background py-1.5 pl-7 pr-7 text-xs',
                  'placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20'
                )}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          </div>

          {/* Scrollable body */}
          <div className="max-h-80 overflow-y-auto p-2">
            {/* None option (always visible, ignores search) */}
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
              {implied ? <LogoTile logo={implied} size={18} /> : <Server size={15} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />}
              {noneLabel}
            </button>

            <div className="mb-1 h-px bg-border" />

            {totalMatches === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                No logos match "{query}"
              </div>
            ) : (
              grouped.map(({ category, items }) => (
                <div key={category} className="pt-1.5 first:pt-1">
                  <div className="mb-1 px-1 text-[12px] font-medium text-muted-foreground">
                    {CATEGORY_LABELS[category]}
                  </div>
                  <div className="grid grid-cols-5 gap-1">
                    {items.map((logo) => {
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
                          <LogoTile logo={logo} size={28} />
                          <span className="line-clamp-2 text-center text-[10.5px] leading-tight text-muted-foreground">
                            {logo.name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
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
  // Everywhere else an OS logo is a one-colour mark in the muted text colour: no tinted
  // tile, and no brand red or green beside status colours that mean failed or running.
  return (
    <span
      className="flex shrink-0 items-center justify-center text-muted-foreground"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {logo
        ? <OsIcon path={logo.path} hex={logo.hex} size={Math.round(size * 0.8)} useCurrentColor />
        : <FallbackIcon size={Math.round(size * 0.8)} strokeWidth={1.75} />}
    </span>
  );
}
