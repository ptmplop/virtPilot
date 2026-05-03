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
      role="img"
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

// Tile background + icon colour for a logo, chosen so the icon is always
// readable on both light and dark themes. For brand colours below a luminance
// threshold (pfSense, MikroTik, SUSE, …) we ignore the brand hex for the
// background and render the icon in the foreground colour instead.
function tileStyle(logo: OsLogo): { bgClass: string; bgStyle?: React.CSSProperties; useCurrentColor: boolean } {
  if (isDarkHex(logo.hex)) {
    return { bgClass: 'bg-foreground/10 text-foreground', useCurrentColor: true };
  }
  return {
    bgClass: '',
    bgStyle: { background: `#${logo.hex}1e` },
    useCurrentColor: false,
  };
}

function LogoTile({ logo, size }: { logo: OsLogo; size: number }) {
  const { bgClass, bgStyle, useCurrentColor } = tileStyle(logo);
  return (
    <div
      className={cn('flex shrink-0 items-center justify-center rounded-md', bgClass)}
      style={{ width: size, height: size, ...bgStyle }}
    >
      <OsIcon path={logo.path} hex={logo.hex} size={size * 0.65} useCurrentColor={useCurrentColor} />
    </div>
  );
}

// ─── Logo picker dropdown ─────────────────────────────────────────────────

interface OsLogoPickerProps {
  value: string | null;
  onChange: (slug: string | null) => void;
}

export function OsLogoPicker({ value, onChange }: OsLogoPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = value ? findLogo(value) : null;

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
            <LogoTile logo={selected} size={20} />
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
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted">
                <Server size={11} className="text-muted-foreground" />
              </div>
              None
            </button>

            <div className="mb-1 h-px bg-border" />

            {totalMatches === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                No logos match "{query}"
              </div>
            ) : (
              grouped.map(({ category, items }) => (
                <div key={category} className="pt-1.5 first:pt-1">
                  <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
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
                          <span className="line-clamp-2 text-center text-[9px] leading-tight text-muted-foreground">
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

  if (!logo) {
    return (
      <div
        className="flex shrink-0 items-center justify-center rounded-md bg-muted"
        style={{ width: size, height: size }}
      >
        <FallbackIcon size={size * 0.55} className="text-muted-foreground/50" />
      </div>
    );
  }

  return <LogoTile logo={logo} size={size} />;
}
