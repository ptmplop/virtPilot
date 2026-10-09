import { Search } from 'lucide-react';
import { cn } from '@/lib/cn';

// The one search field: a magnifier in the field, the shared field style, and Escape
// clears what was typed (a second Escape leaves the field).
export function SearchInput({
  value, onChange, placeholder, label, className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Accessible name; the placeholder alone is not one. */
  label: string;
  className?: string;
}) {
  return (
    <div className={cn('relative w-full', className)}>
      <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange('');
          }
        }}
        className="h-9 w-full rounded-md border border-input bg-field pl-9 pr-3 text-[13.5px] text-foreground transition-[border-color,box-shadow] duration-150 hover:border-muted-foreground/40 focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/20 [&::-webkit-search-cancel-button]:hidden"
      />
    </div>
  );
}
