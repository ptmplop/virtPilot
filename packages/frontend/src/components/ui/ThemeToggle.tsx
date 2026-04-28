import { Moon, Sun } from 'lucide-react';
import { useThemeStore } from '@/store/themeStore';
import { cn } from '@/lib/cn';

export function ThemeToggle() {
  const { theme, toggle } = useThemeStore();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle theme"
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors',
        'hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
    >
      {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}
