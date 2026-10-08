/** @type {import('tailwindcss').Config} */
const palette = require('./tailwind.palette.cjs');
const { _util, ...scales } = palette;

module.exports = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Bundled with the app (no font CDN: installs are often air-gapped).
        sans: ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        ...scales,
        canvas: 'hsl(var(--canvas))',
        surface: 'hsl(var(--surface))',
        'sheet-border': 'hsl(var(--sheet-border))',
        'gauge-track': 'hsl(var(--gauge-track))',
        action: {
          DEFAULT: 'hsl(var(--action))',
          hover: 'hsl(var(--action-hover))',
          foreground: 'hsl(var(--action-foreground))',
        },
        field: 'hsl(var(--field))',
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
      },
      borderRadius: {
        // Instruments, not cushions: 8px panels, 6px controls. The old 12px card
        // corner (rounded-xl) is folded onto the panel radius so nothing looks pillowy.
        xl: 'var(--radius)',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      boxShadow: {
        // The glows are retired: kept as names so old call sites resolve to nothing loud.
        'glow-primary': '0 0 0 0 transparent',
        'glow-emerald': '0 0 0 0 transparent',
        'card': 'var(--shadow-card)',
        'sheet': 'var(--shadow-sheet)',
        'nav': 'var(--nav-active-shadow)',
        'card-hover': 'var(--shadow-pop)',
        'pop': 'var(--shadow-pop)',
        'inner-border': 'inset 0 0 0 1px hsl(var(--border))',
      },
      animation: {
        'fade-in': 'fade-in 0.15s ease-out',
        'slide-up': 'slide-up 0.2s cubic-bezier(0.2, 0, 0, 1)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
