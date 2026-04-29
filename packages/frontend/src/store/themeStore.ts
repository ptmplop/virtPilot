import { create } from 'zustand';

type Theme = 'dark' | 'light';

interface ThemeStore {
  theme: Theme;
  toggle: () => void;
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
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
