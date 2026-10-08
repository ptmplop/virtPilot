import { create } from 'zustand';

type Theme = 'dark' | 'light';

interface ThemeStore {
  theme: Theme;
  toggle: () => void;
}

// The browser chrome (mobile address bar, PWA title bar) follows the canvas colour.
const CANVAS = { light: '#EFF1F4', dark: '#090C10' } as const;

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = CANVAS[theme];
    meta.removeAttribute('media');
  }
}

const stored = (localStorage.getItem('virtpilotTheme') as Theme | null) ?? 'light';
applyTheme(stored);

export const useThemeStore = create<ThemeStore>((set) => ({
  theme: stored,
  toggle: () =>
    set((s) => {
      const next: Theme = s.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('virtpilotTheme', next);
      applyTheme(next);
      return { theme: next };
    }),
}));
